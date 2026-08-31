// Structural guard for the ADR 0006 S4 fine-grained cells (#591).
//
// S4 introduces ONE shared, composable representation of the atomic delivery cell — implement →
// converge → merge — as standalone `callActivity`-composable processes under
// `resources/processes/`, so feature/epic (and later the S6 compiler) compose a wave from ONE token
// per cell instead of copy-pasting the inlined subProcess three ways (#464 "the duplication today").
//
// These are STRUCTURAL invariants (the cells exist, keep their engine-native task types, and wire
// escalation through the shared `human-escalation` cell) plus the live composition seam:
// `feature.bpmn` composes its converge step via a `callActivity` to the `converge-cell` (with an
// explicit `zeebe:ioMapping` carrying `ConvergeFeatureIn`), so the inlined `pr.converge-feature`
// serviceTask no longer sits on the feature path. Native callActivity execution is provided by
// urban-testkit 1.0.0 (#631) — the earlier "engine pass-through" was the testkit's callActivity
// rewrite, removed in 1.0.0. This guard pins the decomposition so the shared cells can't silently
// drift back into per-caller copies.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";

function model(name: string): string {
  return readFileSync(`resources/processes/${name}.bpmn`, "utf8");
}
function flat(name: string): string {
  return model(name).replace(/\s+/g, " ");
}

test("the five S4 shared cells exist as standalone executable processes", () => {
  const expected: Record<string, string> = {
    "implement-cell": "implement-cell",
    "converge-cell": "converge-cell",
    "merge-cell": "merge-cell",
    "wait-gate": "wait-gate",
    "human-escalation": "human-escalation",
  };
  for (const [file, id] of Object.entries(expected)) {
    const xml = flat(file);
    assert(
      new RegExp(`<bpmn:process\\b[^>]*\\bid="${id}"[^>]*\\bisExecutable="true"`).test(xml),
      `${file}.bpmn must declare an executable process id="${id}"`,
    );
  }
});

test("implement-cell runs the senior:feature loop and delegates escalation to the human-escalation cell", () => {
  const xml = flat("implement-cell");
  assert(/<zeebe:taskDefinition\b[^>]*\btype="senior:feature"/.test(xml), "implement-cell keeps the senior:feature agent task");
  assert(
    /<zeebe:calledElement\b[^>]*\bprocessId="human-escalation"/.test(xml),
    "implement-cell escalates through the shared human-escalation cell via callActivity",
  );
  // The answer loop re-enters the implement task — the atomic cell owns its own escalation retry.
  assert(/targetRef="implement-task"/.test(xml), "implement-cell loops the answer back into implement-task");
});

test("converge-cell and merge-cell keep their engine-native handoff task types", () => {
  assert(/<zeebe:taskDefinition\b[^>]*\btype="pr.converge-feature"/.test(flat("converge-cell")), "converge-cell hands off via pr.converge-feature");
  assert(/<zeebe:taskDefinition\b[^>]*\btype="senior:trial-merge"/.test(flat("merge-cell")), "merge-cell runs the senior:trial-merge agent");
  assert(/<zeebe:taskDefinition\b[^>]*\btype="pr.record-trial-merge"/.test(flat("merge-cell")), "merge-cell records the trial-merge result");
});

test("wait-gate is a readiness-probe cell; human-escalation parks on the shared feature-escalation form", () => {
  assert(/<zeebe:taskDefinition\b[^>]*\btype="pr.readiness-probe"/.test(flat("wait-gate")), "wait-gate probes readiness");
  const he = flat("human-escalation");
  assert(/<bpmn:userTask\b[^>]*\bid="escalation"/.test(he), "human-escalation parks on a userTask");
  assert(/<zeebe:formDefinition\b[^>]*\bformId="feature-escalation"/.test(he), "human-escalation renders the feature-escalation form");
});

