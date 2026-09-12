// Regression guard for issue #767 — the shared PR-escalation Tasks form must not render a blank
// read-only "Escalation question" field. The Tasks surface (`detail.engineForm`) seeds NO form
// variables, so the form's `question` control could never be populated at render time: it showed up
// blank while the actual request was already rendered separately as "Decision context" (the
// `user_tasks.question` read-model column, sourced from `latestOpenEscalationQuestion`). This mirrors
// the fix for the sibling `delivery-human-generic.form` (#773): make the form static / input-only —
// no `{{tokens}}`, no data-dependent `conditional`, and exactly one editable, required `answer` — and
// rely on the already-populated Decision context as the read-only prompt.
//
// This is the task/form-boundary guard the issue asks for, distinct from the durable `user_tasks`
// projection coverage in `pollUserTasks.test.ts`: it ties the committed `.form`, the BPMN
// `formDefinition` linkage, and the completer's typed contract together so none can drift back to a
// blank-question render.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals } from "#test-assert";
import { validateEscalationVariables } from "./agentCompletion.ts";

// biome-ignore lint/suspicious/noExplicitAny: form-js component shape is untyped JSON.
type FormComponent = { type: string; key?: string; readonly?: boolean; conditional?: unknown; validate?: any };
type Form = { id: string; components: FormComponent[] };

const formText = readFileSync("resources/forms/pr-escalation.form", "utf8");
const form = JSON.parse(formText) as Form;

test("pr-escalation.form: has exactly one editable, required input — `answer` — and no blank readonly question field", () => {
  assertEquals(form.id, "pr-escalation");
  // Only ONE keyed (data-bearing) control, and it is the editable required `answer`.
  const inputs = form.components.filter((c) => typeof c.key === "string");
  assertEquals(
    inputs.map((c) => c.key),
    ["answer"],
    "the form must expose exactly one input control, keyed `answer`",
  );
  const answer = inputs[0];
  assert(answer.readonly !== true, "the `answer` control must be editable, not read-only");
  assertEquals(answer.validate?.required, true, "the `answer` control must be required");
  // The blank read-only `question` field the operator could never fill (issue #767) must be gone —
  // Decision context is the canonical read-only prompt now.
  assert(
    !form.components.some((c) => c.key === "question"),
    "the blank readonly `question` field must be removed (Decision context is the prompt)",
  );
});

test("pr-escalation.form: is static — no `{{token}}` templating and no data-dependent `conditional`", () => {
  // Deploy-time `{{token}}` templating is removed repo-wide (AGENTS.md), and the Tasks `engineForm`
  // seeds no variables, so any data-dependent gate would never resolve — the exact failure mode #773
  // fixed for the sibling form. Guard against a reappearance on this one.
  assert(!/\{\{[^}]*\}\}/.test(formText), "the form must not contain `{{token}}` templating");
  assert(
    !form.components.some((c) => c.conditional !== undefined),
    "the form must not use a data-dependent `conditional` the Tasks surface can never resolve",
  );
});

test("pr-escalation.form: both PR escalation elements still complete with the `{ answer }` contract", () => {
  // Preserve the existing typed completion contract: `wait-answer` and `wait-merge-answer` both map to
  // this form and require a non-blank `answer` (validated via `validateEscalationVariables`). A missing
  // answer is rejected; a present one accepted — proving the input-only rewrite kept the contract.
  for (const element of ["wait-answer", "wait-merge-answer"]) {
    assert(
      validateEscalationVariables(element, {}) !== null,
      `${element} must reject a missing answer (pr-escalation form contract)`,
    );
    assert(
      validateEscalationVariables(element, { answer: "rerun the round" }) === null,
      `${element} must accept a valid { answer }`,
    );
  }
});

test("drift guard: both PR escalation user tasks link the pr-escalation form", () => {
  // The form the code validates against must be the SAME one both models render, or the operator sees
  // a different (blank-question) form than the contract guards.
  for (const model of ["convergence-loop", "merge-loop"]) {
    const bpmn = readFileSync(`resources/processes/${model}.bpmn`, "utf8");
    assert(
      /formId="pr-escalation"/.test(bpmn),
      `${model}.bpmn must link the pr-escalation form`,
    );
  }
});
