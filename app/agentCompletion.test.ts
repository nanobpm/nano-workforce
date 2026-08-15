// Red/green unit coverage for the agent-answerable escalation completer (epic #156, slice U6;
// ADR 0046). Drives the canonical attributed completer + the agent/revert entry points against an
// in-memory data layer and a stub engine, asserting the three things U6 promises:
//
//   1. an AGENT assignee completes the SAME typed form a human would — the engine `completeUserTask`
//      is called with the EXACT variables (no parallel path), and the process resume is driven;
//   2. attribution is recorded — a `task_completions` ledger row captures actor_kind=agent + the
//      agent id + the submitted variables;
//   3. the completion is reversible — a human can revert an agent completion (recording who + when),
//      while a human completion is NOT reversible and a completion can be reverted only once.
//
// The taxonomy/spine slices proved the form + resume round-trip end to end (the e2e does too, on the
// real process); this suite pins the host-side attribution + reversibility contract in isolation.

import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "#test-assert";
import {
  completeEscalationAsAgent,
  completeEscalationAsHuman,
  completeUserTaskAttributed,
  latestCompletion,
  revertAgentCompletion,
  type TaskCompletion,
  validateEscalationVariables,
} from "./agentCompletion.ts";

/** A minimal in-memory `Table<T>`: AUTOINCREMENT ids on insert, structural `find`, `get`, `update`. */
function memTable(rows: any[], key: string) {
  let seq = rows.reduce((m, r) => Math.max(m, Number(r[key]) || 0), 0);
  return {
    insert: (row: any) => {
      const id = ++seq;
      const stored = key === "id" ? { ...row, id } : { ...row };
      rows.push(stored);
      return Promise.resolve(key === "id" ? id : stored[key]);
    },
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k)),
    find: (q: any = {}) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any = {}) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r ? 1 : 0);
    },
    delete: (k: any) => {
      const i = rows.findIndex((r) => r[key] === k);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve(i >= 0 ? 1 : 0);
    },
    count: (q: any = {}) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)).length),
    all: () => Promise.resolve(rows.slice()),
  };
}

function memData(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
}

/** A stub engine recording every `completeUserTask`, with a seeded set of open user tasks. */
function fakeEngine(openTasks: Array<{ userTaskKey: string; elementId?: string }>) {
  const completed: Array<{ userTaskKey: string; variables?: Record<string, unknown> }> = [];
  const engine = {
    searchUserTasks: (_filter?: Record<string, unknown>) => Promise.resolve(openTasks),
    completeUserTask: (userTaskKey: string, variables?: Record<string, unknown>) => {
      completed.push({ userTaskKey, variables });
      return Promise.resolve();
    },
  } as any;
  return { engine, completed };
}

test("agent completion resumes with the exact typed vars a human submits AND records agent attribution", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([
    { userTaskKey: "ut-1", elementId: "feature-escalation" },
  ]);

  const r = await completeEscalationAsAgent(data, engine, {
    userTaskKey: "ut-1",
    agentId: "senior:answer-bot",
    variables: { resolution: "answer", answer: "use v2" },
  });

  assertEquals(r.ok, true);
  assertEquals(r.elementId, "feature-escalation");

  // Same resume path a human drives: completeUserTask called with the identical typed variables.
  assertEquals(completed.length, 1);
  assertEquals(completed[0].userTaskKey, "ut-1");
  assertEquals(completed[0].variables, { resolution: "answer", answer: "use v2" });

  // Attribution recorded: an agent completion, its id, and the submitted variables.
  const row = stores.task_completions.rows[0] as TaskCompletion;
  assertEquals(row.actor_kind, "agent");
  assertEquals(row.actor_id, "senior:answer-bot");
  assertEquals(row.element_id, "feature-escalation");
  assertEquals(JSON.parse(row.variables_json), { resolution: "answer", answer: "use v2" });
  assertEquals(row.reversible, 1, "an agent completion is reversible");
  assertEquals(row.reverted, 0);
});