test("feature.bpmn composes its converge step via callActivity to converge-cell — no inlined converge serviceTask", () => {
  // The live converge seam composes the shared `converge-cell` via a `callActivity` with an explicit
  // `zeebe:ioMapping` (mapping `ConvergeFeatureIn`'s fields into the child's process scope), rather
  // than an inlined `pr.converge-feature` serviceTask. Native callActivity execution is provided by
  // urban-testkit 1.0.0 (#631): the child process really instantiates, the `pr.converge-feature`
  // worker runs, and the feature run reaches `converging` / enrolls its PR (proven by
  // `e2e/feature-run.e2e.ts` "raise + converge"). The earlier "engine pass-through" was the testkit's
  // callActivity rewrite, removed in 1.0.0 — not an engine limitation.
  const xml = flat("feature");
  assert(
    /<bpmn:callActivity\b[^>]*\bid="converge"[\s\S]*?<zeebe:calledElement\b[^>]*\bprocessId="converge-cell"/.test(xml),
    "feature.bpmn must compose converge as a callActivity to converge-cell",
  );
  assert(
    !/<bpmn:serviceTask\b[^>]*\bid="converge"/.test(xml),
    "feature.bpmn must not keep an inlined converge serviceTask once the cell is composed",
  );
  // Pin the explicit `zeebe:ioMapping` itself: without it (or any of its inputs) the child cell
  // receives no mapped scope and the engine-wasm `propagateAll*` incompatibility this seam avoids
  // would silently return. Assert against the converge callActivity block alone so an ioMapping on
  // any other element can't satisfy the guard.
  const convergeBlock =
    xml.match(/<bpmn:callActivity\b[^>]*\bid="converge"[\s\S]*?<\/bpmn:callActivity>/)?.[0] ?? "";
  assert(
    /<zeebe:ioMapping>[\s\S]*?<\/zeebe:ioMapping>/.test(convergeBlock),
    "the converge callActivity must carry an explicit zeebe:ioMapping",
  );
  for (const field of ["featureKey", "prKey", "autoMerge"]) {
    assert(
      new RegExp(`<zeebe:input\\b[^>]*\\btarget="${field}"`).test(convergeBlock),
      `the converge callActivity ioMapping must map ConvergeFeatureIn.${field} into the child scope`,
    );
  }
});

test("feature.bpmn composes its implement step via callActivity to implement-cell — no inlined implement serviceTask", () => {
  // The implement seam (deferred out of #632, tracked in #646) composes the shared `implement-cell`
  // via a `callActivity` with an explicit `zeebe:ioMapping`, rather than an inlined `senior:feature`
  // serviceTask plus a per-caller escalation loop. The atomic cell owns its own escalation retry
  // (through the shared `human-escalation` cell), so the parent no longer carries the
  // `record-feature-escalation` / `feature-escalation` / answer-loop gateways.
  const xml = flat("feature");
  assert(
    /<bpmn:callActivity\b[^>]*\bid="implement"[\s\S]*?<zeebe:calledElement\b[^>]*\bprocessId="implement-cell"/.test(xml),
    "feature.bpmn must compose implement as a callActivity to implement-cell",
  );
  assert(
    !/<bpmn:serviceTask\b[^>]*\bid="implement-task"/.test(xml),
    "feature.bpmn must not keep an inlined implement-task serviceTask once the cell is composed",
  );
  // The inlined escalation loop is relocated into the atomic cell — the parent path must not keep it.
  assert(
    !/<bpmn:serviceTask\b[^>]*\bid="record-feature-escalation"/.test(xml),
    "feature.bpmn must not keep the inlined record-feature-escalation serviceTask once the cell owns escalation",
  );
  assert(
    !/<bpmn:userTask\b[^>]*\bid="feature-escalation"/.test(xml),
    "feature.bpmn must not keep the inlined feature-escalation userTask once the cell owns escalation",
  );
  // Pin the explicit `zeebe:ioMapping` on the implement callActivity block alone (no `propagateAll*`).
  const implementBlock =
    xml.match(/<bpmn:callActivity\b[^>]*\bid="implement"[\s\S]*?<\/bpmn:callActivity>/)?.[0] ?? "";
  assert(
    /<zeebe:ioMapping>[\s\S]*?<\/zeebe:ioMapping>/.test(implementBlock),
    "the implement callActivity must carry an explicit zeebe:ioMapping",
  );
  assert(
    /<zeebe:input\b[^>]*\btarget="task"/.test(implementBlock),
    "the implement callActivity ioMapping must map the task slice into the child scope",
  );
  for (const field of ["status", "summary", "pr"]) {
    assert(
      new RegExp(`<zeebe:output\\b[^>]*\\btarget="${field}"`).test(implementBlock),
      `the implement callActivity ioMapping must map the child result field ${field} back into the parent scope`,
    );
  }
});

