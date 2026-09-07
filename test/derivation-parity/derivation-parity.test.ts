// Derivation-parity suite for epic nanobpm/nano-ide#314 (S5, sub-issue #320).
//
// For every nano-workforce golden in `resources/processes/*.bpmn`, assert that
// its code-first `defineFlow` port (see `./flows.ts`) derives a BPMN model that
// is STRUCTURALLY EQUAL to the checked-in golden, using the S0 parity harness
// (`@nanobpm/workflow/test-support`). The harness normalizes both models (strips
// DI, canonicalizes ids/ordering) and diffs their semantic structure — nodes,
// sequence flows, message subscriptions, timer/boundary definitions, user tasks,
// and linked resources — with a legible red/green diff on mismatch.
//
// Ported models run a real `assertDerivationParity`; parked models (see
// `./flows.ts`) are reported as skipped WITH their precise reason, in three
// blocker classes — class 1: multiple top-level start/end events; class 2:
// arbitrary control-flow graph (`convergence-loop`); class 3: the engine-native
// agent-task marker (`retro`, issue #745). Companion diagnostics prove each
// blocker is real against the goldens themselves. No golden is modified to
// force a match — the derivation must reproduce the checked-in file.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals } from "#test-assert";
import { assertDerivationParity, diffModels, modelsEqual, normalize } from "@nanobpm/workflow/test-support";
import { declarativeToBpmn, defineFlow } from "@nanobpm/workflow";
import { PORTS, retroFlow } from "./flows.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const goldenPath = (model: string): string => `${ROOT}resources/processes/${model}.bpmn`;

test("derivation parity — nano-workforce corpus", async (t) => {
  for (const port of PORTS) {
    const golden = goldenPath(port.model);
    const flow = port.flow;
    if (flow) {
      await t.test(`${port.model} derives its golden`, () => {
        assertDerivationParity(flow, golden);
      });
    } else {
      await t.test(`${port.model} (pending port)`, { skip: port.blockedReason ?? "pending" }, () => {});
    }
  }
});

// Every entry either derives its golden or documents why it cannot — so the
// corpus is fully accounted for and no model is silently dropped.
test("every corpus model is either ported or has a documented blocker", () => {
  const expected = [
    "retro",
    "spine-demo",
    "readiness-gate",
    "feature",
    "convergence-loop",
    "merge-loop",
    "plan-fanout",
    "delivery-human",
    "implement-cell",
    "converge-cell",
    "merge-cell",
    "wait-gate",
    "human-escalation",
  ];
  assertEquals(
    PORTS.map((p) => p.model),
    expected,
    "PORTS must cover all corpus goldens in the epic's authoring order",
  );
  for (const port of PORTS) {
    assert(
      port.flow !== undefined || (port.blockedReason && port.blockedReason.length > 0),
      `${port.model} must either be ported (flow) or carry a blockedReason`,
    );
  }
});

// The blockers are not guesses — prove each against the goldens themselves.
//
// CLASS 1 — six goldens have MORE THAN ONE top-level start and/or end event,
// which the published `@nanobpm/workflow@0.12.0` compiler (a single
// `<startEvent id="Start">` + single `<endEvent id="End">`) cannot derive.
test("class-1 blocked goldens genuinely have multiple top-level start/end events", () => {
  const countTag = (xml: string, tag: string): number =>
    (xml.match(new RegExp(`<bpmn:${tag}\\b`, "g")) ?? []).length;

  const multiStartEndBlocked = new Set([
    "spine-demo",
    "readiness-gate",
    "feature",
    "merge-loop",
    "plan-fanout",
    "delivery-human",
  ]);
  for (const model of multiStartEndBlocked) {
    const xml = readFileSync(goldenPath(model), "utf8");
    const starts = countTag(xml, "startEvent");
    const ends = countTag(xml, "endEvent");
    assert(
      starts > 1 || ends > 1,
      `${model} is marked compiler-blocked but has ${starts} start(s)/${ends} end(s) — reclassify it`,
    );
  }

  // The two single-start/single-end goldens (retro, convergence-loop) clear
  // class 1; each is blocked on a LATER class instead — retro on the class-3
  // agent-task marker (proven below), convergence-loop on its class-2 arbitrary
  // graph.
  for (const model of ["retro", "convergence-loop"]) {
    const xml = readFileSync(goldenPath(model), "utf8");
    assertEquals(countTag(xml, "startEvent"), 1, `${model} should have one start event`);
    assertEquals(countTag(xml, "endEvent"), 1, `${model} should have one end event`);
  }
});

