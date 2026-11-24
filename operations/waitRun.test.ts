// Route tests for `waitRun` (issue #1057): client-disconnect abort + the global waiter cap.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { RunView } from "../app/runLookup.ts";
import { type WaitClock, WaiterGate } from "../app/runWait.ts";
import { requestSignal, serveWait } from "./waitRun.ts";

const VIEW: RunView = {
  key: "o/r#5",
  kind: "feature",
  title: null,
  status: "running",
  terminal: false,
  stage: "implementing",
  settings: {
    converge: true,
    autoMerge: true,
    humanApproval: false,
    blockedOn: null,
    maxRounds: null,
    autoResolveEscalations: false,
    hasCustomInstructions: false,
  },
  processInstanceKey: "1",
  processInstanceKeys: ["1"],
  activeWorker: null,
  leaseUntil: null,
  prUrl: null,
  openEscalation: null,
  incident: null,
  acknowledgedAt: null,
  createdAt: null,
  updatedAt: "t0",
  plannedChildren: null,
  children: [],
};

/** Each sleep yields a macrotask then advances; ends only on abort or the deadline. */
function tickingClock(): WaitClock {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) =>
      new Promise((r) => {
        setImmediate(() => {
          t += ms;
          r();
        });
      }),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("requestSignal reads a fetch Request's abort signal", () => {
  const ac = new AbortController();
  assertEquals(requestSignal(new Request("http://x/", { signal: ac.signal })) instanceof AbortSignal, true);
  assertEquals(requestSignal({ headers: new Headers() }), undefined);
});

test("waitRun: aborting the request stops the lookup loop", async () => {
  const ac = new AbortController();
  const signal = requestSignal(new Request("http://x/app/api/run/wait", { signal: ac.signal }));
  let calls = 0;
  const lookup = async () => {
    calls++;
    return VIEW;
  };
  const p = serveWait("o/r#5", { until: "merged", timeout: "PT25M" }, {
    lookup,
    gate: new WaiterGate(4),
    signal,
    clock: tickingClock(),
    pollMs: 1_000,
  });
  for (let i = 0; i < 5; i++) await tick();
  ac.abort();
  const res = await p;
  const after = calls;
  for (let i = 0; i < 5; i++) await tick();
  assertEquals(calls, after);
  assertEquals(res.status, 200);
});

test("waitRun: the N+1th concurrent waiter gets 429 with Retry-After; the slot frees on completion", async () => {
  const gate = new WaiterGate(2);
  const acs = [new AbortController(), new AbortController()];
  const held = acs.map((ac) =>
    serveWait("o/r#5", { until: "merged" }, { lookup: async () => VIEW, gate, signal: ac.signal, clock: tickingClock() }),
  );
  await tick();
  const extra = await serveWait("o/r#5", { until: "merged" }, { lookup: async () => VIEW, gate, clock: tickingClock() });
  assertEquals(extra.status, 429);
  assertEquals("headers" in extra ? extra.headers?.["retry-after"] : undefined, "5");
  for (const ac of acs) ac.abort();
  await Promise.all(held);
  assertEquals(gate.held, 0);
});
