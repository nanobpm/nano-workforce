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
import { noopLog } from "../test/log.ts";
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
async function call(app: AppApi, body: unknown): Promise<any> {
  return await handler({ req: req() as any, params: {}, query: {}, body } as any, app);
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
