// Red/green regression for issue #806 — the convergence loop must not re-escalate an already-answered
// `wait-answer` question. When a durable adjudication exists for (this PR, this question fingerprint),
// the poller (`pollUserTasks`) auto-resumes the parked `wait-answer` with the recorded answer through
// the SAME `completeEscalationAsHuman` door a human uses — attributed to the prior adjudicator —
// instead of re-parking a human (PR #800 / proc 46310: the same design question escalated at round 2
// and again at round 13, both answered identically).
//
// A materially different question (no matching adjudication) still escalates normally.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { questionFingerprint } from "./github.ts";
import { pollUserTasks } from "./service.ts";

// biome-ignore lint/suspicious/noExplicitAny: in-memory table double, mirrors pollUserTasks.test.ts
function memData(seed: Record<string, any[]> = {}): { data: DataLayer; stores: Record<string, any[]> } {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const stores: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) stores[k] = v.map((r) => ({ ...r }));
  function tbl(name: string, pk = "id") {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const rows = (stores[name] ??= [] as any[]);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async insert(r: any) {
        rows.push({ ...r });
        return r[pk];
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async delete(id: any) {
        const i = rows.findIndex((r) => r[pk] === id);
        if (i >= 0) rows.splice(i, 1);
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as unknown as DataLayer;
  return { data, stores };
}

type FakeTask = { userTaskKey: string; elementId: string; processInstanceKey: string };

/** A fake engine backing BOTH the poller's per-instance `openUserTasks({processInstanceKey})` scan AND
 *  the `completeEscalationAsHuman` door's unfiltered `openUserTasks()` resolve. `completeUserTask`
 *  removes the task (a resumed task is no longer open) and records the completion for assertions. */
function fakeEngine(tasks: FakeTask[]) {
  const open = tasks.slice();
  const completions: { userTaskKey: string; variables: Record<string, unknown> }[] = [];
  const engine = {
    openUserTasks: (filter?: { processInstanceKey?: string; rootProcessInstanceKey?: string }) =>
      Promise.resolve(
        open.filter((t) => {
          if (filter?.processInstanceKey) return t.processInstanceKey === filter.processInstanceKey;
          if (filter?.rootProcessInstanceKey) return t.processInstanceKey === filter.rootProcessInstanceKey;
          return true;
        }),
      ),
    completeUserTask: (userTaskKey: string, variables: Record<string, unknown>) => {
      const i = open.findIndex((t) => t.userTaskKey === userTaskKey);
      if (i < 0) return Promise.reject(new Error("no such open task"));
      open.splice(i, 1);
      completions.push({ userTaskKey, variables });
      return Promise.resolve();
    },
  } as unknown as EngineClient;
  return { engine, completions };
}

test("pollUserTasks: auto-resumes an already-answered wait-answer instead of re-parking a human (#806)", async () => {
  const question = "Should the timeout be a boundary event or a poller sentinel?";
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#800", status: "escalated", process_key: "rp-800", url: "https://github.com/o/r/pull/800", title: "Converge" }],
    escalations: [{ id: 1, pr_key: "o/r#800", status: "open", question }],
    pr_adjudications: [
      {
        id: 1,
        pr_key: "o/r#800",
        // Whitespace/case variant — the canonical fingerprint normalises it to the same key.
        question_fingerprint: questionFingerprint(`  ${question.toUpperCase()}  `),
        answer: "Option A: a bounded boundary event.",
        adjudicated_by: "alice",
        adjudicated_at: "2025-01-01T00:00:00.000Z",
      },
    ],
  });
  const { engine, completions } = fakeEngine([{ userTaskKey: "ut-800", elementId: "wait-answer", processInstanceKey: "rp-800" }]);

  await pollUserTasks(data, engine);

  assertEquals(completions.length, 1, "the parked wait-answer is auto-resumed");
  assertEquals(completions[0].userTaskKey, "ut-800");
  assertEquals(completions[0].variables.answer, "Option A: a bounded boundary event.", "resumed with the recorded answer");
  assertEquals((stores.user_tasks ?? []).length, 0, "no wait-answer row is projected — the human is NOT re-parked");
  const ledger = stores.task_completions ?? [];
  assertEquals(ledger.length, 1, "the auto-resume is recorded in the completion ledger");
  assertEquals(ledger[0].actor_id, "alice", "attributed to the prior adjudicator");
  assertEquals(ledger[0].actor_kind, "human", "the prior adjudicator's kind is preserved (a human-settled decision)");
  assertEquals(ledger[0].auto_applied, 1, "the replay is marked auto_applied — distinguishable from a first-hand submission");
  assertEquals(ledger[0].reversible, 1, "an auto-applied replay is human-overridable");
});

