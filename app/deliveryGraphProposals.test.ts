// Unit coverage for the `staged` delivery-graph proposal aggregate (app/deliveryGraphProposals.ts,
// ADR 0005 Decision 7, issue #460). Two layers: the PURE helpers (logical key, TTL horizon, expiry,
// review-url, row builder) tested in isolation, and the I/O (`stageProposal` supersede-by-logical-key
// + idempotent re-stage; `getStagedProposal` staged-and-live gate; `markProposalDispatched`) exercised
// against the REAL provisioned SQLite data layer so the raw supersede UPDATE is validated, not modelled.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import {
  buildProposalRow,
  DELIVERY_PROPOSAL_TTL_MS,
  deliveryGraphProposals,
  getStagedProposal,
  isProposalExpired,
  markProposalDispatched,
  proposalExpiry,
  proposalLogicalKey,
  proposalReviewUrl,
  stageProposal,
  sweepExpiredProposals,
} from "./deliveryGraphProposals.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dgprop-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const row = (over: Partial<Parameters<typeof buildProposalRow>[0]> = {}) =>
  buildProposalRow({
    digest: "d1",
    logicalKey: "runbook",
    title: "runbook",
    graphJson: JSON.stringify({ name: "runbook", nodes: [] }),
    preview: { diagram: "flowchart", sideEffects: [], humanNodes: [] },
    nodeCount: 1,
    humanNodeCount: 0,
    sideEffectCount: 0,
    sideEffecting: false,
    ...over,
  });

// ── pure helpers ──────────────────────────────────────────────────────────────
test("proposalLogicalKey: a non-blank name wins; a blank/absent name falls back to the digest", () => {
  assertEquals(proposalLogicalKey("runbook", "dX"), "runbook");
  assertEquals(proposalLogicalKey("  runbook  ", "dX"), "runbook");
  assertEquals(proposalLogicalKey("", "dX"), "dX");
  assertEquals(proposalLogicalKey("   ", "dX"), "dX");
  assertEquals(proposalLogicalKey(null, "dX"), "dX");
  assertEquals(proposalLogicalKey(undefined, "dX"), "dX");
});

test("proposalExpiry: is createdAt + TTL; a corrupt createdAt anchors to now", () => {
  const created = "2024-01-01T00:00:00.000Z";
  assertEquals(proposalExpiry(created), new Date(Date.parse(created) + DELIVERY_PROPOSAL_TTL_MS).toISOString());
  const now = Date.now();
  const fallback = Date.parse(proposalExpiry("not-a-date"));
  assert(Math.abs(fallback - (now + DELIVERY_PROPOSAL_TTL_MS)) < 5000);
});

test("isProposalExpired: past → true, future → false, blank/corrupt → true (fail-closed)", () => {
  const at = new Date("2024-06-01T00:00:00.000Z");
  assertEquals(isProposalExpired("2024-05-31T23:59:59.000Z", at), true);
  assertEquals(isProposalExpired("2024-06-01T00:00:01.000Z", at), false);
  assertEquals(isProposalExpired(at.toISOString(), at), true); // at the horizon = expired
  assertEquals(isProposalExpired(null, at), true);
  assertEquals(isProposalExpired("", at), true);
  assertEquals(isProposalExpired("garbage", at), true);
});

test("proposalReviewUrl: a navigational deep-link to the cockpit page — NOT a dispatch endpoint", () => {
  const url = proposalReviewUrl("abc123", "https://cockpit.example");
  assertEquals(url, "https://cockpit.example/app/pages/delivery-graphs#proposal-abc123");
  assert(!/\/actions\//.test(url), "reviewUrl points at a page, never an API action");
});

test("buildProposalRow: stamps status staged, boolean→0/1, and TTL from createdAt", () => {
  const r = row({ sideEffecting: true, createdAt: "2024-01-01T00:00:00.000Z" });
  assertEquals(r.status, "staged");
  assertEquals(r.side_effecting, 1);
  assertEquals(r.created_at, "2024-01-01T00:00:00.000Z");
  assertEquals(r.expires_at, proposalExpiry("2024-01-01T00:00:00.000Z"));
});

// ── I/O: stage / supersede / get / dispatch ────────────────────────────────────
test("stageProposal: stages a proposal that getStagedProposal then returns as live", async () => {
  await withData(async (data) => {
    await stageProposal(data, row());
    const live = await getStagedProposal(data, "d1");
    assert(live);
    assertEquals(live?.status, "staged");
  });
});

test("stageProposal: a re-stage of an identical, STILL-LIVE digest is idempotent — one row, created_at (TTL anchor) preserved", async () => {
  await withData(async (data) => {
    const firstStage = new Date().toISOString(); // live: expires_at is in the future
    await stageProposal(data, row({ createdAt: firstStage }));
    await stageProposal(data, row({ createdAt: "2030-01-01T00:00:00.000Z" })); // a later re-stage
    const rows = await deliveryGraphProposals(data).all();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].created_at, firstStage); // first (live) stage wins the TTL anchor
  });
});

