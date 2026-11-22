// Issue #1005 — delivery-graph preview/dispatch degrade gracefully when the DI layout fails or times
// out: expanded → collapsed → no diagram (grid DI for deploy). Layout alone never fails the operation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileDeliveryGraph, compileDeliveryGraphSemantic } from "./deliveryGraphCompiler.ts";
import { gridDiagram, type LayoutFn, layoutWithFallback } from "./deliveryLayout.ts";
import { runDeliveryGraph } from "./deliveryRunner.ts";

const agent = (id: string, dependsOn: string[] = []) => ({
  id,
  kind: "agent",
  agent: { jobType: "senior:feature", prompt: `do ${id}` },
  ...(dependsOn.length ? { dependsOn } : {}),
});

const SMALL = { nodes: [agent("a"), agent("b", ["a"]), agent("c", ["a"]), agent("d", ["b", "c"])] };

async function semanticOf(graph: unknown): Promise<string> {
  const r = await compileDeliveryGraphSemantic(graph);
  assert.ok(r.ok);
  return r.semanticBpmn;
}

class LayoutError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LayoutError";
    this.code = code;
  }
}

const isCollapsedSeed = (xml: string) => xml.includes("CollapsedSeed_plane");
/** A fake layout that returns a trivial diagram (enough for the graft). */
const fakeDiagram = (tag: string) =>
  `<x><bpmndi:BPMNDiagram id="${tag}"><bpmndi:BPMNPlane id="${tag}_p" bpmnElement="delivery-graph"><bpmndi:BPMNShape id="${tag}_s" bpmnElement="Start"/></bpmndi:BPMNPlane></bpmndi:BPMNDiagram></x>`;

/** A deterministic clock: each layout attempt "spends" exactly the bound it was handed, so budget
 * allocation never depends on host timer scheduling. */
function fakeClock() {
  let t = 0;
  return { now: () => t, spend: (ms: number) => { t += ms; } };
}