// CLASS 2 — convergence-loop has a single start/end (clears class 1) but an
// ARBITRARY control-flow graph the structured-only builder cannot emit. Prove
// the three specific features against the golden itself.
test("convergence-loop golden has arbitrary-graph features the structured builder cannot emit", () => {
  const xml = readFileSync(goldenPath("convergence-loop"), "utf8");
  const between = (id: string, closeTag: string, tag: string): number => {
    // Count <bpmn:<tag>> occurrences inside the element `id`, whose end is its
    // own </bpmn:<closeTag>> (not the first nested close tag).
    const open = xml.indexOf(`id="${id}"`);
    assert(open >= 0, `convergence-loop golden is missing element id="${id}"`);
    const rest = xml.slice(open);
    const close = rest.indexOf(`</bpmn:${closeTag}>`);
    assert(close >= 0, `convergence-loop golden element id="${id}" is missing its closing </bpmn:${closeTag}>`);
    const body = rest.slice(0, close);
    return (body.match(new RegExp(`<bpmn:${tag}\\b`, "g")) ?? []).length;
  };
  // (a) the loop head is a serviceTask that MERGES three back-edges directly.
  assertEquals(between("review-round", "serviceTask", "incoming"), 3, "review-round should merge 3 flows on the task itself");
  // (b) a single exclusive gateway forks FOUR heterogeneous-condition out-edges.
  assertEquals(between("gw-status", "exclusiveGateway", "outgoing"), 4, "gw-status should be a 4-way exclusive gateway");
  // (c) a single exclusive gateway is at once a 6-way merge and a 2-way split.
  assertEquals(between("gw-escalated", "exclusiveGateway", "incoming"), 6, "gw-escalated should merge 6 flows");
  assertEquals(between("gw-escalated", "exclusiveGateway", "outgoing"), 2, "gw-escalated should also split 2 ways");
});

// CLASS 2, empirical — demonstrate WHY the structured builder cannot reproduce
// (a): a `loop()` whose body starts with a task derives an exclusive-gateway
// loop head that absorbs the back-edge (in>=2), leaving the task itself at
// in=1. The golden instead merges its back-edges directly into `review-round`
// (in=3) with no loop-head gateway — a shape the builder cannot express.
test("loop() inserts a gateway head, so back-edges cannot merge into a task", () => {
  const probe = defineFlow("loop-head-probe", (w) => {
    w.loop((b) => {
      b.task("review-round", { jobType: "senior:pr-review" });
      b.branch("done", { then: (g) => g.break() });
    });
  });
  const model = normalize(declarativeToBpmn(probe));
  const inDegree = (n: string): number => Number(/<in=(\d+)/.exec(n)?.[1] ?? "0");
  const gateways = model.nodes.filter((n) => n.startsWith("exclusiveGateway"));
  const tasks = model.nodes.filter((n) => n.startsWith("serviceTask"));
  assert(
    gateways.some((n) => inDegree(n) >= 2),
    "loop() should derive an exclusive-gateway head that absorbs the back-edge (in>=2)",
  );
  assert(
    tasks.every((n) => inDegree(n) <= 1),
    "the loop-body task cannot itself be the back-edge merge (it stays in<=1)",
  );
});

// CLASS 3 — retro has a single top-level start/end (clears class 1) and a fully
// structured topology (clears class 2), but issue #745 added the engine-native
// AgentTask marker `<zeebe:agentDefinition agentType="external" />` to its two
// prompt-bearing `senior:*` tasks and the published compiler cannot emit it.
// Prove the blocker is real AND that it is the ONLY divergence, so the parked
// entry is a complete, verified port held ready — not an abandoned one.
test("retro's complete port differs from its golden by ONLY the agent-task marker", () => {
  const golden = readFileSync(goldenPath("retro"), "utf8");
  const derived = declarativeToBpmn(retroFlow);
  const markers = (xml: string): number =>
    (xml.match(/<(?:\w+:)?agentDefinition\b[^>]*\bagentType="external"/g) ?? []).length;

  // (a) the golden really carries the marker, on BOTH of its agent tasks — and it
  //     cannot simply be dropped: app/agentic/vocab/agent-marker.test.ts is a
  //     defect-class guard requiring it on every deployed prompt-bearing agent task.
  assertEquals(markers(golden), 2, "retro's golden should mark senior:conformance and senior:retro");

  // (b) the published compiler emits none of it — the blocker is real, not a guess.
  //     When this starts failing, upstream task() grew marker support: un-park retro
  //     by threading `retroFlow` back into its PORTS entry in ./flows.ts.
  assertEquals(markers(derived), 0, "@nanobpm/workflow can now emit <zeebe:agentDefinition/> — un-park retro");

  // (c) strip exactly the marker lines from the golden and the port derives the
  //     WHOLE model green, through the shared harness's own normalize/equality —
  //     so nothing but the marker diverges.
  const unmarked = golden.replace(/^[ \t]*<(?:\w+:)?agentDefinition\b[^>]*\/>[ \t]*\r?\n/gm, "");
  assertEquals(markers(unmarked), 0, "the strip must remove every marker line");
  const expected = normalize(unmarked);
  const actual = normalize(derived);
  assert(
    modelsEqual(expected, actual),
    `retro's port must derive its golden once the agent-task marker is stripped — residual drift:\n${diffModels(expected, actual)}`,
  );
});