test("stageProposal: a re-stage of an EXPIRED digest RE-ANCHORS the TTL so it is dispatchable again", async () => {
  await withData(async (data) => {
    // First stage long ago so its TTL has already elapsed (expires_at is in the past).
    await stageProposal(data, row({ createdAt: "2024-01-01T00:00:00.000Z" }));
    assertEquals(await getStagedProposal(data, "d1"), null); // aged out — not dispatchable

    await stageProposal(data, row({ createdAt: "2030-01-01T00:00:00.000Z" })); // re-propose the same bytes
    const rows = await deliveryGraphProposals(data).all();
    assertEquals(rows.length, 1);
    // The stale created_at must NOT be reused (that would keep expires_at in the past); the re-stage
    // re-anchors the TTL to now, so the re-proposed digest is genuinely live and dispatchable again.
    assert(!isProposalExpired(rows[0].expires_at), "re-staged expired proposal must have a future TTL");
    const live = await getStagedProposal(data, "d1");
    assert(live, "a re-staged (previously expired) proposal is dispatchable again");
    assertEquals(live?.status, "staged");
  });
});

test("stageProposal: a new digest for the SAME logical key supersedes the prior staged proposal", async () => {
  await withData(async (data) => {
    await stageProposal(data, row({ digest: "d1" }));
    await stageProposal(data, row({ digest: "d2" })); // same logical_key "runbook", new digest
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "superseded");
    assertEquals((await deliveryGraphProposals(data).get("d2"))?.status, "staged");
    // The superseded digest is no longer live/dispatchable.
    assertEquals(await getStagedProposal(data, "d1"), null);
    assert(await getStagedProposal(data, "d2"));
  });
});

test("stageProposal: proposals with DIFFERENT logical keys coexist — supersede is scoped per logical graph", async () => {
  await withData(async (data) => {
    await stageProposal(data, row({ digest: "d1", logicalKey: "runbook-a" }));
    await stageProposal(data, row({ digest: "d2", logicalKey: "runbook-b" }));
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "staged");
    assertEquals((await deliveryGraphProposals(data).get("d2"))?.status, "staged");
  });
});

test("stageProposal: an older concurrent stage does NOT clobber a NEWER staged proposal for the same logical key (ordered supersede — never zero live)", async () => {
  await withData(async (data) => {
    const table = deliveryGraphProposals(data);
    // A NEWER stage (d2) has already committed its row for logical_key "runbook" — the winner of a
    // concurrent double-stage, with a later `updated_at`. Its TTL is live (createdAt defaults to now).
    const newer = row({ digest: "d2" });
    newer.updated_at = "2999-01-01T00:00:00.000Z";
    await table.insert(newer);
    // Now the OLDER racer (d1) runs its supersede pass. It must supersede only rows OLDER than itself —
    // NOT the newer d2. An unordered supersede-all would flip d2 too, leaving ZERO live proposals for
    // the logical key (both superseded), so the cockpit would show nothing to dispatch.
    await stageProposal(data, row({ digest: "d1" }));
    assertEquals((await table.get("d2"))?.status, "staged", "the newer proposal must survive the older stage's supersede");
    // At least one live proposal always remains for the logical key — never zero.
    const stillStaged = (await table.all()).filter((r) => r.status === "staged");
    assert(stillStaged.some((r) => r.digest === "d2"), "the globally-newest stage survives every racing supersede");
  });
});

test("getStagedProposal: an EXPIRED staged proposal is not live", async () => {
  await withData(async (data) => {
    await stageProposal(data, row());
    const past = new Date(Date.now() - 1000);
    // Query from a time AFTER its TTL horizon.
    const future = new Date(Date.now() + DELIVERY_PROPOSAL_TTL_MS + 1000);
    assert(await getStagedProposal(data, "d1", past));
    assertEquals(await getStagedProposal(data, "d1", future), null);
  });
});

test("markProposalDispatched: a dispatched proposal is no longer live", async () => {
  await withData(async (data) => {
    await stageProposal(data, row());
    await markProposalDispatched(data, "d1");
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dispatched");
    assertEquals(await getStagedProposal(data, "d1"), null);
  });
});

test("sweepExpiredProposals: flips aged-out staged proposals to `expired` so they drop out of the cockpit grid", async () => {
  await withData(async (data) => {
    // Two staged proposals with different logical keys so neither supersedes the other.
    await stageProposal(data, row({ digest: "d1", logicalKey: "a", createdAt: "2024-01-01T00:00:00.000Z" }));
    await stageProposal(data, row({ digest: "d2", logicalKey: "b" }));
    // Sweep from a time past d1's TTL horizon but before d2's.
    const at = new Date(Date.parse("2024-01-01T00:00:00.000Z") + DELIVERY_PROPOSAL_TTL_MS + 1000);
    const swept = await sweepExpiredProposals(data, at);
    assertEquals(swept, 1);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "expired");
    assertEquals((await deliveryGraphProposals(data).get("d2"))?.status, "staged");
    // Idempotent: a re-sweep at the same instant flips nothing more.
    assertEquals(await sweepExpiredProposals(data, at), 0);
  });
});

test("sweepExpiredProposals: leaves superseded/dispatched proposals untouched (only `staged` is swept)", async () => {
  await withData(async (data) => {
    await stageProposal(data, row({ digest: "d1", createdAt: "2024-01-01T00:00:00.000Z" }));
    await markProposalDispatched(data, "d1");
    const at = new Date(Date.parse("2024-01-01T00:00:00.000Z") + DELIVERY_PROPOSAL_TTL_MS + 1000);
    assertEquals(await sweepExpiredProposals(data, at), 0);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dispatched");
  });
});