test("agent completer refuses a non-escalation user task (scoped to the migrated escalation tasks)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-x", elementId: "decide" }]);

  const r = await completeEscalationAsAgent(data, engine, {
    userTaskKey: "ut-x",
    agentId: "bot",
    variables: { decision: "approve" },
  });

  assertEquals(r.ok, false);
  assertEquals(r.reason, "not an escalation task");
  assertEquals(completed.length, 0, "a non-escalation task is never completed");
  assertEquals(stores.task_completions.rows.length, 0, "and no attribution row is written");
});

test("agent completer is a no-op for an unknown userTaskKey", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([
    { userTaskKey: "ut-1", elementId: "feature-escalation" },
  ]);

  const r = await completeEscalationAsAgent(data, engine, {
    userTaskKey: "ut-missing",
    agentId: "bot",
    variables: { resolution: "abandon" },
  });

  assertEquals(r.ok, false);
  assertEquals(r.reason, "no open escalation task");
  assertEquals(completed.length, 0);
});

test("a HUMAN operator completes a feature escalation via the SAME attributed resume path (issue #210)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-1", elementId: "feature-escalation" }]);

  const r = await completeEscalationAsHuman(data, engine, {
    userTaskKey: "ut-1",
    operatorId: "alice",
    variables: { resolution: "answer", answer: "use v2" },
  });

  assertEquals(r.ok, true);
  assertEquals(r.elementId, "feature-escalation");

  // Identical resume path to the agent/task-inbox: completeUserTask with the exact typed variables.
  assertEquals(completed.length, 1);
  assertEquals(completed[0].variables, { resolution: "answer", answer: "use v2" });

  // Attribution recorded as a HUMAN completion — the authority, so NOT reversible.
  const row = stores.task_completions.rows[0] as TaskCompletion;
  assertEquals(row.actor_kind, "human");
  assertEquals(row.actor_id, "alice");
  assertEquals(row.reversible, 0, "a human completion is the authority (not reversible)");
});

test("human completer refuses a non-escalation user task and is a no-op for an unknown key", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-x", elementId: "decide" }]);

  const notEsc = await completeEscalationAsHuman(data, engine, {
    userTaskKey: "ut-x",
    operatorId: "alice",
    variables: { resolution: "abandon" },
  });
  assertEquals(notEsc.ok, false);
  assertEquals(notEsc.reason, "not an escalation task");

  const missing = await completeEscalationAsHuman(data, engine, {
    userTaskKey: "ut-missing",
    operatorId: "alice",
    variables: { resolution: "abandon" },
  });
  assertEquals(missing.ok, false);
  assertEquals(missing.reason, "no open escalation task");

  assertEquals(completed.length, 0, "neither refusal completes a task");
  assertEquals(stores.task_completions.rows.length, 0, "and no attribution row is written");
});

test("a human can revert/override an agent completion (recording who + when + corrective note)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine } = fakeEngine([{ userTaskKey: "ut-1", elementId: "feature-escalation" }]);

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey: "ut-1", elementId: "feature-escalation", variables: { resolution: "answer", answer: "guess" } },
    { kind: "agent", id: "bot" },
  );

  const r = await revertAgentCompletion(data, completionId, { kind: "human", id: "alice" }, "wrong — use v3");
  assertEquals(r.ok, true);

  const row = (await latestCompletion(data, "ut-1"))!;
  assertEquals(row.reverted, 1);
  assertEquals(row.reverted_by, "alice");
  assertEquals(row.reverted_note, "wrong — use v3", "the human's correction is captured");
  assert(typeof row.reverted_at === "string" && row.reverted_at.length > 0, "reverted_at is stamped");
});

test("the ledger rolls back when the engine completion fails (never claims a completion that did not happen)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const engine = {
    searchUserTasks: () => Promise.resolve([{ userTaskKey: "ut-1", elementId: "feature-escalation" }]),
    completeUserTask: () => Promise.reject(new Error("engine rejected the completion")),
  } as any;

  let threw: unknown;
  try {
    await completeUserTaskAttributed(
      data,
      engine,
      { userTaskKey: "ut-1", elementId: "feature-escalation", variables: { resolution: "answer", answer: "x" } },
      { kind: "agent", id: "bot" },
    );
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error && /engine rejected/.test(threw.message), "the engine failure propagates");
  assertEquals(stores.task_completions.rows.length, 0, "the attribution row was rolled back on failure");
});

