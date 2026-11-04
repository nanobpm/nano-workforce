// Inbox prefill (issue #915, nanobpm/nano-ide#603): the implement cell escalates through the
// `human-escalation` call activity, whose `feature-escalation` form keys (`resolution`, `answer`) the
// cell maps back into its own scope. A SECOND escalation in the same cell must open its task with blank
// inputs — the Tasks inbox prefills from the task's process variables, so a stale answer would be
// re-submitted by a quick click.
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals } from "#test-assert";
import { createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";
import { inboxContext, prefilledKeys } from "../test/inboxContext.ts";

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

const model = (name: string) => ({ name: `${name}.bpmn`, content: readFileSync(`resources/processes/${name}.bpmn`, "utf8"), contentType: "text/xml" });

test("a repeat implement-cell escalation opens blank — the previous resolution/answer is not prefilled (#915)", async () => {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([model("implement-cell"), model("human-escalation")]);
  const answersSeen: unknown[] = [];
  await engine.registerWorker("senior:feature", (job) => {
    answersSeen.push((job as { variables: Record<string, unknown> }).variables.answer);
    return { status: "blocked-needs-human", question: "Which API?" };
  });
  await engine.registerWorker("pr.reconcile-implement", () => ({ reconciled: false, retry: false }));
  await engine.registerWorker("pr.record-feature-escalation", () => ({}));
  await engine.registerWorker("pr.record-feature-implementing", () => ({}));
  await engine.createInstance({
    processDefinitionId: "implement-cell",
    awaitCompletion: false,
    variables: { task: { id: "t1", prompt: "Build it." }, agentSlaTimeout: "PT1H", escalationSlaTimeout: "PT1H", status: null, answer: null, question: null },
  });
  const openEscalation = async () => {
    const rows = (await engine.openUserTasks()).filter((t) => t.elementId === "escalation");
    assertEquals(rows.length, 1, "exactly one escalation task is open");
    return rows[0];
  };
  const first = await openEscalation();
  await engine.completeUserTask(first.userTaskKey, { resolution: "answer", answer: "Use the v2 API." });
  assertEquals(answersSeen[1], "Use the v2 API.", "the answer still reaches the re-run agent");
  const second = await openEscalation();
  assert(second.userTaskKey !== first.userTaskKey, "a second escalation opened");
  const pik = String(second.processInstanceKey);
  assertEquals(await prefilledKeys(engine, pik, ["resolution", "answer"]), [], "no stale form output prefilled");
  assertEquals((await inboxContext(engine, pik)).question, "Which API?", "the intended question is still shown");
});