test("plan-fanout.bpmn composes its per-wave implement step via a callActivity to implement-cell", () => {
  // Per ADR 0006 §2 the composition "replaces the inlined segments, not the surrounding orchestration":
  // the multi-instance `implement` subProcess (one token per wave task) keeps its fan-out-specific
  // capability barrier (`caps-prepare` / `wait-caps`) as surrounding orchestration, and its inlined
  // implement/escalation SEGMENT (the per-wave `senior:feature` serviceTask, the `w_gw` "clean
  // terminal?" gateway, and the `record-wave-escalation` recorder) collapses into a `callActivity` to
  // the shared `implement-cell` — the atomic cell now owns the agent loop and its escalation through the
  // shared `human-escalation` cell ("a wave IS a callActivity", #464/#646). The MI stays on the
  // subProcess (one token per wave); the cell is invoked once per token.
  const xml = flat("plan-fanout");
  // The MI element is the `implement` subProcess (one token per wave), preserved as the caps-barrier
  // host; assert its multi-instance loop over `waveTasks`.
  const implementSub =
    xml.match(/<bpmn:subProcess\b[^>]*\bid="implement"[\s\S]*?<\/bpmn:subProcess>/)?.[0] ?? "";
  assert(implementSub.length > 0, "plan-fanout.bpmn must keep the per-wave implement subProcess (the caps-barrier host)");
  assert(
    /<bpmn:multiInstanceLoopCharacteristics>[\s\S]*?inputCollection="=waveTasks"/.test(implementSub),
    "the implement subProcess must be multi-instance — one token per wave task",
  );
  // The caps barrier stays in the wave (fan-out-specific, not part of the atomic cell).
  assert(
    /<zeebe:taskDefinition\b[^>]*\btype="pr.caps-prepare"/.test(implementSub),
    "the capability barrier (caps-prepare) stays in the wave as surrounding orchestration",
  );
  // The implement/escalation segment is replaced by a callActivity to the shared implement-cell.
  const cellCall =
    implementSub.match(/<bpmn:callActivity\b[^>]*\bid="implement-cell-call"[\s\S]*?<\/bpmn:callActivity>/)?.[0] ?? "";
  assert(
    /<zeebe:calledElement\b[^>]*\bprocessId="implement-cell"/.test(cellCall),
    "plan-fanout.bpmn must compose the per-wave implement as a callActivity to implement-cell",
  );
  assert(
    /<zeebe:ioMapping>[\s\S]*?<\/zeebe:ioMapping>/.test(cellCall),
    "the implement-cell callActivity must carry an explicit zeebe:ioMapping (no propagateAll*)",
  );
  assert(
    /<zeebe:input\b[^>]*\btarget="task"/.test(cellCall) && /<zeebe:input\b[^>]*\btarget="subjectKey"/.test(cellCall),
    "the implement-cell callActivity must map the wave task and the plan subject key into the child scope",
  );
  // The inlined per-wave agent loop + escalation recorder no longer sit on the fan-out path.
  assert(
    !/<bpmn:serviceTask\b[^>]*\bid="implement-task"/.test(implementSub),
    "plan-fanout.bpmn must not keep an inlined implement-task serviceTask once the cell is composed",
  );
  assert(
    !/type="pr.record-wave-escalation"/.test(xml),
    "plan-fanout.bpmn must not keep the inlined record-wave-escalation recorder (folded into the cell's recorder)",
  );
});
