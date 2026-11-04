// Inbox prefill (issue #915, nanobpm/nano-ide#603). Urban's Tasks inbox (and the pages `engineForm`
// drawer) now load the task's PROCESS-scope variables and prefill keyed form inputs from them, as
// Camunda Tasklist does. A user task's completion lands in process scope, so a value submitted in one
// round is still there when the same form reopens. Two invariants follow:
//
//  1. Every editable form output of a user task that can recur within one process instance is CLEARED
//     after it is consumed (or derived into an internal name and cleared on the task's own outputs), so
//     the next visit opens blank — a quick submit can never re-send stale guidance or a stale `approve`.
//     The behavioural repeat-visit tests live next to each model's harness
//     (`mergeLoopBehaviour.test.ts`, `mergeApproval.test.ts`, `escalationCellPrefill.test.ts`); this
//     file adds the CLASS guard over every committed model, plus the readonly-input positives.
//  2. Inputs that are MEANT to be shown (`prompt`, `question`, `prKey`) are kept.
import { after, test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { assert, assertEquals } from "#test-assert";
import { createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";
import { inboxContext, prefilledKeys } from "../test/inboxContext.ts";

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

const PROCESSES = "resources/processes";
const FORMS = "resources/forms";

/** Inputs a form is MEANT to prefill (readonly context), never cleared. */
const INTENDED_INPUTS = new Set(["prompt", "question", "prKey"]);

/** User tasks whose form outputs are deliberately NOT cleared in their own model, with the reason.
 *  Keyed `<process file>#<userTask id>`. Anything else must clear every editable form key. */
const EXEMPT: Record<string, string> = {
  // Called once per delivery-graph human node: a fresh instance per visit, which ends on completion.
  "delivery-human.bpmn#delivery-human-task": "single-shot called process",
  // A fresh called instance per escalation; its caller (implement-cell `escalate`) blanks the
  // propagated `resolution`/`answer` with `=null` call-activity inputs — asserted below.
  "human-escalation.bpmn#escalation": "cleared by the calling implement-cell",
  // Demo process: one decision, then the instance ends.
  "spine-demo.bpmn#decide": "single-shot demo",
};

type FormComponent = { key?: string; readonly?: boolean; components?: FormComponent[] };
function editableKeys(formId: string): string[] {
  const form = JSON.parse(readFileSync(`${FORMS}/${formId}.form`, "utf8")) as { components: FormComponent[] };
  const keys: string[] = [];
  const walk = (cs: FormComponent[]) => {
    for (const c of cs) {
      if (c.key && c.readonly !== true && !INTENDED_INPUTS.has(c.key)) keys.push(c.key);
      if (c.components) walk(c.components);
    }
  };
  walk(form.components);
  return keys;
}

test("class guard: every recurring user task's editable form outputs are cleared in its model (#915)", () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const file of readdirSync(PROCESSES).filter((f) => f.endsWith(".bpmn"))) {
    const xml = readFileSync(`${PROCESSES}/${file}`, "utf8");
    for (const m of xml.matchAll(/<bpmn:userTask id="([^"]+)"[\s\S]*?<zeebe:formDefinition formId="([^"]+)"/g)) {
      const [, taskId, formId] = m;
      if (`${file}#${taskId}` in EXEMPT) continue;
      checked++;
      for (const key of editableKeys(formId)) {
        if (!new RegExp(`<zeebe:output source="=null" target="${key}" />`).test(xml)) {
          offenders.push(`${file}#${taskId} (${formId}): "${key}" is never reset — it would prefill the next visit`);
        }
      }
    }
  }
  assert(checked > 10, `the guard actually inspected the models (checked ${checked})`);
  assertEquals(offenders, []);
});

test("the implement cell blanks the human-escalation form keys it propagates into the called instance (#915)", () => {
  const xml = readFileSync(`${PROCESSES}/implement-cell.bpmn`, "utf8");
  const escalate = xml.match(/<bpmn:callActivity id="escalate"[\s\S]*?<\/bpmn:callActivity>/)?.[0] ?? "";
  for (const key of editableKeys("feature-escalation")) {
    assert(escalate.includes(`<zeebe:input source="=null" target="${key}" />`), `implement-cell escalate must blank "${key}"`);
  }
});

test("the delivery-human prompt is a process variable of the task, so the inbox shows it (#915)", async () => {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([
    { name: "delivery-human.bpmn", content: readFileSync(`${PROCESSES}/delivery-human.bpmn`, "utf8"), contentType: "text/xml" },
  ]);
  const prompt = "Publish @acme/widget@1.2.3 to npm with your OTP, then click done.";
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: "delivery-human",
    awaitCompletion: false,
    variables: { prompt, nodeId: "publish", escalationSlaTimeout: "PT1H" },
  });
  const [task] = (await engine.openUserTasks()).filter((t) => t.elementId === "delivery-human-task");
  assert(task !== undefined, "the human step is open");
  const pik = String(processInstanceKey);
  assertEquals((await inboxContext(engine, pik)).prompt, prompt, "the readonly 'Now do this' prompt is prefilled");
  assertEquals(await prefilledKeys(engine, pik, ["note", "value", "resolvedArtifact"]), [], "editable inputs open blank");
});

test("the delivery-human forms render the prompt readonly, so prefill shows it but never edits it (#915)", () => {
  for (const formId of ["delivery-human-ack", "delivery-human-publish"]) {
    const form = JSON.parse(readFileSync(`${FORMS}/${formId}.form`, "utf8")) as { components: FormComponent[] };
    const prompt = form.components.find((c) => c.key === "prompt");
    assert(prompt?.readonly === true, `${formId} keeps a readonly prompt`);
  }
});
