// Unit coverage for the delivery-graph `connector` node's idempotency envelope (ADR 0005 slice S4,
// Decision 7). The connector is the epic's one side-effecting node kind, so it MUST fire its outbound
// action AT-MOST-ONCE per dedupe key even though the engine delivers a job AT-LEAST-ONCE. These tests
// exercise the durable-fence ledger + claim→act envelope directly against an in-memory app data layer,
// no engine:
//   • a first dispatch DELIVERS (performs the action, records the claim),
//   • a redelivery on the same key DEDUPES (never re-acts, reports the original detail),
//   • distinct keys each deliver once,
//   • the graph-derived key falls back to `<processInstanceKey>:<elementId>` when no author key is set.
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "#test-assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import {
  CONVERGE_MERGE_TARGET,
  CONVERGE_TARGET,
  MERGE_MAIN_TARGET,
  connectorDedupeKey,
  convergeOnlyForTarget,
  type DeliveryConnectorDispatchRow,
  deliveryConnectorDispatches,
  dispatchConnector,
  isConvergeTarget,
} from "./deliveryConnector.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

/** A minimal in-memory ledger that deterministically drives the concurrent-race fence-LOSER path.
 * The winning claim `seed` is already present, so the caller's INSERT hits the UNIQUE fence; `missFirstFindOne`
 * makes the caller's PRE-insert `findOne` miss it (the classic findOne→insert race window), so `dispatchConnector`
 * falls into its catch branch and rediscovers the winning row there. Returns the live `rows` for assertions. */
function racingLedgerData(
  seed: DeliveryConnectorDispatchRow,
  opts: { missFirstFindOne: boolean },
): { data: DataLayer; rows: DeliveryConnectorDispatchRow[] } {
  const rows: DeliveryConnectorDispatchRow[] = [{ ...seed, id: 1 }];
  let nextId = 2;
  let firstFindOne = opts.missFirstFindOne;
  const table = {
    async findOne(where: Record<string, unknown> = {}) {
      if (firstFindOne) {
        firstFindOne = false;
        return undefined;
      }
      return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    },
    async insert(row: DeliveryConnectorDispatchRow) {
      if (rows.some((r) => r.dedupe_key === row.dedupe_key)) {
        throw new Error("UNIQUE constraint failed: delivery_connector_dispatches.dedupe_key");
      }
      const id = nextId++;
      rows.push({ ...row, id });
      return id;
    },
    async update(id: number, patch: Partial<DeliveryConnectorDispatchRow>) {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
    async find(where: Record<string, unknown> = {}) {
      return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    },
  };
  return { data: { table: () => table } as any as DataLayer, rows };
}

/** Boot an app purely for its provisioned data layer (migration 055 applied), run `fn`, tear down. */
async function withApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-connector-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("connectorDedupeKey: author key wins; else derives <processInstanceKey>:<elementId>; else null", () => {
  assertEquals(connectorDedupeKey({ dedupeKey: "author-1" }), "author-1");
  assertEquals(connectorDedupeKey({ dedupeKey: "  spaced  " }), "spaced");
  assertEquals(connectorDedupeKey({ processInstanceKey: "pi9", elementId: "n3" }), "pi9:n3");
  assertEquals(connectorDedupeKey({ dedupeKey: "  ", processInstanceKey: "pi9", elementId: "n3" }), "pi9:n3");
  assertEquals(connectorDedupeKey({ dedupeKey: null }), null);
  assertEquals(connectorDedupeKey({ processInstanceKey: "pi9" }), null);
  // The engine can return a NUMERIC processInstanceKey — it must still derive a key, not fail closed.
  assertEquals(connectorDedupeKey({ processInstanceKey: 12345, elementId: "n3" }), "12345:n3");
});

test("converge targets: `converge`/`converge-merge` are the enrollment targets; `converge` is review-only", () => {
  assertEquals(CONVERGE_TARGET, "converge");
  assertEquals(CONVERGE_MERGE_TARGET, "converge-merge");
  // Only the two converge literals route into `submitPr`; any other target stays a stub dispatch.
  assert(isConvergeTarget("converge"));
  assert(isConvergeTarget("converge-merge"));
  assert(!isConvergeTarget("slack"));
  assert(!isConvergeTarget("Converge"));
  assert(!isConvergeTarget(""));
  // `convergeOnly` default maps onto `submitPr`'s arg: `converge` stops at converged (true),
  // `converge-merge` drives the merge loop (false) — mirroring converge-feature's autoMerge inversion.
  assertEquals(convergeOnlyForTarget("converge"), true);
  assertEquals(convergeOnlyForTarget("converge-merge"), false);
});

test("two-level merge: `merge-main` is the graph-level enrollment target that drives the merge loop (S5)", () => {
  assertEquals(MERGE_MAIN_TARGET, "merge-main");
  // The graph-level top-level merge (graph → main) enrolls via `submitPr` like `converge-merge`.
  assert(isConvergeTarget("merge-main"));
  // It drives the merge loop (not review-only), so its `convergeOnly` default is false.
  assertEquals(convergeOnlyForTarget("merge-main"), false);
});

test("first dispatch delivers exactly once; a redelivery on the same key dedupes and never re-acts", async () => {
  await withApp(async (app) => {
    const at = "2025-01-01T00:00:00.000Z";
    const first = await dispatchConnector(app.db, { dedupeKey: "k1", target: "slack" }, at);
    assertEquals(first.connectorOutcome, "delivered");
    assert(first.connectorDetail.length > 0, "delivered dispatch carries an action detail");

    // A redelivery (at-least-once) of the SAME job — same key — must NOT perform the action again.
    const replay = await dispatchConnector(app.db, { dedupeKey: "k1", target: "slack" }, "2025-01-01T01:00:00.000Z");
    assertEquals(replay.connectorOutcome, "deduped");
    assertEquals(replay.connectorDetail, first.connectorDetail);

    // Exactly one durable ledger row exists for the key — the side effect fired at most once.
    const rows = await deliveryConnectorDispatches(app.db).find({ dedupe_key: "k1" });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "delivered");
  });
});

