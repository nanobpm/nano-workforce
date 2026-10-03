// Guard coverage for the off-main-thread BPMN autolayout (issue #854). `layoutBpmn`
// (`bpmn-auto-layout`) is superlinear and used to run SYNCHRONOUSLY on the app's event loop inside
// `compileDeliveryGraph` → `layoutDeliveryDiagram`, freezing the whole app (no HTTP, no poll passes)
// for the entire layout — a 3287ms single gap locally on the 54-node merlin graph, minutes under load
// (#852). It now runs in a `node:worker_threads` worker bounded by a timeout. These tests assert:
//   • the event loop KEEPS TICKING (bounded max gap) while a large graph lays out off-thread — the
//     core liveness property this fixes,
//   • the timeout TERMINATES a runaway layout and fails CLEANLY (rejects) rather than hanging,
//   • the canonical `compileDeliveryGraph` path still produces a diagram through the off-thread bridge.
import { test } from "node:test";
import { assert, assertRejects, assertStringIncludes } from "#test-assert";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import { layoutBpmnOffThread, layoutTimeoutMs } from "./layoutOffThread.ts";

/** Build a wide-and-deep delivery graph with `count` agent nodes wired into a chain with periodic
 * fan-out, so the autolayout has enough nodes/edges to spend real CPU time laying it out. */
function bigGraph(count: number): DeliveryGraph {
  const nodes: DeliveryGraph["nodes"] = [];
  const edges: DeliveryGraph["edges"] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({ id: `n${i}`, kind: "agent", agent: { jobType: "senior:feature", prompt: `slice ${i}` } });
    if (i > 0) edges.push({ from: `n${i - 1}`, to: `n${i}` });
    // Periodic fan-out to widen the graph (more edges → more layout work).
    if (i >= 3 && i % 3 === 0) edges.push({ from: `n${i - 3}`, to: `n${i}` });
  }
  return { name: "big-layout-graph", nodes, edges } as DeliveryGraph;
}

test("#854 the event loop keeps ticking (bounded max gap) while a large graph lays out off-thread", async () => {
  const graph = bigGraph(60);

  // Sample the event loop every 10ms; if layout ran inline on the loop, the interval would starve and
  // the gap between fires would spike to the whole layout duration (seconds). Off-thread, the loop
  // stays responsive and every gap stays small.
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 10);

  try {
    last = performance.now();
    const compiled = await compileDeliveryGraph(graph);
    assert(compiled.ok, `expected ok:true, got ${JSON.stringify("ok" in compiled && !compiled.ok ? compiled.errors : compiled)}`);
    assert(compiled.bpmn.includes("<bpmndi:BPMNDiagram"), "off-thread layout should still attach diagram interchange");
  } finally {
    clearInterval(timer);
  }

  assert(ticks > 0, "the interval should have fired at least once during layout");
  // A generous ceiling: the previous inline layout blocked the loop for 3287ms on this class of graph.
  // Off-thread, the loop keeps servicing the timer, so the worst gap stays well under a second even on
  // a loaded CI box. This bound is the regression guard — it fails loudly if layout moves back inline.
  assert(maxGap < 1000, `event loop blocked ${maxGap.toFixed(0)}ms during off-thread layout (expected < 1000ms)`);
});

test("#854 a layout that exceeds its timeout fails cleanly (rejects) instead of hanging", async () => {
  // A 1ms bound is unsatisfiable for any real graph, so the worker is terminated and the call rejects.
  const semantic = "<?xml version=\"1.0\"?><bpmn:definitions xmlns:bpmn=\"http://www.omg.org/spec/BPMN/20100524/MODEL\" id=\"d\"><bpmn:process id=\"p\" isExecutable=\"true\"><bpmn:startEvent id=\"s\"/></bpmn:process></bpmn:definitions>";
  const err = await assertRejects(() => layoutBpmnOffThread(semantic, 1));
  assertStringIncludes(err.message, "854");
});

test("#854 layoutTimeoutMs honours the env knob and ignores garbage", () => {
  assert(layoutTimeoutMs({}) === 300000, "unset → registered default");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "90000" }) === 90000, "valid override honoured");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "nope" }) === 300000, "garbage → default");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "-5" }) === 300000, "non-positive → default");
});
