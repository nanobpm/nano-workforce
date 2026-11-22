// Tests for POST /app/api/actions/cancel — operationId `cancelInstance` (issue #667, epic #664).
//
// The delegate is a thin, record-consistent door over the SAME primitive the UI's per-row Cancel
// uses (urban's `cancelInstanceReconciling`). These tests drive the REAL primitive through a fake
// engine — no second source of truth for the cancel-then-reconcile dance — and pin the delegate's
// own contract: body validation, string-key enforcement, and the ok→200 / not-committed→502 mapping. The
// `abandoned` transition itself is DERIVED off the instance-state projection the primitive feeds
// (ADR 0065), so terminating the instance through this door is exactly what makes the PR drop out of
// `listActivePrs`; that derivation is the framework's, exercised via the shared primitive here.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { memBlackboardSource } from "../test/blackboardDb.ts";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import handler, { cancelKeyLocks, resetCancelKeyLocks } from "./cancelInstance.ts";

// The cancel door serializes its record/cancel/commit sequence on a PROCESS-WIDE per-key mutex, so a
// stale queued waiter from an earlier test would see (and roll back) a later test's rows. Start every
// test with a clean lock map.
resetCancelKeyLocks();

interface FakeEngineOpts {
  /** Reject the cancel call (an uncommitted termination). */
  cancelThrows?: boolean;
  /** The state `searchProcessInstances` reads back for the key. `undefined` ⇒ "gone" (empty). */
  readBackState?: "ACTIVE" | "COMPLETED" | "TERMINATED" | undefined;
  /** Record-app fakes only: the state read BEFORE the cancel lands (the door's engine liveness
   * probe). Defaults to ACTIVE — a live run. `undefined`-as-explicit is not used; "gone" ⇒ empty. */
  preState?: "ACTIVE" | "COMPLETED" | "TERMINATED" | "gone";
}

function makeApp(opts: FakeEngineOpts = {}): { app: AppApi; cancelCalls: string[] } {
  const cancelCalls: string[] = [];
  const engine = {
    async cancelInstance({ processInstanceKey }: { processInstanceKey: string }) {
      cancelCalls.push(processInstanceKey);
      if (opts.cancelThrows) throw new Error("engine refused");
    },
    async searchProcessInstances() {
      return opts.readBackState ? [{ state: opts.readBackState }] : [];
    },
  };
  // hasDefaultSource:false makes the primitive's projection feed a clean no-op (no derived-status
  // store to fake here) — the reconcile-through-projection path is the framework's own tested seam.
  const data = { hasDefaultSource: () => false };
  const app = { engine, data, log: noopLog() } as unknown as AppApi;
  return { app, cancelCalls };
}

function req(headers: Record<string, string> = {}) {
  return { method: "POST", path: "/app/api/actions/cancel", headers: new Headers(headers) };
}

// biome-ignore lint/suspicious/noExplicitAny: test-only invocation shim for the delegate.
async function callHandler(
  h: typeof handler,
  app: AppApi,
  body: unknown,
  headers: Record<string, string> = {},
  // biome-ignore lint/suspicious/noExplicitAny: test-only invocation shim for the delegate.
): Promise<any> {
  return await h({ req: req(headers) as any, params: {}, query: {}, body } as any, app);
}

// biome-ignore lint/suspicious/noExplicitAny: test-only invocation shim for the delegate.
async function call(app: AppApi, body: unknown): Promise<any> {
  return await callHandler(handler, app, body);
}

test("a missing processInstanceKey → 400 and never touches the engine", async () => {
  const { app, cancelCalls } = makeApp();
  assertEquals((await call(app, {})).status, 400);
  assertEquals((await call(app, { processInstanceKey: "  " })).status, 400);
  assertEquals((await call(app, undefined)).status, 400);
  assertEquals(cancelCalls.length, 0, "no cancel attempted without a key");
});

