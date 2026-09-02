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
import handler from "./cancelInstance.ts";

interface FakeEngineOpts {
  /** Reject the cancel call (an uncommitted termination). */
  cancelThrows?: boolean;
  /** The state `searchProcessInstances` reads back for the key. `undefined` ⇒ "gone" (empty). */
  readBackState?: "ACTIVE" | "COMPLETED" | "TERMINATED" | undefined;
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
      return opts.readBackState ? [{ state: opts.readBackState }] : [];
    },
  };
  const bb = memBlackboardSource();
  const data = {
    hasDefaultSource: () => true,
    source: bb.source,
    table: withTrackingViews((name: string, key: string) =>
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
