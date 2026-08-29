// Structural guard for the ADR 0006 S4 fine-grained cells (#591).
//
// S4 introduces ONE shared, composable representation of the atomic delivery cell — implement →
// converge → merge — as standalone `callActivity`-composable processes under
// `resources/processes/`, so feature/epic (and later the S6 compiler) compose a wave from ONE token
// per cell instead of copy-pasting the inlined subProcess three ways (#464 "the duplication today").
//
// These are STRUCTURAL invariants (the cells exist, keep their engine-native task types, and wire
// escalation through the shared `human-escalation` cell). The live converge seam on `feature.bpmn`
// stays an INLINE `pr.converge-feature` serviceTask: the engine (and the urban-testkit WASM engine)
// treats a callActivity as a pass-through that never runs the called process, so a callActivity
// converge would never enroll the PR (see `e2e/feature-run.e2e.ts`). This guard pins the
// decomposition so the shared cells can't silently drift back into per-caller copies.
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

test("feature.bpmn composes its converge step as an inline pr.converge-feature serviceTask", () => {
  // The live converge seam must stay INLINE, not a callActivity to converge-cell: the engine
  // (and the urban-testkit WASM engine the e2e boots) treats a BPMN callActivity as an immediate
  // pass-through — it never instantiates the called process, so the `pr.converge-feature` worker
  // would never run and the feature run could never reach `converging` / enroll its PR into the
  // convergence loop (proven by `e2e/feature-run.e2e.ts` "raise + converge"). The `converge-cell`
  // process still exists as a standalone, composable cell for future composition seams, but
  // feature.bpmn hands off converge directly so the behaviour is real.
  const xml = flat("feature");
  assert(
    /<bpmn:serviceTask\b[^>]*\bid="converge"[\s\S]*?<zeebe:taskDefinition\b[^>]*\btype="pr.converge-feature"/.test(xml),
    "feature.bpmn must compose converge as an inline pr.converge-feature serviceTask",
  );
  assert(
    !/<bpmn:callActivity\b[^>]*\bid="converge"/.test(xml),
    "feature.bpmn must not route its live converge step through a callActivity (a testkit/engine pass-through)",
  );
});