test("a human completion is NOT reversible (it is already the authority)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine } = fakeEngine([{ userTaskKey: "ut-2", elementId: "plan-review-decision" }]);

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey: "ut-2", elementId: "plan-review-decision", variables: { directive: "proceed", notes: "" } },
    { kind: "human", id: "operator" },
  );

  const stored = (await latestCompletion(data, "ut-2"))!;
  assertEquals(stored.reversible, 0);

  const r = await revertAgentCompletion(data, completionId, { kind: "human", id: "bob" });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "completion is not reversible");
});

test("an agent completion can be reverted only once", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine } = fakeEngine([{ userTaskKey: "ut-3", elementId: "trial-merge-decision" }]);

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey: "ut-3", elementId: "trial-merge-decision", variables: { action: "proceed" } },
    { kind: "agent", id: "bot" },
  );

  assertEquals((await revertAgentCompletion(data, completionId, { kind: "human", id: "alice" })).ok, true);
  const second = await revertAgentCompletion(data, completionId, { kind: "human", id: "bob" });
  assertEquals(second.ok, false);
  assertEquals(second.reason, "completion already reverted");
});

test("reverting an unknown completion id is a no-op", async () => {
  const data = memData({ task_completions: { rows: [], key: "id" } });
  const r = await revertAgentCompletion(data, 999, { kind: "human", id: "alice" });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "no such completion");
});

test("only a human may revert a completion (an agent identity cannot weaken the audit trail)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine } = fakeEngine([{ userTaskKey: "ut-4", elementId: "feature-escalation" }]);

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey: "ut-4", elementId: "feature-escalation", variables: { resolution: "answer", answer: "x" } },
    { kind: "agent", id: "bot" },
  );

  const r = await revertAgentCompletion(data, completionId, { kind: "agent", id: "other-bot" });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "only a human may revert a completion");

  const row = (await latestCompletion(data, "ut-4"))!;
  assertEquals(row.reverted, 0, "the completion is left un-reverted when a non-human attempts it");
});

test("the attributed completer normalizes keys and rejects blank attribution", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-5", elementId: "feature-escalation" }]);

  // Whitespace around the key + actor id is trimmed before it reaches the ledger and the engine.
  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey: "  ut-5  ", elementId: "feature-escalation", variables: { resolution: "answer", answer: "x" } },
    { kind: "agent", id: "  bot  " },
  );
  assert(completionId > 0);
  assertEquals(completed[0].userTaskKey, "ut-5", "the engine is completed with the trimmed key");
  const row = stores.task_completions.rows[0] as TaskCompletion;
  assertEquals(row.user_task_key, "ut-5");
  assertEquals(row.actor_id, "bot");

  // A blank key / actor id is rejected upfront — the ledger never records blank attribution.
  await assertRejects(() =>
    completeUserTaskAttributed(
      data,
      engine,
      { userTaskKey: "   ", variables: {} },
      { kind: "human", id: "operator" },
    ),
  );
  await assertRejects(() =>
    completeUserTaskAttributed(
      data,
      engine,
      { userTaskKey: "ut-5", variables: {} },
      { kind: "human", id: "  " },
    ),
  );
  assertEquals(stores.task_completions.rows.length, 1, "no ledger row is written for a rejected completion");
});

test("a rollback failure never masks the original engine error", async () => {
  const engine = {
    searchUserTasks: () => Promise.resolve([{ userTaskKey: "ut-6", elementId: "feature-escalation" }]),
    completeUserTask: () => Promise.reject(new Error("engine rejected the completion")),
  } as any;

  // A data layer whose ledger delete (the rollback) also throws — the engine error must still win.
  const data = {
    table: () => ({
      insert: () => Promise.resolve(1),
      delete: () => Promise.reject(new Error("ledger delete failed")),
    }),
  } as any;

  let threw: unknown;
  try {
    await completeUserTaskAttributed(
      data,
      engine,
      { userTaskKey: "ut-6", elementId: "feature-escalation", variables: { resolution: "answer", answer: "x" } },
      { kind: "agent", id: "bot" },
    );
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof Error && /engine rejected/.test(threw.message),
    "the engine failure propagates, not the rollback failure",
  );
});

