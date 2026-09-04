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
  isLiveStaged,
  isProposalExpired,
  markProposalDismissed,
  markProposalDispatched,
  markProposalExpired,
  proposalExpiry,
  proposalLogicalKey,
  proposalReviewUrl,
  stageProposal,
  sweepExpiredProposals,
} from "./deliveryGraphProposals.ts";
import { publicBaseUrl } from "./blackboard.ts";

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

test("isLiveStaged: the ONE liveness predicate — only a `staged`, not-yet-expired row is live (#608)", () => {
  const at = new Date("2024-06-01T00:00:00.000Z");
  const live = row({ createdAt: "2024-05-31T23:00:00.000Z" }); // staged, TTL a day out → live
  assertEquals(isLiveStaged(live, at), true);
  // A future-created staged row is trivially live too (TTL further out).
  assertEquals(isLiveStaged(row(), new Date()), true);
  // Every non-`staged` status is NOT live, regardless of TTL.
  for (const status of ["superseded", "dispatched", "expired", "dismissed"] as const) {
    assertEquals(isLiveStaged({ ...live, status }, at), false);
  }
  // A `staged` row whose TTL has elapsed is NOT live (mirrors isProposalExpired, fail-closed).
  assertEquals(isLiveStaged({ ...live, expires_at: "2024-05-30T00:00:00.000Z" }, at), false);
  assertEquals(isLiveStaged({ ...live, expires_at: "" }, at), false);
});

