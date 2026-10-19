// Behaviour of the committed issue-triage model (issue #896), driven on the in-process WASM engine
// with stub workers: the repeating TIMER start fires a tick per day; an idle tick ends at the first
// gateway; a busy tick dispatches the agent, applies, and parks on the batched human review only when
// something was escalated; the agent SLA boundary bounds a stuck agent.
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";

const MODEL = readFileSync("resources/processes/issue-triage.bpmn", "utf8");
const DAY_MS = 24 * 60 * 60 * 1000;

type Output = Record<string, unknown>;
const engines: WasmEngineClient[] = [];
after(async () => {
  for (const e of engines) await e.close?.();
});

interface Calls {
  collect: number;
  agent: number;
  apply: number;
  review: Record<string, unknown>[];
  agentInput: Record<string, unknown>[];
}

/** Deploy the model with stub workers. `agent: null` registers no agent worker (the token parks there
 *  so the SLA boundary can fire). */
async function deploy(opts: { collect: Output; agent?: Output | null; apply?: Output }): Promise<{ engine: WasmEngineClient; calls: Calls }> {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([{ name: "issue-triage.bpmn", content: MODEL, contentType: "text/xml" }]);
  const calls: Calls = { collect: 0, agent: 0, apply: 0, review: [], agentInput: [] };
  await engine.registerWorker("pr.issue-triage-collect", () => {
    calls.collect++;
    return opts.collect;
  });
  if (opts.agent !== null) {
    await engine.registerWorker("senior:issue-triage", (job) => {
      calls.agent++;
      calls.agentInput.push((job as { variables: Record<string, unknown> }).variables);
      return opts.agent ?? { proposals: "[]" };
    });
  }
  await engine.registerWorker("pr.issue-triage-apply", () => {
    calls.apply++;
    return opts.apply ?? { appliedCount: 0, escalatedCount: 0, rejectedCount: 0 };
  });
  await engine.registerWorker("pr.issue-triage-review", (job) => {
    calls.review.push((job as { variables: Record<string, unknown> }).variables);
    return {};
  });
  return { engine, calls };
}

const busy = { candidateCount: 1, candidates: ['{"repo":"o/r","issue":1}'], agentSlaTimeout: "PT30M" };

test("the timer start fires one tick per day; an idle tick ends without dispatching the agent", async () => {
  const { engine, calls } = await deploy({ collect: { candidateCount: 0, candidates: [], agentSlaTimeout: "PT30M", skippedReason: "disabled" } });
  assertEquals(calls.collect, 0);
  await engine.advanceTime(DAY_MS + 1000);
  assertEquals(calls.collect, 1);
  await engine.advanceTime(DAY_MS);
  assertEquals(calls.collect, 2);
  assertEquals(calls.agent, 0);
  assertEquals(calls.apply, 0);
});

test("a tick with candidates runs agent then apply, and ends without review when nothing escalated", async () => {
  const { engine, calls } = await deploy({ collect: busy, agent: { proposals: "[]" }, apply: { appliedCount: 1, escalatedCount: 0, rejectedCount: 0 } });
  await engine.advanceTime(DAY_MS + 1000);
  assertEquals(calls.agent, 1);
  assertEquals(calls.agentInput[0]?.candidates, busy.candidates);
  assertEquals(calls.apply, 1);
  assertEquals((await engine.searchUserTasks({})).filter((t) => t.elementId === "issue-triage-review").length, 0);
});

test("escalated proposals park on one batched human review, whose decision reaches the review worker", async () => {
  const { engine, calls } = await deploy({ collect: busy, agent: { proposals: "[]" }, apply: { appliedCount: 0, escalatedCount: 2, rejectedCount: 0 } });
  await engine.advanceTime(DAY_MS + 1000);
  const tasks = (await engine.searchUserTasks({})).filter((t) => t.elementId === "issue-triage-review");
  assertEquals(tasks.length, 1);
  assertEquals(calls.review.length, 0);
  const task = tasks[0];
  assert(task);
  await engine.completeUserTask(task.userTaskKey, { decision: "apply", note: "looks right" });
  await engine.advanceTime(1);
  assertEquals(calls.review.length, 1);
  assertEquals(calls.review[0]?.decision, "apply");
  assertEquals(calls.review[0]?.note, "looks right");
});

test("the agent SLA boundary ends a tick whose agent never completes (apply never runs)", async () => {
  const { engine, calls } = await deploy({ collect: busy, agent: null });
  await engine.advanceTime(DAY_MS + 1000);
  assertEquals(calls.collect, 1);
  await engine.advanceTime(31 * 60 * 1000);
  assertEquals(calls.apply, 0);
  const active = await engine.searchProcessInstances({ processDefinitionId: "issue-triage", state: "ACTIVE" });
  assertEquals(active.length, 0);
});