test("pollUserTasks: auto-resume PRESERVES an agent adjudicator's kind and stays reversible (#806 review)", async () => {
  // A prior AGENT-settled adjudication (ADR 0046) must replay as an agent completion, never laundered
  // into an irreversible human authority — the whole point of recording `adjudicated_kind`.
  const question = "Which retry cap should the husk loop use?";
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#801", status: "escalated", process_key: "rp-801", url: "https://github.com/o/r/pull/801", title: "Converge" }],
    escalations: [{ id: 1, pr_key: "o/r#801", status: "open", question }],
    pr_adjudications: [
      {
        id: 1,
        pr_key: "o/r#801",
        question_fingerprint: questionFingerprint(question),
        answer: "Cap at 3.",
        adjudicated_by: "senior-agent",
        adjudicated_kind: "agent",
        adjudicated_at: "2025-01-01T00:00:00.000Z",
      },
    ],
  });
  const { engine, completions } = fakeEngine([{ userTaskKey: "ut-801", elementId: "wait-answer", processInstanceKey: "rp-801" }]);

  await pollUserTasks(data, engine);

  assertEquals(completions.length, 1, "the parked wait-answer is auto-resumed");
  const ledger = stores.task_completions ?? [];
  assertEquals(ledger[0].actor_kind, "agent", "the agent adjudicator's kind is preserved — not laundered into a human");
  assertEquals(ledger[0].actor_id, "senior-agent");
  assertEquals(ledger[0].auto_applied, 1, "still marked auto_applied");
  assertEquals(ledger[0].reversible, 1, "still reversible — a human may override the replayed agent answer");
});

test("pollUserTasks: a DIFFERENT question with no adjudication still escalates to a human (#806)", async () => {
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#800", status: "escalated", process_key: "rp-800", url: "https://github.com/o/r/pull/800", title: "Converge" }],
    escalations: [{ id: 1, pr_key: "o/r#800", status: "open", question: "A brand-new question nobody has answered." }],
    pr_adjudications: [
      {
        id: 1,
        pr_key: "o/r#800",
        question_fingerprint: questionFingerprint("Some other, already-settled question."),
        answer: "Prior answer.",
        adjudicated_by: "alice",
        adjudicated_at: "2025-01-01T00:00:00.000Z",
      },
    ],
  });
  const { engine, completions } = fakeEngine([{ userTaskKey: "ut-800", elementId: "wait-answer", processInstanceKey: "rp-800" }]);

  await pollUserTasks(data, engine);

  assertEquals(completions.length, 0, "no auto-resume — the question is materially different");
  const rows = stores.user_tasks ?? [];
  assertEquals(rows.length, 1, "the new question is projected for a human to answer");
  assertEquals(rows[0].user_task_key, "ut-800");
  assertEquals(rows[0].question, "A brand-new question nobody has answered.");
});

test("pollUserTasks: an adjudication with UNKNOWN provenance fails open to a human, not a synthetic actor (#806 review)", async () => {
  // A settled row whose `adjudicated_by` is blank (completed out of band, so `latestAdjudicator`
  // returned no actor) must NOT be auto-replayed as a manufactured `human` actor — that would audit an
  // unknown-provenance replay as a first-hand human decision. It fails open to a fresh human task.
  const question = "Should the cache be write-through or write-back?";
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#802", status: "escalated", process_key: "rp-802", url: "https://github.com/o/r/pull/802", title: "Converge" }],
    escalations: [{ id: 1, pr_key: "o/r#802", status: "open", question }],
    pr_adjudications: [
      {
        id: 1,
        pr_key: "o/r#802",
        question_fingerprint: questionFingerprint(question),
        answer: "Write-through.",
        adjudicated_by: null,
        adjudicated_kind: null,
        adjudicated_at: "2025-01-01T00:00:00.000Z",
      },
    ],
  });
  const { engine, completions } = fakeEngine([{ userTaskKey: "ut-802", elementId: "wait-answer", processInstanceKey: "rp-802" }]);

  await pollUserTasks(data, engine);

  assertEquals(completions.length, 0, "no auto-resume — a synthetic human actor is never manufactured");
  const rows = stores.user_tasks ?? [];
  assertEquals(rows.length, 1, "the question projects for a human to answer (fail-open)");
  assertEquals(rows[0].user_task_key, "ut-802");
});

test("pollUserTasks: a transient adjudication-lookup error fails open and never aborts the pass (#806 review)", async () => {
  // The adjudication LOOKUP is inside the fail-open try, so a transient `pr_adjudications.find` error
  // must NOT reject `project`/abort `pollUserTasks` — the task still projects and reaches a human.
  const question = "Should retries be capped?";
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#803", status: "escalated", process_key: "rp-803", url: "https://github.com/o/r/pull/803", title: "Converge" }],
    escalations: [{ id: 1, pr_key: "o/r#803", status: "open", question }],
  });
  const base = data.table.bind(data);
  const failing = {
    table(name: string, pk?: string) {
      const t = base(name, pk);
      if (name === "pr_adjudications") {
        return { ...t, find: () => Promise.reject(new Error("transient db error")) };
      }
      return t;
    },
  } as unknown as DataLayer;
  const { engine, completions } = fakeEngine([{ userTaskKey: "ut-803", elementId: "wait-answer", processInstanceKey: "rp-803" }]);

  await pollUserTasks(failing, engine);

  assertEquals(completions.length, 0, "no auto-resume on a lookup error");
  const rows = stores.user_tasks ?? [];
  assertEquals(rows.length, 1, "the task still projects — the poller did not abort (fail-open)");
  assertEquals(rows[0].user_task_key, "ut-803");
});
