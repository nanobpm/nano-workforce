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
// `./flows.ts`) are reported as skipped WITH their precise reason, in two
// blocker classes — class 1: multiple top-level start/end events; class 2:
// arbitrary control-flow graph (`convergence-loop`). Companion diagnostics prove
// each blocker is real against the goldens themselves. No golden is modified to
// force a match — the derivation must reproduce the checked-in file.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals } from "#test-assert";
import { assertDerivationParity, normalize } from "@nanobpm/workflow/test-support";
import { declarativeToBpmn, defineFlow } from "@nanobpm/workflow";
import { PORTS } from "./flows.ts";

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
  ];
  assertEquals(
    PORTS.map((p) => p.model),
    expected,
    "PORTS must cover all seven goldens in the epic's authoring order",
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
// CLASS 1 — five goldens have MORE THAN ONE top-level start and/or end event,
// which the published `@nanobpm/workflow@0.12.0` compiler (a single
// `<startEvent id="Start">` + single `<endEvent id="End">`) cannot derive.
test("class-1 blocked goldens genuinely have multiple top-level start/end events", () => {
  const countTag = (xml: string, tag: string): number =>
    (xml.match(new RegExp(`<bpmn:${tag}\\b`, "g")) ?? []).length;

  const multiStartEndBlocked = new Set(["spine-demo", "readiness-gate", "feature", "merge-loop", "plan-fanout"]);
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
  // class 1; retro is class-3 blocked (a general service-task ioMapping),
  // convergence-loop is class-2 blocked — both below.
  for (const model of ["retro", "convergence-loop"]) {
    const xml = readFileSync(goldenPath(model), "utf8");
    assertEquals(countTag(xml, "startEvent"), 1, `${model} should have one start event`);
    assertEquals(countTag(xml, "endEvent"), 1, `${model} should have one end event`);
  }
});

// CLASS 3 — retro clears classes 1 & 2 (single start/end, structured topology)
// but its golden carries a service task with a GENERAL <zeebe:ioMapping> — inputs
// whose target is NOT `appendPrompt` — which @nanobpm/workflow@0.12.0's `task`
// builder cannot emit (it only produces an ioMapping via a `prompt.append`, i.e.
// a lone `appendPrompt` input). Prove both halves: the golden needs it, and the
// stock builder cannot produce it (awaits nano-ide#405).
test("retro golden needs a general service-task ioMapping the stock builder cannot emit", () => {
  const xml = readFileSync(goldenPath("retro"), "utf8");
  // (a) The golden has a service task carrying an ioMapping input to a non-prompt
  //     target (`record-conformance-ack`: =planKey→planKey, note→note).
  assert(
    /target="planKey"/.test(xml) && /target="note"/.test(xml),
    "retro golden should carry general ioMapping inputs (planKey, note) on record-conformance-ack",
  );
  // (b) The stock `task` builder only ever emits `appendPrompt` as an ioMapping
  //     target — never a general input like `note` — so the golden is not
  //     derivable until the upstream `io` construct lands.
  const probe = defineFlow("io-probe", (w) => {
    w.task("agent", {
      jobType: "senior:retro",
      prompt: { resourceId: "retro.md", bindingType: "latest", append: "=retroDigest" },
    });
  });
  const derived = declarativeToBpmn(probe);
  assert(/target="appendPrompt"/.test(derived), "prompt.append should emit an appendPrompt ioMapping input");
  assert(
    !/target="note"/.test(derived) && !/target="planKey"/.test(derived),
    "the stock task builder cannot emit a general (non-appendPrompt) ioMapping input",
  );
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
  // (c) a single exclusive gateway is at once a 5-way merge and a 2-way split.
  assertEquals(between("gw-escalated", "exclusiveGateway", "incoming"), 5, "gw-escalated should merge 5 flows");
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