test("a redelivery of a CLAIMED-but-not-delivered row RESUMES the action (never wedges on a permanent dedupe)", async () => {
  await withApp(async (app) => {
    const ledger = deliveryConnectorDispatches(app.db);
    // Simulate a worker that crashed AFTER claiming the key but BEFORE recording delivery: a lone
    // `claimed` row whose action never fired.
    await ledger.insert({ dedupe_key: "wedged-1", target: "slack", outcome: "claimed", detail: null, dispatched_at: "2025-01-01T00:00:00.000Z" });

    // A redelivery must RESUME (perform the action + record delivery), not report `deduped` forever.
    const resumed = await dispatchConnector(app.db, { dedupeKey: "wedged-1", target: "slack" }, "2025-01-01T01:00:00.000Z");
    assertEquals(resumed.connectorOutcome, "delivered");
    assert(resumed.connectorDetail.length > 0, "the resumed dispatch carries an action detail");

    const rows = await ledger.find({ dedupe_key: "wedged-1" });
    assertEquals(rows.length, 1, "resume records on the existing row — no duplicate ledger entry");
    assertEquals(rows[0].outcome, "delivered");

    // And a subsequent redelivery of the now-DELIVERED row terminally dedupes.
    const replay = await dispatchConnector(app.db, { dedupeKey: "wedged-1", target: "slack" }, "2025-01-01T02:00:00.000Z");
    assertEquals(replay.connectorOutcome, "deduped");
    assertEquals(replay.connectorDetail, resumed.connectorDetail);
  });
});

test("the concurrent-race fence LOSER RESUMES a still-CLAIMED winning row (never dedupes on an un-acted claim)", async () => {
  // The winner CLAIMED the key (row present) but has NOT yet recorded delivery. The loser races: its
  // pre-insert lookup misses (the findOne→insert window), its INSERT hits the UNIQUE fence, and in the
  // catch it rediscovers the winner's STILL-`claimed` row. If the loser deduped and completed the job
  // here, the engine — having taken the loser's ack — would never redeliver, so a winner that then
  // crashed would strand the side effect FOREVER. The loser must RESUME the claimed row instead.
  const { data, rows } = racingLedgerData(
    { dedupe_key: "race", target: "slack", outcome: "claimed", detail: null, dispatched_at: "2025-01-01T00:00:00.000Z" },
    { missFirstFindOne: true },
  );
  const out = await dispatchConnector(data, { dedupeKey: "race", target: "slack" }, "2025-01-01T01:00:00.000Z");
  assertEquals(out.connectorOutcome, "delivered");
  assert(out.connectorDetail.length > 0, "the resumed dispatch carries an action detail");
  const settled = rows.filter((r) => r.dedupe_key === "race");
  assertEquals(settled.length, 1, "resume records on the winning row — no duplicate ledger entry");
  assertEquals(settled[0].outcome, "delivered");
});