test("#1005: expanded layout throwing ROUTING_FAILED falls back to collapsed, surfacing the reason", async () => {
  const semantic = await semanticOf(SMALL);
  const calls: string[] = [];
  const layout: LayoutFn = async (xml) => {
    if (!isCollapsedSeed(xml)) {
      calls.push("expanded");
      throw new LayoutError("ROUTING_FAILED", "no legal orthogonal route for flow f7");
    }
    calls.push("collapsed");
    return fakeDiagram("Collapsed");
  };
  const r = await layoutWithFallback(semantic, { layout, budgetMs: 10_000 });
  assert.deepEqual(calls, ["expanded", "collapsed"]);
  assert.equal(r.layout.mode, "collapsed");
  assert.match(r.layout.reason ?? "", /ROUTING_FAILED/);
  assert.match(r.layout.message, /^layout: collapsed \(expanded layout failed: .*ROUTING_FAILED/);
  assert.ok(r.bpmn.startsWith(semantic.slice(0, semantic.lastIndexOf("</bpmn:definitions>"))));
  assert.match(r.bpmn, /id="Collapsed"/);
});

test("#1005: the real collapsed retry lays out sub-processes collapsed", async () => {
  const semantic = await semanticOf(SMALL);
  const r = await layoutWithFallback(semantic, {
    budgetMs: 60_000,
    layout: async (xml, ms) => {
      if (!isCollapsedSeed(xml)) throw new LayoutError("ROUTING_FAILED", "boom");
      const { layoutBpmnOffThread } = await import("./layoutOffThread.ts");
      return layoutBpmnOffThread(xml, ms);
    },
  });
  assert.equal(r.layout.mode, "collapsed");
  assert.doesNotMatch(r.bpmn, /isExpanded="true"/);
  assert.doesNotMatch(r.bpmn, /CollapsedSeed/, "the seed DI must not leak into the grafted output");
  assert.match(r.bpmn, /<bpmndi:BPMNDiagram/);
});

test("#1005: a layout that never resolves hits its timeout and falls back, all within the one budget", async () => {
  const semantic = await semanticOf(SMALL);
  const budgetMs = 300;
  const timeouts: number[] = [];
  const clock = fakeClock();
  // Mirrors layoutBpmnOffThread: the attempt consumes its whole bound, then rejects.
  const layout: LayoutFn = async (_xml, timeoutMs) => {
    timeouts.push(timeoutMs);
    clock.spend(timeoutMs);
    throw new Error(`layout exceeded its ${timeoutMs}ms bound`);
  };
  const r = await layoutWithFallback(semantic, { layout, budgetMs, now: clock.now });
  assert.equal(timeouts.length, 2);
  assert.ok((timeouts[0] ?? 0) + (timeouts[1] ?? 0) <= budgetMs, `attempt bounds ${timeouts} exceed budget`);
  assert.equal(r.layout.mode, "none");
  assert.match(r.layout.reason ?? "", /exceeded/);
});

test("#1005: a collapsed layout that succeeds after an expanded timeout is within budget", async () => {
  const semantic = await semanticOf(SMALL);
  const timeouts: number[] = [];
  const clock = fakeClock();
  const layout: LayoutFn = async (xml, timeoutMs) => {
    timeouts.push(timeoutMs);
    if (isCollapsedSeed(xml)) return fakeDiagram("C");
    clock.spend(timeoutMs);
    throw new Error("timed out");
  };
  const r = await layoutWithFallback(semantic, { layout, budgetMs: 200, now: clock.now });
  assert.equal(timeouts.length, 2);
  assert.equal(r.layout.mode, "collapsed");
  assert.ok((timeouts[0] ?? 0) + (timeouts[1] ?? 0) <= 200);
});

const alwaysFails: LayoutFn = async () => {
  throw new LayoutError("ROUTING_FAILED", "no route");
};

test("#1005: both layouts failing still compiles — no auto-layout, grid DI for deploy, plain message", async () => {
  const r = await compileDeliveryGraph(SMALL, { layout: alwaysFails, budgetMs: 1000 });
  assert.ok(r.ok);
  assert.equal(r.layout.mode, "none");
  assert.match(r.layout.message, /No diagram could be laid out/);
  assert.match(r.layout.message, /ROUTING_FAILED/);
  // Deployable BPMN still carries DI (every root flow node has a shape).
  assert.match(r.bpmn, /<bpmndi:BPMNPlane id="GridPlane_1" bpmnElement="delivery-graph">/);
  for (const n of r.resolved.nodes) assert.match(r.bpmn, new RegExp(`bpmnElement="${n.element}"`));
  // Validation results/listing still present.
  assert.equal(r.resolved.nodes.length, 4);
});

test("#1005: both layouts failing — dispatch still launches", async () => {
  const deployed: string[] = [];
  const engine = {
    deployResources: async (rs: { content: string }[]) => {
      for (const res of rs) deployed.push(res.content);
      return {};
    },
    createInstance: async () => ({ processInstanceKey: "42" }),
  };
  // @ts-expect-error minimal engine fake (only the two methods runDeliveryGraph uses)
  const r = await runDeliveryGraph(engine, SMALL, { repoless: true, layout: { layout: alwaysFails, budgetMs: 1000 } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.handle.processInstanceKey, "42");
  assert.equal(r.handle.layout.mode, "none");
  assert.equal(deployed.length, 1);
  assert.match(deployed[0] ?? "", /<bpmndi:BPMNDiagram id="GridDiagram_1">/);
  // The plane follows the content-addressed process id rewrite.
  assert.match(deployed[0] ?? "", new RegExp(`bpmnElement="${r.handle.processDefinitionId}"`));
});

test("#1005: grid DI covers only root-level nodes and flows", async () => {
  const semantic = await semanticOf(SMALL);
  const grid = gridDiagram(semantic);
  const shapes = [...grid.matchAll(/<bpmndi:BPMNShape id="([^"]+)_di"/g)].map((m) => m[1]);
  assert.ok(shapes.includes("Start"));
  assert.equal(new Set(shapes).size, shapes.length, "no duplicate shapes");
  // Each edge references shapes on the plane.
  assert.match(grid, /<bpmndi:BPMNEdge /);
});

test("#1005 regression: a graph with ~38 expanded sub-processes previews successfully", async () => {
  // The release graph's compiled shape: 38 nodes, layered fan-out/fan-in.
  const nodes = [];
  for (let i = 0; i < 38; i++) {
    const deps = i === 0 ? [] : i < 6 ? ["n0"] : [`n${(i % 5) + 1}`, ...(i > 10 ? [`n${i - 5}`] : [])];
    nodes.push(agent(`n${i}`, [...new Set(deps)]));
  }
  const r = await compileDeliveryGraph({ nodes });
  assert.ok(r.ok);
  assert.notEqual(r.layout.mode, "none", r.layout.message);
  assert.match(r.bpmn, /<bpmndi:BPMNDiagram/);
});

test("#1005: a genuinely never-settling injected layout is bounded and degrades to the grid", async () => {
  const layout: LayoutFn = () => new Promise<string>(() => {});
  const semantic = await semanticOf(SMALL);
  const res = await layoutWithFallback(semantic, { layout, budgetMs: 50 });
  assert.equal(res.layout.mode, "none");
  assert.match(res.layout.reason ?? "", /expanded layout failed: layout timed out.*collapsed layout failed: (layout timed out|no layout budget left)/);
});

test("#1005: the collapsed retry is skipped (not run) once the budget is exhausted", async () => {
  const semantic = await semanticOf(SMALL);
  const clock = fakeClock();
  const calls: string[] = [];
  const layout: LayoutFn = async (xml, timeoutMs) => {
    calls.push(isCollapsedSeed(xml) ? "collapsed" : "expanded");
    clock.spend(timeoutMs * 10); // overruns the whole budget
    throw new Error("slow");
  };
  const r = await layoutWithFallback(semantic, { layout, budgetMs: 100, now: clock.now });
  assert.deepEqual(calls, ["expanded"]);
  assert.equal(r.layout.mode, "none");
  assert.match(r.layout.reason ?? "", /no layout budget left/);
});

test("#1005: a no-op layouter (returns its input) never yields an empty collapsed diagram", async () => {
  const semantic = await semanticOf(SMALL);
  const r = await layoutWithFallback(semantic, { layout: async (xml) => xml, budgetMs: 1000 });
  assert.equal(r.layout.mode, "none");
  assert.doesNotMatch(r.bpmn, /CollapsedSeed/);
  assert.match(r.bpmn, /<bpmndi:BPMNShape /);
});