test("proposalReviewUrl: a navigational deep-link to the cockpit page — NOT a dispatch endpoint", () => {
  const url = proposalReviewUrl("abc123", "https://cockpit.example");
  assertEquals(url, "https://cockpit.example/app/pages/delivery-graphs#proposal-abc123");
  assert(!/\/actions\//.test(url), "reviewUrl points at a page, never an API action");
});

test("proposalReviewUrl: with no base falls back to publicBaseUrl() — the text-ingress (no request) path (#577)", () => {
  // The staging text-ingress path has no HTTP request to derive an origin from, so the default base
  // must stay the deployment-wide NANO_WORKFORCE_BASE_URL via publicBaseUrl().
  assertEquals(proposalReviewUrl("abc123"), `${publicBaseUrl()}/app/pages/delivery-graphs#proposal-abc123`);
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

// ── StageOutcome visibility (issue #740) ────────────────────────────────────────────────────────
test("stageProposal outcome: a FIRST stage reports nothing superseded and no live siblings", async () => {
  await withData(async (data) => {
    const outcome = await stageProposal(data, row({ digest: "d1" }));
    assertEquals(outcome.row.digest, "d1");
    assertEquals(outcome.superseded, []);
    assertEquals(outcome.siblingsStaged, 0);
  });
});

test("stageProposal outcome: a same-logical-key re-stage reports the retired digest in `superseded`", async () => {
  await withData(async (data) => {
    await stageProposal(data, row({ digest: "d1" }));
    const outcome = await stageProposal(data, row({ digest: "d2" })); // same logical_key "runbook"
    assertEquals(outcome.row.digest, "d2");
    assertEquals(outcome.superseded, ["d1"], "the prior same-key staged digest was retired");
    assertEquals(outcome.siblingsStaged, 0, "no OTHER-logical-key live proposal exists");
  });
});

test("stageProposal outcome: an idempotent re-stage of the SAME live digest supersedes nothing", async () => {
  await withData(async (data) => {
    await stageProposal(data, row({ digest: "d1", createdAt: "2999-01-01T00:00:00.000Z" }));
    const outcome = await stageProposal(data, row({ digest: "d1", createdAt: "2999-01-01T00:00:00.000Z" }));
    assertEquals(outcome.row.digest, "d1");
    assertEquals(outcome.superseded, [], "re-staging the identical live digest retires nothing");
    assertEquals(outcome.siblingsStaged, 0);
  });
});

test("stageProposal outcome: an orphan sibling under a DIFFERENT logical key is counted in `siblingsStaged`", async () => {
  await withData(async (data) => {
    // The footgun: a renamed graph stages under a new logical key without superseding the old one.
    await stageProposal(data, row({ digest: "d1", logicalKey: "runbook-old" }));
    const outcome = await stageProposal(data, row({ digest: "d2", logicalKey: "runbook-new" }));
    assertEquals(outcome.row.digest, "d2");
    assertEquals(outcome.superseded, [], "a different logical key supersedes nothing");
    assertEquals(outcome.siblingsStaged, 1, "the still-live orphan under the old key is visible");
  });
});

test("stageProposal: reconciles to EXACTLY ONE live proposal — an older stage whose supersede pass runs AFTER a newer stage neither clobbers it (zero) nor coexists with it (two)", async () => {
  await withData(async (data) => {
    const table = deliveryGraphProposals(data);
    // A NEWER stage (d2) has already committed its row for logical_key "runbook" — the winner of a
    // concurrent double-stage, with a later `updated_at`. Its TTL is live (createdAt defaults to now).
    const newer = row({ digest: "d2" });
    newer.updated_at = "2999-01-01T00:00:00.000Z";
    await table.insert(newer);
    // Now the OLDER racer (d1) runs its supersede pass LAST. An "only-flip-rows-older-than-me" pass would
    // leave BOTH d1 and d2 staged (it won't flip the newer d2, and d2's own pass ran before d1 existed);
    // an unordered supersede-all would flip d2 too, leaving ZERO. Reconciling to the newest sibling must
    // supersede d1 (it has a newer staged sibling d2) and keep exactly d2 live.
    await stageProposal(data, row({ digest: "d1" }));
    assertEquals((await table.get("d2"))?.status, "staged", "the newer proposal must survive the older stage's supersede");
    assertEquals((await table.get("d1"))?.status, "superseded", "the older stage must supersede itself when a newer staged sibling exists");
    // EXACTLY ONE live proposal remains for the logical key — never zero, never two.
    const stillStaged = (await table.all()).filter((r) => r.status === "staged" && r.logical_key === "runbook");
    assertEquals(stillStaged.length, 1, "exactly one live proposal per logical graph");
    assertEquals(stillStaged[0]?.digest, "d2", "the globally-newest stage is the one that survives");
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

test("sweepExpiredProposals: a dispatch racing between the read and the write is NOT clobbered back to `expired`", async () => {
  await withData(async (data) => {
    // One aged-out staged proposal — the sweep's `find()` will see it as `staged`.
    await stageProposal(data, row({ digest: "d1", createdAt: "2024-01-01T00:00:00.000Z" }));
    const at = new Date(Date.parse("2024-01-01T00:00:00.000Z") + DELIVERY_PROPOSAL_TTL_MS + 1000);

    // Wrap the data layer so that, in the window between the sweep's `find()` and its per-row guarded
    // `exec`, the operator dispatches the proposal (status: staged -> dispatched). A blind
    // update-by-key would clobber that dispatch back to `expired`; the guarded UPDATE
    // (`WHERE status='staged'`) must instead no-op and leave the row `dispatched`.
    let raced = false;
    const racyData = new Proxy(data, {
      get(target, prop, receiver) {
        if (prop === "open") {
          return () => {
            const src = target.open();
            return new Proxy(src, {
              get(s, p) {
                if (p === "exec") {
                  return async (sql: string, params?: unknown[]) => {
                    if (!raced) {
                      raced = true;
                      await markProposalDispatched(data, "d1");
                    }
                    return s.exec(sql, params);
                  };
                }
                const v = Reflect.get(s, p, s);
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    const swept = await sweepExpiredProposals(racyData as DataLayer, at);
    assert(raced, "the racing dispatch should have fired");
    assertEquals(swept, 0);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dispatched");
  });
});

test("markProposalDismissed: flipping a live `staged` row returns true and lands it `dismissed`", async () => {
  await withData(async (data) => {
    await stageProposal(data, row());
    const flipped = await markProposalDismissed(data, "d1");
    // A real flip reports success (res.changed > 0) so the door can return 200/ok:true.
    assertEquals(flipped, true);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dismissed");
  });
});

test("markProposalDismissed: only a `staged` row is flipped; an already-terminal (dispatched) row is left untouched", async () => {
  await withData(async (data) => {
    await stageProposal(data, row());
    await markProposalDispatched(data, "d1");
    // A dismiss landing after the row already moved on must NOT clobber the terminal status, and must
    // report the lost race by returning `false` so the door can 400 instead of misreporting success.
    const flipped = await markProposalDismissed(data, "d1");
    assertEquals(flipped, false);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dispatched");
  });
});

test("markProposalDismissed: a dispatch racing between the door's liveness read and the write is NOT clobbered to `dismissed`", async () => {
  await withData(async (data) => {
    // A live staged proposal — the door's `getStagedProposal` sees it as `staged` before the write.
    await stageProposal(data, row());

    // Wrap the data layer so that, in the window between the door's liveness read and `markProposalDismissed`'s
    // guarded `exec`, the operator dispatches the proposal (status: staged -> dispatched). A blind
    // update-by-key would clobber that dispatch back to `dismissed`; the guarded UPDATE (`WHERE status='staged'`)
    // must instead no-op and leave the row `dispatched`.
    let raced = false;
    const racyData = new Proxy(data, {
      get(target, prop, receiver) {
        if (prop === "open") {
          return () => {
            const src = target.open();
            return new Proxy(src, {
              get(s, p) {
                if (p === "exec") {
                  return async (sql: string, params?: unknown[]) => {
                    if (!raced) {
                      raced = true;
                      await markProposalDispatched(data, "d1");
                    }
                    return s.exec(sql, params);
                  };
                }
                const v = Reflect.get(s, p, s);
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    const flipped = await markProposalDismissed(racyData as DataLayer, "d1");
    assert(raced, "the racing dispatch should have fired");
    // The guarded UPDATE changed 0 rows (row was `dispatched` at write time) → returns false so the door 400s.
    assertEquals(flipped, false);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dispatched");
  });
});

test("markProposalExpired: flipping a live `staged` row returns true and lands it `expired`", async () => {
  await withData(async (data) => {
    await stageProposal(data, row());
    const flipped = await markProposalExpired(data, "d1");
    // A real flip reports success (res.changed > 0).
    assertEquals(flipped, true);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "expired");
  });
});

test("markProposalExpired: only a `staged` row is flipped; an already-terminal (dispatched) row is left untouched", async () => {
  await withData(async (data) => {
    await stageProposal(data, row());
    await markProposalDispatched(data, "d1");
    // A retirement landing after the row already moved on must NOT clobber the terminal status back to
    // `expired`, and must report the lost race by returning `false`.
    const flipped = await markProposalExpired(data, "d1");
    assertEquals(flipped, false);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dispatched");
  });
});

test("markProposalExpired: a dismiss racing between the dispatch door's liveness read and the write is NOT clobbered to `expired`", async () => {
  await withData(async (data) => {
    // A live staged proposal — the dispatch door's `getStagedProposal` sees it as `staged` before the write.
    await stageProposal(data, row());

    // Wrap the data layer so that, in the window between the door's liveness read and `markProposalExpired`'s
    // guarded `exec`, the operator dismisses the proposal (status: staged -> dismissed). A blind
    // update-by-key would clobber that dismiss back to `expired`; the guarded UPDATE (`WHERE status='staged'`)
    // must instead no-op and leave the row `dismissed`.
    let raced = false;
    const racyData = new Proxy(data, {
      get(target, prop, receiver) {
        if (prop === "open") {
          return () => {
            const src = target.open();
            return new Proxy(src, {
              get(s, p) {
                if (p === "exec") {
                  return async (sql: string, params?: unknown[]) => {
                    if (!raced) {
                      raced = true;
                      await markProposalDismissed(data, "d1");
                    }
                    return s.exec(sql, params);
                  };
                }
                const v = Reflect.get(s, p, s);
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    const flipped = await markProposalExpired(racyData as DataLayer, "d1");
    assert(raced, "the racing dismiss should have fired");
    // The guarded UPDATE changed 0 rows (row was `dismissed` at write time) → returns false.
    assertEquals(flipped, false);
    assertEquals((await deliveryGraphProposals(data).get("d1"))?.status, "dismissed");
  });
});