test("the fence LOSER still DEDUPES a DELIVERED winning row (reports its detail, never re-acts)", async () => {
  const { data, rows } = racingLedgerData(
    { dedupe_key: "race2", target: "slack", outcome: "delivered", detail: "winner-detail", dispatched_at: "2025-01-01T00:00:00.000Z" },
    { missFirstFindOne: true },
  );
  const out = await dispatchConnector(data, { dedupeKey: "race2", target: "slack" }, "2025-01-01T01:00:00.000Z");
  assertEquals(out.connectorOutcome, "deduped");
  assertEquals(out.connectorDetail, "winner-detail");
  assertEquals(rows.filter((r) => r.dedupe_key === "race2").length, 1, "no re-act, no duplicate row");
  assertEquals(rows.find((r) => r.dedupe_key === "race2")?.outcome, "delivered");
});

test("the fence LOSER fails closed when the winning row carries a DIFFERENT target", async () => {
  const { data, rows } = racingLedgerData(
    { dedupe_key: "race3", target: "slack", outcome: "claimed", detail: null, dispatched_at: "2025-01-01T00:00:00.000Z" },
    { missFirstFindOne: true },
  );
  await assertRejects(
    () => dispatchConnector(data, { dedupeKey: "race3", target: "pagerduty" }, "2025-01-01T01:00:00.000Z"),
    Error,
    "different target",
  );
  // The mismatch must not have mutated the winning row (still an un-acted claim on its original target).
  const row = rows.find((r) => r.dedupe_key === "race3");
  assertEquals(row?.target, "slack");
  assertEquals(row?.outcome, "claimed");
});

test("distinct dedupe keys each deliver once", async () => {
  await withApp(async (app) => {
    const a = await dispatchConnector(app.db, { dedupeKey: "a", target: "t" }, "2025-01-01T00:00:00.000Z");
    const b = await dispatchConnector(app.db, { dedupeKey: "b", target: "t" }, "2025-01-01T00:00:00.000Z");
    assertEquals(a.connectorOutcome, "delivered");
    assertEquals(b.connectorOutcome, "delivered");
    const rows = await deliveryConnectorDispatches(app.db).find({});
    assertEquals(rows.length, 2);
  });
});

test("a dedupe key reused with a DIFFERENT target fails closed (never delivers/reports against the wrong destination)", async () => {
  await withApp(async (app) => {
    const ledger = deliveryConnectorDispatches(app.db);
    // A DELIVERED row would otherwise short-circuit to `deduped` and report the ORIGINAL target's detail.
    const first = await dispatchConnector(app.db, { dedupeKey: "reused", target: "slack" }, "2025-01-01T00:00:00.000Z");
    assertEquals(first.connectorOutcome, "delivered");
    await assertRejects(
      () => dispatchConnector(app.db, { dedupeKey: "reused", target: "pagerduty" }, "2025-01-01T01:00:00.000Z"),
      Error,
      "different target",
    );

    // A still-CLAIMED (crashed mid-flight) row would otherwise RESUME — against the wrong target.
    await ledger.insert({ dedupe_key: "claimed-reused", target: "slack", outcome: "claimed", detail: null, dispatched_at: "2025-01-01T00:00:00.000Z" });
    await assertRejects(
      () => dispatchConnector(app.db, { dedupeKey: "claimed-reused", target: "pagerduty" }, "2025-01-01T01:00:00.000Z"),
      Error,
      "different target",
    );

    // The mismatch must not have mutated either ledger row.
    const slackRows = await ledger.find({ target: "slack" });
    assertEquals(slackRows.length, 2, "both original-target rows are intact — no wrong-target write");

    // Re-dispatching each with its ORIGINAL target still dedupes/resumes normally.
    const replay = await dispatchConnector(app.db, { dedupeKey: "reused", target: "slack" }, "2025-01-01T02:00:00.000Z");
    assertEquals(replay.connectorOutcome, "deduped");
    assertEquals(replay.connectorDetail, first.connectorDetail);
  });
});