test("latestCompletion returns the newest row by id regardless of insertion order", async () => {
  const stores = {
    task_completions: {
      rows: [
        { id: 3, user_task_key: "ut-x", actor_kind: "agent", actor_id: "bot", variables_json: "{}", reversible: 1, reverted: 0, created_at: "t3" },
        { id: 1, user_task_key: "ut-x", actor_kind: "human", actor_id: "alice", variables_json: "{}", reversible: 0, reverted: 0, created_at: "t1" },
        { id: 2, user_task_key: "ut-other", actor_kind: "agent", actor_id: "bot", variables_json: "{}", reversible: 1, reverted: 0, created_at: "t2" },
      ] as any[],
      key: "id",
    },
  };
  const data = memData(stores);

  const newest = (await latestCompletion(data, "ut-x"))!;
  assertEquals(newest.id, 3, "the highest-id row for the key wins, not the first found");
  assertEquals(stores.task_completions.rows[0].id, 3, "the backing array is not reordered");
});

// --- Form-contract enforcement (issue #236 review advisory): a completion must satisfy the linked
// `.form`'s required-field + select allowed-value contract BEFORE the engine resumes, so a missing or
// invalid decision can never park the process in an invalid state. Derived from the canonical `.form`,
// exercised through BOTH completers so agent and human paths reject invalid input identically.

test("completer rejects a completion missing a required form field (no engine resume, no ledger row)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-1", elementId: "wait-answer" }]);

  const r = await completeEscalationAsHuman(data, engine, {
    userTaskKey: "ut-1",
    operatorId: "alice",
    variables: { answer: "   " }, // required, but blank
  });

  assertEquals(r.ok, false);
  assert(String(r.reason).includes("answer"), "the reason names the missing required field");
  assertEquals(completed.length, 0, "an invalid completion never resumes the process");
  assertEquals(stores.task_completions.rows.length, 0, "and no attribution row is written");
});

test("completer rejects a select value outside the form's allowed set", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-2", elementId: "trial-merge-decision" }]);

  const r = await completeEscalationAsAgent(data, engine, {
    userTaskKey: "ut-2",
    agentId: "bot",
    variables: { action: "explode" }, // not one of proceed/rebase/abandon
  });

  assertEquals(r.ok, false);
  assert(String(r.reason).includes("action"), "the reason names the invalid select field");
  assertEquals(completed.length, 0, "an out-of-range decision never resumes the process");
});

test("completer accepts variables that satisfy the form contract (required present + allowed value)", async () => {
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-3", elementId: "plan-review-decision" }]);

  const r = await completeEscalationAsHuman(data, engine, {
    userTaskKey: "ut-3",
    operatorId: "alice",
    variables: { directive: "revise", notes: "narrow scope" },
  });

  assertEquals(r.ok, true);
  assertEquals(completed.length, 1, "a contract-valid completion resumes the process");
  assertEquals(completed[0].variables, { directive: "revise", notes: "narrow scope" });
});

test("validateEscalationVariables derives its contract from the canonical .form files", async () => {
  // wait-answer -> pr-escalation.form (answer required)
  assertEquals(validateEscalationVariables("wait-answer", { answer: "ok" }), null);
  assert(validateEscalationVariables("wait-answer", {}) !== null);
  // trial-merge-decision -> action required, allowed proceed/rebase/abandon
  assertEquals(validateEscalationVariables("trial-merge-decision", { action: "abandon" }), null);
  assert(validateEscalationVariables("trial-merge-decision", { action: "nope" }) !== null);
  // plan-review-decision -> directive required, allowed proceed/revise
  assertEquals(validateEscalationVariables("plan-review-decision", { directive: "proceed" }), null);
  assert(validateEscalationVariables("plan-review-decision", { directive: "" }) !== null);
  // an element with no linked form contract is not enforced
  assertEquals(validateEscalationVariables("some-other-task", { whatever: 1 }), null);
});
