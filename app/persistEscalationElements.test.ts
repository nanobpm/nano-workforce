// Drift guard for `PR_ESCALATION_PRODUCER_ELEMENTS` (issue #829).
//
// The escalated-PR self-heal (`pollUserTasks` in app/service.ts) treats an ACTIVE `pr.persist-escalation`
// PRODUCER element as positive evidence an escalation is being raised, so it must NOT retire the live
// escalation. That guard is only as correct as the element-id set it checks against — a NEW escalation
// arm added to either loop's BPMN, or a renamed one, would silently fall outside the set and re-open the
// race the fix closes. This test derives the truth from the deployed BPMN: every service task whose
// `zeebe:taskDefinition type="pr.persist-escalation"` in convergence-loop.bpmn / merge-loop.bpmn must be
// listed in the constant, and the constant must list nothing that isn't such a task. It fails loudly on
// either drift so the set stays the single source of truth.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { PR_ESCALATION_PRODUCER_ELEMENTS } from "./userTasks.ts";

/** Extract the `id`s of every `<bpmn:serviceTask>` whose `<zeebe:taskDefinition type="pr.persist-escalation"/>`
 *  from one BPMN file. Matches each service task element and keeps the ones carrying the producer job type. */
function persistEscalationTaskIds(bpmnPath: string): string[] {
  const xml = readFileSync(bpmnPath, "utf8");
  const ids: string[] = [];
  const taskRe = /<bpmn:serviceTask\b[^>]*\bid="([^"]+)"[\s\S]*?<\/bpmn:serviceTask>/g;
  for (let m = taskRe.exec(xml); m !== null; m = taskRe.exec(xml)) {
    if (/<zeebe:taskDefinition\b[^>]*\btype="pr\.persist-escalation"/.test(m[0])) ids.push(m[1]);
  }
  return ids;
}

test("PR_ESCALATION_PRODUCER_ELEMENTS matches every pr.persist-escalation task in both PR loops (issue #829)", () => {
  const modelled = [
    ...persistEscalationTaskIds("resources/processes/convergence-loop.bpmn"),
    ...persistEscalationTaskIds("resources/processes/merge-loop.bpmn"),
  ].sort();
  // Sanity: the BPMN really does carry producer tasks — a zero here would make the match vacuously pass.
  assertEquals(modelled.length > 0, true, "expected at least one pr.persist-escalation task in the BPMN");
  assertEquals(
    [...PR_ESCALATION_PRODUCER_ELEMENTS].sort(),
    modelled,
    "PR_ESCALATION_PRODUCER_ELEMENTS drifted from the pr.persist-escalation tasks modelled in the BPMN — update the constant in app/userTasks.ts",
  );
});