test("a committed cancel (engine terminates) → 200 ok, echoes the key, and cancels via the engine", async () => {
  const { app, cancelCalls } = makeApp({ readBackState: "TERMINATED" });
  const res = await call(app, { processInstanceKey: "2985" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.processInstanceKey, "2985");
  assertEquals(res.body.state, "TERMINATED");
  assertEquals(cancelCalls, ["2985"], "the shared primitive issued the engine cancel for the key");
});

test("an accepted cancel whose read model lags at ACTIVE is still trusted → 200 ok", async () => {
  // A non-throwing cancelInstance is a committed 204; the primitive trusts it even if the read
  // model still reports ACTIVE. The door must surface that as success, not a spurious 502.
  const { app } = makeApp({ readBackState: "ACTIVE" });
  const res = await call(app, { processInstanceKey: "42" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
});

test("a numeric processInstanceKey is rejected → 400 and never touches the engine", async () => {
  // Engine keys are 64-bit and can exceed JS's safe-integer range, so a numeric JSON value has
  // already lost precision before we see it — the door requires a string (matching the OpenAPI
  // contract) rather than coercing a possibly-corrupted number.
  const { app, cancelCalls } = makeApp({ readBackState: "TERMINATED" });
  const res = await call(app, { processInstanceKey: 2985 });
  assertEquals(res.status, 400);
  assertEquals(cancelCalls.length, 0, "a non-string key never reaches the engine");
});

test("an uncommitted cancel (engine throws, instance still ACTIVE) → 502 not-ok with the reason", async () => {
  const { app } = makeApp({ cancelThrows: true, readBackState: "ACTIVE" });
  const res = await call(app, { processInstanceKey: "77" });
  assertEquals(res.status, 502, "an unconfirmed termination must NOT be reported as success");
  assertEquals(res.body.ok, false);
  assert(typeof res.body.error === "string" && res.body.error.length > 0, "carries the failure reason");
});

test("no data source configured → 503 and never touches the engine (cannot reconcile the record)", async () => {
  // The record-consistent door refuses to cancel when it has no data source to reconcile the
  // terminal state into — a live cancel with no derived-status update would leave the record lying.
  const { app, cancelCalls } = makeApp();
  // Strip the data source the primitive would reconcile against.
  (app as unknown as { data?: unknown }).data = undefined;
  const res = await call(app, { processInstanceKey: "2985" });
  assertEquals(res.status, 503);
  assert("error" in res.body, "carries an error reason");
  assertEquals(cancelCalls.length, 0, "no cancel attempted without a data source");
});

test("shared-secret guard: when NANO_PR_WEBHOOK_SECRET is set, a missing/wrong secret → 401; the right one passes", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    // SECRET is captured at module load, so import a cache-busted copy to observe the guard.
    const mod = await import(`./cancelInstance.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const { app, cancelCalls } = makeApp({ readBackState: "TERMINATED" });
    const missing = await callHandler(guarded, app, { processInstanceKey: "2985" });
    assertEquals(missing.status, 401, "no secret header is rejected");
    const wrong = await callHandler(guarded, app, { processInstanceKey: "2985" }, { "x-hook-secret": "nope" });
    assertEquals(wrong.status, 401, "a wrong secret is rejected");
    assertEquals(cancelCalls.length, 0, "a rejected request never reaches the engine");
    const ok = await callHandler(guarded, app, { processInstanceKey: "2985" }, { "x-hook-secret": "s3cr3t" });
    assertEquals(ok.status, 200, "the correct secret is accepted");
    assertEquals(cancelCalls, ["2985"], "only the authorized request issues the engine cancel");
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});

// --- Record-type routing + a truthful reconciled result (issue #705) ----------------------------
//
// #667 shipped this door reconciling the pull_requests / plans aggregates, but a `processInstanceKey`
// belonging to a FEATURE RUN reported `reconciled:0` and left the `feature_runs` row inconsistent.
// These tests drive the delegate against a data layer whose derived tracking VIEWs are served off
// in-memory base stores (`withTrackingViews`, exactly as the feature/PR domain tests) plus a REAL
// SQLite `source()` so the shared primitive's absent-safe projection feed has a handle to write. They
// pin the delegate's OWN additions: it resolves the record type across every engine-backed binding,
// 404s a key that maps to none, and reports `reconciled` off the record's derived terminal edge.

// biome-ignore lint/suspicious/noExplicitAny: test-only in-memory table over dynamic row shapes.
function memTable(rows: any[], key: string) {
  // biome-ignore lint/suspicious/noExplicitAny: test-only predicate over dynamic row shapes.
  const matches = (r: any, q: any) => Object.entries(q).every(([f, v]) => r[f] === v);
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test-only.
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    // biome-ignore lint/suspicious/noExplicitAny: test-only.
    find: (q: any = {}) => Promise.resolve(rows.filter((r) => matches(r, q))),
    // biome-ignore lint/suspicious/noExplicitAny: test-only.
    findOne: (q: any = {}) => Promise.resolve(rows.find((r) => matches(r, q)) ?? null),
    // biome-ignore lint/suspicious/noExplicitAny: test-only.
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only.
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only.
    delete: (k: any) => {
      const i = rows.findIndex((x) => x[key] === k);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve(i >= 0 ? 1 : 0);
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test-only store map over dynamic row shapes.
function makeRecordApp(
  stores: Record<string, { rows: any[]; key: string }>,
  opts: FakeEngineOpts = {},
): { app: AppApi; cancelCalls: string[] } {
  const cancelCalls: string[] = [];
  const engine = {
    async cancelInstance({ processInstanceKey }: { processInstanceKey: string }) {
      cancelCalls.push(processInstanceKey);
      if (opts.cancelThrows) throw new Error("engine refused");
    },
    async searchProcessInstances() {
      if (cancelCalls.length === 0) {
        const pre = opts.preState ?? "ACTIVE";
        return pre === "gone" ? [] : [{ state: pre }];
      }
      return opts.readBackState ? [{ state: opts.readBackState }] : [];
    },
  };
  const bb = memBlackboardSource();
  const data = {
    hasDefaultSource: () => true,
    source: bb.source,
    table: withTrackingViews((name: string, key = "id") =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    ),
  };
  const app = { engine, data, log: noopLog() } as unknown as AppApi;
  return { app, cancelCalls };
}

/** A record-app whose fake engine models the reconciler: the instant the (accepted) cancel lands,
 * the owning record's derived edge settles to `abandoned` — exactly what the ADR-0065 projection
 * feed does on a real termination. Use it for the 200-path provenance tests, whose door re-reads the
 * record after the engine dance. */
// biome-ignore lint/suspicious/noExplicitAny: test-only store map over dynamic row shapes.
function makeSettlingRecordApp(
  stores: Record<string, { rows: any[]; key: string }>,
  opts: FakeEngineOpts = {},
): { app: AppApi; cancelCalls: string[] } {
  const cancelCalls: string[] = [];
  const engine = {
    async cancelInstance({ processInstanceKey }: { processInstanceKey: string }) {
      cancelCalls.push(processInstanceKey);
      if (opts.cancelThrows) throw new Error("engine refused");
      // The reconciler folds the terminated instance into the record's derived edge at once.
      for (const store of Object.values(stores)) {
        const row = store.rows.find((r) => r.process_key === processInstanceKey);
        if (row) row.derived_status = "abandoned";
      }
    },
    async searchProcessInstances() {
      if (cancelCalls.length === 0) {
        const pre = opts.preState ?? "ACTIVE";
        return pre === "gone" ? [] : [{ state: pre }];
      }
      return opts.readBackState ? [{ state: opts.readBackState }] : [];
    },
  };
  const bb = memBlackboardSource();
  const data = {
    hasDefaultSource: () => true,
    source: bb.source,
    table: withTrackingViews((name: string, key = "id") =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    ),
  };
  const app = { engine, data, log: noopLog() } as unknown as AppApi;
  return { app, cancelCalls };
}

test("a key that maps to NO tracked record → 404 no-op and never touches the engine", async () => {
  // The record-type resolver finds no binding row for this key: a clean 404, NOT a silent
  // reconciled:0 success — and we never terminate an instance we don't track.
  const { app, cancelCalls } = makeRecordApp({ feature_runs: { rows: [], key: "feature_key" } });
  const res = await call(app, { processInstanceKey: "does-not-exist" });
  assertEquals(res.status, 404);
  assertEquals(res.body.ok, false);
  assertEquals(res.body.state, "gone");
  assertEquals(res.body.reconciled, 0);
  assert(typeof res.body.error === "string" && res.body.error.length > 0, "carries a reason");
  assertEquals(cancelCalls.length, 0, "an untracked key never reaches the engine");
});

test("a feature-run key whose derived record is terminal → 200 ok reconciled:1 (resubmittable)", async () => {
  // The live repro: the engine instance is already TERMINATED, so its `feature_runs` row derives to
  // `abandoned` (base `status` frozen at its last transient — the ADR-0065 divergence, seeded here).
  // The shared primitive writes nothing new (already terminal), yet the delegate must report the
  // record's REAL terminal state, not the projection-write delta of 0.
  const { app, cancelCalls } = makeRecordApp(
    {
      feature_runs: {
        rows: [
          {
            feature_key: "Magikcraft/nano-bpm#1099",
            process_key: "5654",
            status: "running",
            derived_status: "abandoned",
          },
        ],
        key: "feature_key",
      },
    },
    { cancelThrows: true, readBackState: "TERMINATED" },
  );
  const res = await call(app, { processInstanceKey: "5654" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.reconciled, 1, "the lagging feature_runs record is reported reconciled");
  assertEquals(cancelCalls, ["5654"], "the door still issued the idempotent engine cancel");
});

test("a feature-run key committed-cancelled whose record went terminal → 200 ok reconciled:1", async () => {
  const { app } = makeRecordApp(
    {
      feature_runs: {
        rows: [{ feature_key: "o/r#7", process_key: "900", status: "running", derived_status: "abandoned" }],
        key: "feature_key",
      },
    },
    { readBackState: "TERMINATED" },
  );
  const res = await call(app, { processInstanceKey: "900" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.reconciled, 1);
});

test("engine terminates but the record stays ACTIVE → 502 ok:false (not an unqualified success)", async () => {
  // A resolved record whose derived edge did NOT leave `activeStatuses` (e.g. a projection write that
  // failed) must not be reported as a clean cancel: reconciled:0 and a non-ok 502.
  const { app } = makeRecordApp(
    {
      feature_runs: {
        // No seeded derived_status ⇒ the VIEW folds `derived_status := status` = "running" (still active).
        rows: [{ feature_key: "o/r#8", process_key: "901", status: "running" }],
        key: "feature_key",
      },
    },
    { readBackState: "TERMINATED" },
  );
  const res = await call(app, { processInstanceKey: "901" });
  assertEquals(res.status, 502, "a terminated instance whose record didn't reconcile is not ok:true");
  assertEquals(res.body.ok, false);
  assertEquals(res.body.reconciled, 0);
  assert(typeof res.body.error === "string" && res.body.error.length > 0, "explains the un-reconciled record");
});

test("record routing also covers PR/plan aggregates (a resolved pull_requests key reconciles)", async () => {
  const { app } = makeRecordApp(
    {
      pull_requests: {
        rows: [{ pr_key: "o/r#3", process_key: "300", status: "converging", derived_status: "abandoned" }],
        key: "pr_key",
      },
    },
    { readBackState: "TERMINATED" },
  );
  const res = await call(app, { processInstanceKey: "300" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.reconciled, 1);
});

test("PR#944: operator-cancel provenance is recorded even when the record fails to reconcile (502)", async () => {
  const rows: any[] = [{ pr_key: "o/r#4", process_key: "400", status: "converging" }];
  const { app } = makeRecordApp({ pull_requests: { rows, key: "pr_key" } }, { readBackState: "TERMINATED" });
  const res = await call(app, { processInstanceKey: "400" });
  assertEquals(res.status, 502, "the unreconciled record still surfaces as 502");
  assertEquals(rows[0].termination_process_key, "400", "provenance is stamped once the engine confirms termination");
  assert(typeof rows[0].termination_reason === "string" && rows[0].termination_reason.length > 0);
});

// --- Operator-cancel provenance → the `cancelled` terminal status (issue #994) -------------------

test("issue #994 — cancelling a delivery graph records the actor + reason so its read model reports `cancelled`, not `failed`", async () => {
  const stores = {
    delivery_graph_runs: {
      rows: [{ run_key: "103f7697d662", process_key: "1206", status: "running" }],
      key: "run_key",
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only rows over a dynamic shape.
    run_cancellations: { rows: [] as any[], key: "process_key" },
  };
  // The engine accepts the cancel and the instance reads back TERMINATED — a FRESH termination of a
  // live run, so the provenance row is COMMITTED (only a committed row reads as `cancelled`). The
  // settling fake models the reconciler folding the record's derived edge the instant the cancel
  // lands (the door re-reads the record after the engine dance).
  const { app, cancelCalls } = makeSettlingRecordApp(stores, { readBackState: "TERMINATED" });
  const res = await call(app, { processInstanceKey: "1206", actor: "jwulf", reason: "gate can never open (#992)" });
  assertEquals(res.status, 200);
  assertEquals(cancelCalls, ["1206"]);
  assertEquals(stores.run_cancellations.rows.length, 1);
  const cx = stores.run_cancellations.rows[0];
  assertEquals(cx.process_key, "1206");
  assertEquals(cx.run_table, "delivery_graph_runs");
  assertEquals(cx.cancelled_by, "jwulf");
  assertEquals(cx.cancel_reason, "gate can never open (#992)");
  assert(typeof cx.cancelled_at === "string" && cx.cancelled_at.length > 0, "stamps when");
  assertEquals(cx.committed, 1, "a confirmed cancel of a live run commits its provenance");
  // A re-cancel keeps the FIRST record (idempotent).
  await call(app, { processInstanceKey: "1206", actor: "someone-else" });
  assertEquals(stores.run_cancellations.rows.length, 1);
  assertEquals(stores.run_cancellations.rows[0].cancelled_by, "jwulf");
});

test("issue #994 — a cancel with no actor/reason defaults to `operator` and names the door", async () => {
  const stores = {
    feature_runs: { rows: [{ feature_key: "o/r#9", process_key: "77", status: "running" }], key: "feature_key" },
    // biome-ignore lint/suspicious/noExplicitAny: test-only rows over a dynamic shape.
    run_cancellations: { rows: [] as any[], key: "process_key" },
  };
  const { app } = makeSettlingRecordApp(stores, { readBackState: "TERMINATED" });
  await call(app, { processInstanceKey: "77" });
  assertEquals(stores.run_cancellations.rows[0].cancelled_by, "operator");
  assertEquals(stores.run_cancellations.rows[0].cancel_reason, "operator cancel (/actions/cancel)");
  assertEquals(stores.run_cancellations.rows[0].run_table, "feature_runs");
  assertEquals(stores.run_cancellations.rows[0].committed, 1);
});

// --- The provisional cancellation record is transactional (PR #996 adversarial review) ------------
//
// The door writes `run_cancellations` BEFORE the engine cancel so a crash in between still leaves
// the provenance. But the write used to survive an engine-REFUSED cancel (the !ok → 502 path): the
// still-live run then carried a `run_cancellations` row, and a LATER out-of-band terminate folded
// the `abandoned` edge with that stale record into a lying `cancelled` status (with the refused
// attempt's actor/reason). The record must be as transactional as the cancel it names: an
// uncommitted cancel leaves NO row behind.

test("an engine-REFUSED cancel leaves no run_cancellations row — a later out-of-band terminate reads `abandoned`, not `cancelled`", async () => {
  const stores = {
    feature_runs: { rows: [{ feature_key: "o/r#10", process_key: "88", status: "running" }], key: "feature_key" },
    // biome-ignore lint/suspicious/noExplicitAny: test-only rows over a dynamic shape.
    run_cancellations: { rows: [] as any[], key: "process_key" },
  };
  // The engine refuses the cancel and the instance is still ACTIVE → the door's 502 not-ok path.
  const { app } = makeRecordApp(stores, { cancelThrows: true, readBackState: "ACTIVE" });
  const res = await call(app, { processInstanceKey: "88", actor: "jwulf", reason: "wedged gate" });
  assertEquals(res.status, 502, "an unconfirmed termination is not ok");
  assertEquals(res.body.ok, false);
  assertEquals(
    stores.run_cancellations.rows.length,
    0,
    "the provisional provenance row is rolled back when the engine refuses the cancel",
  );
  // …so when the still-live run is later terminated OUT OF BAND, its derived terminal edge
  // (`abandoned`) has no stale cancellation to fold with — it must NOT be promoted to `cancelled`.
  const { effectiveTerminalStatus } = await import("../app/runTerminal.ts");
  const derived = "abandoned"; // the ADR-0065 terminated edge every run binding folds to
  const cancelledAt = stores.run_cancellations.rows[0]?.cancelled_at ?? null;
  assertEquals(effectiveTerminalStatus(derived, cancelledAt), "abandoned");
});

test("an engine-refused RETRY keeps the FIRST committed cancellation record (idempotency is not rolled back)", async () => {
  // First cancel COMMITS (the engine terminates a LIVE run): the provenance row is genuinely recorded
  // and committed. The record then reads terminal (derived_status `abandoned`).
  const stores = {
    feature_runs: { rows: [{ feature_key: "o/r#11", process_key: "99", status: "running" }], key: "feature_key" },
    // biome-ignore lint/suspicious/noExplicitAny: test-only rows over a dynamic shape.
    run_cancellations: { rows: [] as any[], key: "process_key" },
  };
  const { app } = makeSettlingRecordApp(stores, { readBackState: "TERMINATED" });
  const committed = await call(app, { processInstanceKey: "99", actor: "jwulf", reason: "first" });
  assertEquals(committed.status, 200);
  assertEquals(stores.run_cancellations.rows.length, 1);
  assertEquals(stores.run_cancellations.rows[0].committed, 1);
  // A later retry whose engine call throws (and reads non-terminal) hits the 502 path — but the row
  // it found was NOT inserted by this call, so the rollback must not delete the first record.
  const { app: refusing } = makeRecordApp(stores, { cancelThrows: true, readBackState: "ACTIVE" });
  const retried = await call(refusing, { processInstanceKey: "99", actor: "someone-else", reason: "second" });
  assertEquals(retried.status, 502);
  assertEquals(stores.run_cancellations.rows.length, 1, "a refused retry never deletes the committed record");
  assertEquals(stores.run_cancellations.rows[0].cancelled_by, "jwulf");
  assertEquals(stores.run_cancellations.rows[0].cancel_reason, "first");
  assertEquals(stores.run_cancellations.rows[0].committed, 1);
});

// --- Cancellation provenance races (PR #996 Copilot review) ----------------------------------------
//
// Two overlapping-request races broke the record/cancel/rollback protocol:
//  (1) a RETRY over an already-out-of-band-terminated run inserted a row and the shared primitive's
//      TERMINATED readback confirmed it as idempotent success, attributing the earlier termination to
//      the retrying caller (`abandoned` → a lying `cancelled`);
//  (2) request A inserted, request B re-used the row and committed its cancel, then A's refused
//      cancel rolled the SHARED row back — the operator-cancelled graph lost its actor/time/reason.

test("PR #996 — a cancel over an ALREADY out-of-band-terminated run does NOT attribute the termination to the retrying caller", async () => {
  // The graph was terminated out of band BEFORE this cancel: its record is already terminal
  // (`abandoned`) and NO cancellation row exists. The engine cancel throws but reads back TERMINATED,
  // so the shared primitive reports idempotent success — the exact shape Copilot flagged.
  const stores = {
    delivery_graph_runs: {
      rows: [{ run_key: "g#1", process_key: "700", status: "running", derived_status: "abandoned" }],
      key: "run_key",
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only rows over a dynamic shape.
    run_cancellations: { rows: [] as any[], key: "process_key" },
  };
  const { app } = makeRecordApp(stores, { cancelThrows: true, readBackState: "TERMINATED" });
  const res = await call(app, { processInstanceKey: "700", actor: "retrying-caller" });
  assertEquals(res.status, 200, "the idempotent cancel still reports success");
  assertEquals(stores.run_cancellations.rows.length, 1, "the attempt is recorded for audit");
  const row = stores.run_cancellations.rows[0];
  assertEquals(row.committed, 0, "a retry over an already-terminal run must NOT commit provenance");
  // …so the read model keeps the truthful out-of-band `abandoned`, not a lying `cancelled` carrying
  // the retrying caller's identity.
  const { effectiveTerminalStatus } = await import("../app/runTerminal.ts");
  assertEquals(effectiveTerminalStatus("abandoned", row.cancelled_at, row.committed === 1), "abandoned");
});

test("PR #996 — overlapping cancels: a refused request never deletes the provenance a concurrent request committed", async () => {
  // Request A inserts the provisional row, then request B re-uses it and its cancel commits, then
  // A's engine call is refused. Without per-key serialization A's rollback deletes B's committed
  // provenance (Copilot's interleave). The door serializes the whole record/cancel/commit/rollback
  // sequence per process key, so B's commit lands inside the critical section and A only ever
  // removes a row IT inserted.
  const stores = {
    feature_runs: { rows: [{ feature_key: "o/r#12", process_key: "800", status: "running" }], key: "feature_key" },
    // biome-ignore lint/suspicious/noExplicitAny: test-only rows over a dynamic shape.
    run_cancellations: { rows: [] as any[], key: "process_key" },
  };
  // B (the first to finish the engine dance) cancels successfully; A's engine call is refused.
  const { app: okApp } = makeSettlingRecordApp(stores, { readBackState: "TERMINATED" });
  const { app: refusingApp } = makeRecordApp(stores, { cancelThrows: true, readBackState: "ACTIVE" });
  const [a, b] = await Promise.all([
    call(refusingApp, { processInstanceKey: "800", actor: "request-a" }),
    call(okApp, { processInstanceKey: "800", actor: "request-b" }),
  ]);
  assertEquals(b.status, 200);
  assertEquals(a.status, 502);
  assertEquals(stores.run_cancellations.rows.length, 1, "exactly one provenance row survives the race");
  assertEquals(stores.run_cancellations.rows[0].committed, 1, "the committed provenance is never deleted by the refused request");
  // The record settled terminal through B's committed cancel (the settling fake's reconciler feed).
  const { effectiveTerminalStatus } = await import("../app/runTerminal.ts");
  const row = stores.run_cancellations.rows[0];
  assertEquals(effectiveTerminalStatus("abandoned", row.cancelled_at, row.committed === 1), "cancelled");
});

test("PR #996 — a record still ACTIVE in tracking but already TERMINATED in the engine does NOT commit the retrying caller's provenance", async () => {
  // Out-of-band terminate landed between tracking polls: the record snapshot still reads live, but
  // the engine already reports TERMINATED before this cancel — so this call did not end the run.
  const stores = {
    feature_runs: { rows: [{ feature_key: "o/r#13", process_key: "900", status: "running" }], key: "feature_key" },
    // biome-ignore lint/suspicious/noExplicitAny: test-only rows over a dynamic shape.
    run_cancellations: { rows: [] as any[], key: "process_key" },
  };
  const { app } = makeSettlingRecordApp(stores, { cancelThrows: true, readBackState: "TERMINATED", preState: "TERMINATED" });
  await call(app, { processInstanceKey: "900", actor: "late-caller" });
  assertEquals(stores.run_cancellations.rows[0]?.committed ?? 0, 0, "an engine-terminal-before-cancel run is never attributed");
});

test("PR #996 — a stale UNCOMMITTED row from an earlier attempt is re-owned by the fresh cancel, so the commit names the new caller", async () => {
  const stores = {
    feature_runs: { rows: [{ feature_key: "o/r#14", process_key: "910", status: "running" }], key: "feature_key" },
    run_cancellations: {
      rows: [{ process_key: "910", run_table: null, cancelled_by: "stale-a", cancel_reason: "old", cancelled_at: "2000-01-01T00:00:00.000Z", committed: 0 }],
      key: "process_key",
    },
  };
  const { app } = makeSettlingRecordApp(stores, { readBackState: "TERMINATED" });
  const res = await call(app, { processInstanceKey: "910", actor: "request-b", reason: "new" });
  assertEquals(res.status, 200);
  const row = stores.run_cancellations.rows[0];
  assertEquals(row.committed, 1);
  assertEquals(row.cancelled_by, "request-b", "the committed provenance names the fresh caller, not the stale attempt");
  assertEquals(row.cancel_reason, "new");
});

test("PR #996 — the per-key cancel lock is released (no unbounded map growth) after a cancel completes", async () => {
  resetCancelKeyLocks();
  const { app } = makeApp({ readBackState: "TERMINATED" });
  await call(app, { processInstanceKey: "920" });
  assertEquals(cancelKeyLocks.size, 0, "a completed, uncontended cancel leaves no lock entry behind");
});
