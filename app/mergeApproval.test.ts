// Human approval before merge (issue #826): an optional `merge-approval` user task in the convergence
// loop, between the scope gate and `persist-converged` (`pr.finalize`, the merge-loop handoff). These
// deploy the committed model into the WASM engine and drive tokens through it: flag off → finalizes
// straight away; flag on → parks for a human; approve → finalizes; request changes (or anything that is
// not an explicit approve) → the guidance goes back to the review agent on the same PR, then approval is
// asked again.
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals } from "#test-assert";
import { assertThatInstance, byProcessId, createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";
import { ESCALATION_TASK_ELEMENTS, HUMAN_COMPLETABLE_ELEMENTS, validateEscalationVariables } from "./agentCompletion.ts";
import { PR_MERGE_APPROVAL_ELEMENT } from "./userTasks.ts";

const MODEL = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

/** Boots one loop whose every round converges cleanly; `answers` records the `answer` each review round saw.
 *  Job types in `held` get no worker until `register(type)`, so a test can act while the loop waits there. */
async function boot(vars: Record<string, unknown>, held: string[] = []) {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([{ name: "convergence-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const answers: unknown[] = [];
  const workers: Record<string, (v: Record<string, unknown>) => Record<string, unknown>> = {
    "senior:pr-review": (v) => {
      answers.push(v.answer);
      return { status: "converged", summary: "done" };
    },
    "pr.capture-head": () => ({ roundEntryHead: "sha" }),
    "pr.persist-round": () => ({}),
    "pr.progress-check": () => ({ progressed: true }),
    "pr.converge-gate": () => ({ convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false }),
    "senior:scope-classify": () => ({ scopeBlocked: false, scopeBlockReason: "" }),
    "pr.finalize": () => ({}),
  };
  const register = (type: string) =>
    engine.registerWorker(type, (job) => workers[type]((job as { variables: Record<string, unknown> }).variables));
  for (const type of Object.keys(workers)) if (!held.includes(type)) await register(type);
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: "convergence-loop",
    awaitCompletion: false,
    variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1, round: 1, maxRounds: 20, answer: null, huskRetries: 0, ...vars },
  });
  return { engine, answers, register, processInstanceKey };
}

function completions(engine: WasmEngineClient, elementId: string): number {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return (snap.elementStats ?? []).find((s) => s.elementId === elementId)?.completed ?? 0;
}

async function openApproval(engine: WasmEngineClient): Promise<string | undefined> {
  return (await engine.openUserTasks()).find((t) => t.elementId === PR_MERGE_APPROVAL_ELEMENT)?.userTaskKey;
}

const loop = (engine: WasmEngineClient) => assertThatInstance(engine, byProcessId("convergence-loop"));

test("without humanApproval a converged PR finalizes straight away — no approval task", async () => {
  // `humanApproval` deliberately unseeded: a missing flag must behave exactly like `false`.
  const { engine } = await boot({});
  loop(engine).hasCompleted().hasNoIncident();
  assertEquals(completions(engine, "persist-converged"), 1);
  assertEquals(completions(engine, PR_MERGE_APPROVAL_ELEMENT), 0);
});

test("with humanApproval a converged PR parks for a human, and approve finalizes it", async () => {
  const { engine } = await boot({ humanApproval: true });
  loop(engine).isActive().hasActiveElement(PR_MERGE_APPROVAL_ELEMENT).hasNoIncident();
  assertEquals(completions(engine, "persist-converged"), 0, "nothing hands off to the merge-loop before approval");

  const key = await openApproval(engine);
  assert(key !== undefined, "the approval task is open");
  await engine.completeUserTask(key, { mergeDecision: "approve" });
  loop(engine).hasCompleted().hasNoIncident();
  assertEquals(completions(engine, "persist-converged"), 1);
});

test("request changes sends the guidance to the review agent on the same PR, then asks again", async () => {
  const { engine, answers, processInstanceKey } = await boot({ humanApproval: true });
  const first = await openApproval(engine);
  assert(first !== undefined, "the approval task is open");
  await engine.completeUserTask(first, { mergeDecision: "revise", answer: "Rename foo to bar." });

  loop(engine).isActive().hasActiveElement(PR_MERGE_APPROVAL_ELEMENT).hasNoIncident();
  assertEquals(answers.length, 2, "the review agent ran again");
  assertEquals(answers[1], "Rename foo to bar.", "the revise round received the human's guidance");
  assertEquals(completions(engine, "capture-head"), 2, "the revise re-entered the same loop");
  assertEquals(completions(engine, "persist-converged"), 0);
  const second = await openApproval(engine);
  assert(second !== undefined && second !== first, "approval is asked again after the revision");
  // A revise is NOT an approval: the gate must stay set, so /status keeps reporting
  // `blockedBy: "human-approval"` while the re-asked approval is outstanding (PR #917 review).
  const [row] = await engine.searchVariables({ processInstanceKey: String(processInstanceKey), name: "humanApproval" });
  assertEquals(row ? JSON.parse(row.value) : undefined, true, "a revise keeps the human-approval gate set");
});

test("a live ungated loop narrowed to humanApproval (a gated submitPr adopting it) parks for approval", async () => {
  // `submitPr` narrows an adopted live loop with setVariables (app/service.ts); the gateway must honour it.
  const { engine, register, processInstanceKey } = await boot({ humanApproval: false }, ["senior:pr-review"]);
  loop(engine).isActive().hasActiveElement("review-round");
  await engine.setVariables({ scopeKey: String(processInstanceKey), variables: { humanApproval: true } });
  await register("senior:pr-review");
  loop(engine).isActive().hasActiveElement(PR_MERGE_APPROVAL_ELEMENT).hasNoIncident();
  assertEquals(completions(engine, "persist-converged"), 0, "the adopted loop never merges unapproved");
});

test("fail-closed: a completion without an explicit approve never merges", async () => {
  const { engine } = await boot({ humanApproval: true });
  const key = await openApproval(engine);
  assert(key !== undefined, "the approval task is open");
  await engine.completeUserTask(key, {});
  loop(engine).isActive().hasActiveElement(PR_MERGE_APPROVAL_ELEMENT).hasNoIncident();
  assertEquals(completions(engine, "persist-converged"), 0);
});

test("an approve clears the humanApproval gate while finalization is still pending (PR #917 review)", async () => {
  // The /status merge projection derives `blockedBy: "human-approval"` from the loop's
  // `humanApproval` variable alone, so an approved PR whose `pr.finalize` handoff is still queued
  // (or incidented) would otherwise keep reporting a human-approval blocker even though the
  // approval is complete. Hold `pr.finalize` so the loop stays ACTIVE after the approve, then read
  // the variable: it must be cleared by the approval itself, not by some later task.
  const { engine, processInstanceKey } = await boot({ humanApproval: true }, ["pr.finalize"]);
  const key = await openApproval(engine);
  assert(key !== undefined, "the approval task is open");
  await engine.completeUserTask(key, { mergeDecision: "approve" });
  loop(engine).isActive().hasNoIncident();
  const [row] = await engine.searchVariables({ processInstanceKey: String(processInstanceKey), name: "humanApproval" });
  assertEquals(row ? JSON.parse(row.value) : undefined, false, "approval complete — the blocker must clear");
});

test("merge-approval is human-only, and its form requires guidance only for request changes", () => {
  assert(HUMAN_COMPLETABLE_ELEMENTS.has(PR_MERGE_APPROVAL_ELEMENT), "the human completer accepts it");
  assert(!ESCALATION_TASK_ELEMENTS.has(PR_MERGE_APPROVAL_ELEMENT), "an agent must never approve a merge");
  const check = (vars: Record<string, unknown>) => validateEscalationVariables(PR_MERGE_APPROVAL_ELEMENT, vars);
  assertEquals(check({ mergeDecision: "approve" }), null);
  assertEquals(check({ mergeDecision: "revise", answer: "Rename foo." }), null);
  assert(check({}) !== null, "a decision is required");
  assert(check({ mergeDecision: "revise" }) !== null, "request changes needs guidance");
  assert(check({ mergeDecision: "revise", answer: "  " }) !== null, "blank guidance is rejected");
  assert(check({ mergeDecision: "merge" }) !== null, "only approve/revise are accepted");
});
