// Drift guard for the Tasks-inbox closed sets (issue #674 — fix the class, not the bug).
//
// Root cause of #674: the readiness/preflight escalation user tasks (`readiness-escalation-pf`,
// `readiness-escalation`) were deployed BPMN `<bpmn:userTask>`s with a linked `.form`, but their
// element ids were never added to the app-tier closed sets that gate surfacing (`USER_TASK_KIND_LABELS`,
// app/userTasks.ts) and completion (`HUMAN_COMPLETABLE_ELEMENTS` / `ESCALATION_FORM_BY_ELEMENT`,
// app/agentCompletion.ts). The poller's leak guard (`userTaskKindLabel(id) === undefined`) silently
// DROPPED every such task, so a parked run went invisible in the Tasks surface AND uncompletable
// through the one canonical `complete-user-task` door.
//
// This test makes that drift structurally impossible: it enumerates EVERY human `<bpmn:userTask>`
// (bearing a `<zeebe:userTask />`) in the deployed processes (`resources/processes/*.bpmn`) and asserts
// each element id is a KNOWN Tasks-inbox kind, and — where it declares a static `zeebe:formDefinition`
// form and is completable — that the completer's form contract resolves to the SAME `.form` the BPMN
// declares. So a future BPMN user task can never again vanish from the inbox by being absent from the
// hand-maintained closed set: the closed set's completeness is DERIVED from the deployed BPMN, not
// asserted blind.
//
// On `main` (before #674's registration) this test FAILS on `readiness-escalation-pf` /
// `readiness-escalation`; it passes once both are registered.
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { escalationFormId, HUMAN_COMPLETABLE_ELEMENTS } from "./agentCompletion.ts";
import { isDeliveryHumanElement } from "./deliveryHuman.ts";
import { userTaskKindLabel } from "./userTasks.ts";

const PROCESS_DIR = "resources/processes";

/** Demo/fixture processes that are deployed for the engine-spine e2e (`e2e/user-task-spine.e2e.ts`)
 *  but are NOT part of the workforce escalation surface — their user tasks are deliberately not
 *  Tasks-inbox kinds. Kept as a tiny, explicitly-documented file allowlist (not a per-id one) so a new
 *  REAL escalation process is still fully guarded. */
const DEMO_PROCESS_FILES: ReadonlySet<string> = new Set(["spine-demo.bpmn"]);

interface DeployedUserTask {
  file: string;
  elementId: string;
  /** The `zeebe:formDefinition formId`, when the task declares a static form. */
  formId: string | null;
}

/** Parse every human `<bpmn:userTask>` (one bearing a `<zeebe:userTask />`, i.e. a native user task an
 *  operator answers — not a job-worker task) out of the deployed process BPMN. Text parsing, matching
 *  the repo's lightweight model-guard style (convergenceEscalationGuard.test.ts et al.). */
function deployedHumanUserTasks(): DeployedUserTask[] {
  const out: DeployedUserTask[] = [];
  for (const file of readdirSync(PROCESS_DIR).filter((f) => f.endsWith(".bpmn"))) {
    if (DEMO_PROCESS_FILES.has(file)) continue;
    const xml = readFileSync(`${PROCESS_DIR}/${file}`, "utf8");
    for (const m of xml.matchAll(/<bpmn:userTask\b[^>]*\bid="([^"]+)"([\s\S]*?)<\/bpmn:userTask>/g)) {
      const [, elementId, body] = m;
      if (!/<zeebe:userTask\b/.test(body)) continue; // not a native human user task (no <zeebe:userTask/>)
      const form = body.match(/<zeebe:formDefinition\b[^>]*\bformId="([^"]+)"/);
      out.push({ file, elementId, formId: form ? form[1] : null });
    }
  }
  return out;
}

test("drift guard: every deployed human user task is a known Tasks-inbox kind (issue #674)", () => {
  const tasks = deployedHumanUserTasks();
  // Sanity: the sweep actually found the deployed escalations (guards against a parser that silently
  // matches nothing and vacuously passes).
  assert(tasks.length > 0, `expected the process sweep to find the deployed user tasks, got ${tasks.length}`);
  assert(
    tasks.some((t) => t.elementId === "readiness-escalation-pf"),
    "expected readiness-escalation-pf among the deployed user tasks",
  );
  assert(
    tasks.some((t) => t.elementId === "readiness-escalation"),
    "expected readiness-escalation among the deployed user tasks",
  );

  const unsurfaced = tasks.filter((t) => userTaskKindLabel(t.elementId) === undefined);
  assertEquals(
    unsurfaced.map((t) => `${t.file}:${t.elementId}`),
    [],
    "deployed user task(s) are not registered in USER_TASK_KIND_LABELS — pollUserTasks' leak guard would drop them from the Tasks inbox (issue #674)",
  );
});

test("drift guard: every deployed fixed-form user task is human-completable through the canonical door (issue #674)", () => {
  // The delivery-graph `human` node renders DIFFERENT forms per node (variable form, resolved at
  // activation), so it is intentionally absent from the static `ESCALATION_FORM_BY_ELEMENT` contract —
  // exclude it from the fixed-form assertion (it is still asserted to be a KNOWN kind above).
  const fixedForm = deployedHumanUserTasks().filter((t) => t.formId && !isDeliveryHumanElement(t.elementId));

  const notCompletable = fixedForm.filter((t) => !HUMAN_COMPLETABLE_ELEMENTS.has(t.elementId));
  assertEquals(
    notCompletable.map((t) => `${t.file}:${t.elementId}`),
    [],
    "deployed fixed-form user task(s) are not in HUMAN_COMPLETABLE_ELEMENTS — the canonical complete-user-task door would reject them",
  );

  const formMismatch = fixedForm.filter((t) => escalationFormId(t.elementId) !== t.formId);
  assertEquals(
    formMismatch.map((t) => `${t.file}:${t.elementId} bpmn=${t.formId} app=${escalationFormId(t.elementId) ?? "undefined"}`),
    [],
    "deployed user task(s) map to a different .form contract in ESCALATION_FORM_BY_ELEMENT than the BPMN declares",
  );
});
