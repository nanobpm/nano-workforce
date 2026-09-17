// Red/green regression for pr.answer-escalation (Copilot review of PR #180).
//
// The review-loop escalation migrated from a message catch to a native `wait-answer` userTask.
// Completing the task resumes the token, but nothing retired the durable `escalations` audit row —
// so it stayed `status="open"` with a null `answer`/`answered_at` forever, both losing the Q&A
// trail and (since `activePrs` derives `openEscalation` from that row) surfacing a phantom open
// escalation on `/status` after it was answered. `pr.answer-escalation` runs on `wait-answer`
// completion and must transition the latest open row to `answered`, recording the submitted answer.
//
// It must ALSO move the `pull_requests` row off `status="escalated"` back to `"converging"`, exactly
// (the single reconcile step both the review and merge loops run). Otherwise the PR stays `escalated` (with
// a now-null `openEscalation`) until the re-entered round's `persist-round` runs — an inconsistent
// `/status` window and a divergence from the merge loop the two paths are meant to share.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { questionFingerprint } from "../app/github.ts";
import handler from "../workers/answer-escalation/worker.ts";

function fakeApp(escalationRows: Record<string, unknown>[], prRows: Record<string, unknown>[] = []) {
  const updates: { key: unknown; patch: Record<string, unknown> }[] = [];
  const prUpdates: { key: unknown; patch: Record<string, unknown> }[] = [];
  const adjudications: Record<string, unknown>[] = [];
  const completions: Record<string, unknown>[] = [];
  // Emulates ONLY the two guarded statements `recordAdjudication` issues via `data.open().exec` — the
  // generation-fenced conditional INSERT and the blank→known compare-and-set UPDATE — over the same
  // in-memory `adjudications`/`prRows` arrays the `table()` double reads. (The guard SQL itself is
  // validated end-to-end against real SQLite in app/adjudications.test.ts; here it need only persist so
  // these worker tests can assert the attribution `latestAdjudicator` computes.)
  const generationAllows = (prKey: unknown, expectedKey: unknown): boolean =>
    !prRows.some((r) => r.pr_key === prKey && r.process_key != null && r.process_key !== expectedKey);
  const exec = async (sql: string, params: unknown[] = []) => {
    const fenced = sql.includes("NOT EXISTS");
    if (/^\s*INSERT INTO "pr_adjudications"/.test(sql)) {
      const [pr_key, question_fingerprint, answer, adjudicated_by, adjudicated_kind, adjudicated_at] = params;
      if (fenced && !generationAllows(params[6], params[7])) return { changed: 0 };
      if (adjudications.some((r) => r.pr_key === pr_key && r.question_fingerprint === question_fingerprint)) {
        throw new Error("UNIQUE constraint failed: pr_adjudications.pr_key, pr_adjudications.question_fingerprint");
      }
      adjudications.push({ id: adjudications.length + 1, pr_key, question_fingerprint, answer, adjudicated_by, adjudicated_kind, adjudicated_at });
      return { changed: 1 };
    }
    if (/UPDATE "pr_adjudications"/.test(sql)) {
      const [answer, adjudicated_by, adjudicated_kind, adjudicated_at, id] = params;
      if (fenced && !generationAllows(params[5], params[6])) return { changed: 0 };
      const row = adjudications.find((r) => r.id === id);
      const priorBy = typeof row?.adjudicated_by === "string" ? row.adjudicated_by.trim() : row?.adjudicated_by;
      if (!row || (priorBy !== null && priorBy !== undefined && priorBy !== "")) return { changed: 0 };
      Object.assign(row, { answer, adjudicated_by, adjudicated_kind, adjudicated_at });
      return { changed: 1 };
    }
    throw new Error(`unexpected exec sql: ${sql}`);
  };
  const app = {
    data: {
      open() {
        return { exec };
      },
      table(name: string, _key: string) {
        if (name === "pull_requests") {
          return {
            async find(where: Record<string, unknown>) {
              return prRows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
            },
            async update(key: unknown, patch: Record<string, unknown>) {
              prUpdates.push({ key, patch });
            },
          };
        }
        if (name === "pr_adjudications") {
          return {
            async find(where: Record<string, unknown>) {
              return adjudications.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
            },
            async insert(r: Record<string, unknown>) {
              adjudications.push({ id: adjudications.length + 1, ...r });
              return adjudications.length;
            },
            async update(id: number, patch: Record<string, unknown>) {
              const row = adjudications.find((r) => r.id === id);
              if (row) Object.assign(row, patch);
            },
          };
        }
        if (name === "task_completions") {
          return {
            async find(where: Record<string, unknown>) {
              return completions.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
            },
          };
        }
        if (name !== "escalations") throw new Error(`unexpected table ${name}`);
        return {
          async find(where: Record<string, unknown>) {
            return escalationRows.filter((r) =>
              Object.entries(where).every(([k, v]) => r[k] === v)
            );
          },
          async update(key: unknown, patch: Record<string, unknown>) {
            updates.push({ key, patch });
          },
        };
      },
    },
  };
  return { app, updates, prUpdates, adjudications, completions };
}

test("retires the latest open escalation to answered with the submitted answer", async () => {
  const rows = [
    { id: 5, pr_key: "o/r#1", status: "answered", question: "old" },
    { id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" },
  ];
  const { app, updates, prUpdates } = fakeApp(rows);
  const job = { variables: { prKey: "o/r#1", answer: "  Cap at 5.  " } };
  await handler(job as any, app as any);
  assertEquals(updates.length, 1, "exactly the one open row is retired");
  assertEquals(updates[0].key, 7, "the newest open row (not the already-answered one) is retired");
  assertEquals(updates[0].patch.status, "answered");
  assertEquals(updates[0].patch.answer, "Cap at 5.", "the answer is trimmed and recorded");
  assertEquals(typeof updates[0].patch.answered_at, "string", "answered_at is stamped");
  assertEquals(prUpdates.length, 1, "the PR row is moved off `escalated`");
  assertEquals(prUpdates[0].key, "o/r#1", "the PR keyed by prKey is updated");
  assertEquals(prUpdates[0].patch.status, "converging", "answered escalation returns the PR to converging");
  assertEquals(typeof prUpdates[0].patch.updated_at, "string", "updated_at is stamped");
});

test("retires ALL open rows: newest answered, any duplicate open rows marked stale", async () => {
  // `pr.persist-escalation` always INSERTs a new open row, so a retry/duplicate activation can
  // leave more than one `status="open"` row for the same PR. Answering only the newest would leave
  // an older open row behind — a phantom that keeps `activePrs` deriving an open escalation while
  // the PR is still `escalated`. Every open row for the PR must leave `open` in this completion.
  const rows = [
    { id: 3, pr_key: "o/r#1", status: "open", question: "stale dup A" },
    { id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" },
    { id: 9, pr_key: "o/r#2", status: "open", question: "other PR — untouched" },
  ];
  const { app, updates, prUpdates } = fakeApp(rows);
  const job = { variables: { prKey: "o/r#1", answer: "Cap at 5." } };
  await handler(job as any, app as any);
  assertEquals(updates.length, 2, "both open rows for this PR are retired; the other PR is untouched");
  const answered = updates.find((u) => u.key === 7);
  const stale = updates.find((u) => u.key === 3);
  assertEquals(answered?.patch.status, "answered", "the newest open row is answered");
  assertEquals(answered?.patch.answer, "Cap at 5.", "the answer is recorded on the newest row");
  assertEquals(stale?.patch.status, "stale", "the older duplicate open row is marked stale");
  assertEquals(prUpdates.length, 1, "the PR row is moved off `escalated` exactly once");
  assertEquals(prUpdates[0].patch.status, "converging");
});

test("no open row is a no-op (idempotent re-completion)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "answered", question: "Which retry cap?" }];
  const { app, updates, prUpdates } = fakeApp(rows);
  const job = { variables: { prKey: "o/r#1", answer: "again" } };
  await handler(job as any, app as any);
  assertEquals(updates.length, 0, "nothing to retire when no escalation is open");
  assertEquals(prUpdates.length, 0, "no open row → PR status is left untouched");
});

test("a blank answer is recorded as NULL, not an empty string", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, updates } = fakeApp(rows);
  const job = { variables: { prKey: "o/r#1", answer: "   " } };
  await handler(job as any, app as any);
  assertEquals(updates[0].patch.answer, null);
  assertEquals(updates[0].patch.status, "answered");
});

// --- issue #806: persist the wait-answer adjudication so a re-derived identical question does not
// re-escalate. record-answer writes a durable (prKey, questionFingerprint) -> {answer, adjudicatedBy}
// row keyed by the canonical fingerprint, attributed to whoever just completed the task (the newest
// task_completions row this resume stamped for the process instance). ---

test("persists a durable adjudication of the answered question, attributed to the completer (#806)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // The resume's completion stamped a ledger row for this process instance (alice, a human, answered).
  completions.push({ id: 1, process_instance_key: "pi-1", user_task_key: "ut-1", element_id: "wait-answer", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1, "one durable adjudication row is written");
  assertEquals(adjudications[0].pr_key, "o/r#1");
  assertEquals(adjudications[0].question_fingerprint, questionFingerprint("Which retry cap?"), "keyed by the canonical fingerprint");
  assertEquals(adjudications[0].answer, "Cap at 5.");
  assertEquals(adjudications[0].adjudicated_by, "alice", "attributed to the completer from the ledger");
  assertEquals(adjudications[0].adjudicated_kind, "human", "the completer's kind is preserved from the ledger");
});

// --- Copilot review of #806: the attribution lookup must correlate with the completion that actually
// WON the user-task race, not the newest ledger row. Both canonical completers insert their row BEFORE
// calling completeUserTask, and the loser only removes its row AFTER the engine rejects it — so a
// higher-id LOSER row can be transiently present when record-answer runs. Choosing "newest" would
// persist/replay the loser's actor_kind against the winner's answer. Correlate on the winning answer. ---

test("attributes to the WINNING completion, not a transient higher-id loser row (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // The human (alice) WON — the engine resumed this token with her answer "Cap at 5.". A losing racer
  // (a poller auto-resume of a stale adjudication, attributed to an AGENT) inserted a HIGHER-id row
  // carrying a DIFFERENT answer, and has not yet rolled it back. "Newest" would wrongly pick the agent.
  completions.push({ id: 1, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  completions.push({ id: 2, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "senior-agent", actor_kind: "agent", variables_json: JSON.stringify({ answer: "Cap at 3." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1);
  assertEquals(adjudications[0].adjudicated_by, "alice", "attributed to the winner (matching answer), not the higher-id loser");
  assertEquals(adjudications[0].adjudicated_kind, "human", "the winner's kind is recorded, never the loser's");
});

test("no ledger row matches the winning answer → null adjudicator (fails open), never a wrong one (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // Only a stale loser row (a DIFFERENT answer) is present — the winning completion did not route
  // through the ledger. Attributing to the unrelated row would be wrong; record a null adjudicator so
  // the auto-resume gate fails open to a fresh human task instead.
  completions.push({ id: 1, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "senior-agent", actor_kind: "agent", variables_json: JSON.stringify({ answer: "Cap at 3." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1, "the adjudication is still recorded (a real convergence answer)");
  assertEquals(adjudications[0].adjudicated_by, null, "an uncorrelated winner records a null adjudicator");
  assertEquals(adjudications[0].adjudicated_kind, null, "no wrong kind is laundered in");
});

// --- Copilot review of #806: the legacy/out-of-band fallback (no `completedCompletionId`) selected the
// NEWEST candidate when several completions shared this task key AND answer. Without a completion id
// there is no evidence which row won, so the newest could be the LOSER. Attribute ONLY when exactly one
// candidate remains; otherwise fail open to a human. ---

test("an ambiguous same-answer fallback (>1 candidate, no completion id) fails open, never picks newest (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // Two completions on the SAME user_task_key with the IDENTICAL answer and NO carried completion id.
  // The higher-id row (an agent auto-resume loser not yet rolled back) is NOT provably the winner, so a
  // "newest" pick could attribute to the loser. With no disambiguating id the only safe answer is none.
  completions.push({ id: 50, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  completions.push({ id: 51, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "senior-agent", actor_kind: "agent", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1, "the adjudication is still recorded (a real convergence answer)");
  assertEquals(adjudications[0].adjudicated_by, null, "an ambiguous same-answer set records a null adjudicator, never the newest guess");
  assertEquals(adjudications[0].adjudicated_kind, null, "no wrong kind is laundered in");
});

// --- Copilot review of #806: the exact identity of the completion that resumed THIS wait-answer is

test("excludes an older round's same-answer completion; attributes by exact user-task identity (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // The CURRENT round's winner (alice) has a LOWER id than a delayed higher-id completion of a PRIOR
  // round's wait-answer (a different `user_task_key`) that recorded the SAME recurring answer. A
  // "newest matching answer" correlation would wrongly pick the higher-id intruder (the agent); the
  // exact `completedUserTaskKey` identity keeps attribution on this round's completion.
  completions.push({ id: 20, process_instance_key: "pi-1", user_task_key: "ut-current", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  completions.push({ id: 25, process_instance_key: "pi-1", user_task_key: "ut-prior", actor_id: "stale-agent", actor_kind: "agent", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-current" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1);
  assertEquals(adjudications[0].adjudicated_by, "alice", "attributed by exact user-task identity, not the higher-id same-answer prior-round row");
  assertEquals(adjudications[0].adjudicated_kind, "human", "the current round's completer kind is recorded");
});

// --- Copilot review of #806: when both racers submit the IDENTICAL answer on the SAME wait-answer,
// answer correlation cannot separate them and the higher-id row may be the LOSER. The resumed token
// carries `completedCompletionId` — the exact ledger id of the winning completion — so record-answer
// selects that exact row regardless of a same-answer loser's id. ---

test("attributes by exact completion id even when a same-answer loser has a higher id (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // Both racers submitted the SAME answer on the SAME user_task_key. The engine accepted the HUMAN
  // (ledger id 30); an agent auto-resume loser inserted a HIGHER-id row (31) with the identical answer
  // and has not yet rolled back. Answer + user-task correlation alone would pick the higher-id agent;
  // the carried `completedCompletionId` (30) pins attribution to the exact winning row.
  completions.push({ id: 30, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  completions.push({ id: 31, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "senior-agent", actor_kind: "agent", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1", completedCompletionId: 30 } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1);
  assertEquals(adjudications[0].adjudicated_by, "alice", "the exact winning completion id wins over a same-answer higher-id loser");
  assertEquals(adjudications[0].adjudicated_kind, "human");
});

test("a carried completion id that matches no ledger row → null adjudicator (fails open) (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  completions.push({ id: 30, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  // The carried id (99) matches nothing — never fall back to guessing another row.
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1", completedCompletionId: 99 } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1, "the adjudication is still recorded (a real convergence answer)");
  assertEquals(adjudications[0].adjudicated_by, null, "an unmatched completion id records a null adjudicator, never a wrong one");
});

test("carries no user-task identity → null adjudicator (fails open), never a guess (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // An out-of-band resume that did not stamp `completedUserTaskKey`. Even with a same-answer ledger row
  // present, we cannot EXACTLY identify this wait-answer's completion, so we fail open rather than guess.
  completions.push({ id: 1, process_instance_key: "pi-1", user_task_key: "ut-x", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1, "the adjudication is still recorded (a real convergence answer)");
  assertEquals(adjudications[0].adjudicated_by, null, "no carried identity → null adjudicator, never a guess");
  assertEquals(adjudications[0].adjudicated_kind, null);
});

// --- Copilot review of #806: this worker must reject a delayed/redelivered job from a SUPERSEDED
// process instance. `pull_requests.process_key` tracks the CURRENT loop instance; a re-submit (or the
// merge hand-off) reassigns it. A stale old-process job must NOT reinsert its adjudication after the
// fresh run's reset, nor answer the new run's open escalation. ---

test("no-ops a redelivered job from a superseded (non-current) process instance (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, updates, prUpdates, adjudications, completions } = fakeApp(rows, [
    { pr_key: "o/r#1", status: "escalated", process_key: "pi-current" },
  ]);
  // A stale completion from the OLD instance carries a matching identity + answer, but the PR's current
  // process is `pi-current`. The job is from `pi-stale`, so it must touch nothing.
  completions.push({ id: 1, process_instance_key: "pi-stale", user_task_key: "ut-old", actor_id: "ghost", actor_kind: "agent", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const job = { processInstanceKey: "pi-stale", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-old" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 0, "a superseded-process job never reinserts an adjudication after the reset");
  assertEquals(updates.length, 0, "it never answers the new run's open escalation");
  assertEquals(prUpdates.length, 0, "it never moves the PR row");
});

test("accepts a job whose process instance IS the PR's current process_key (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, updates, adjudications, completions } = fakeApp(rows, [
    { pr_key: "o/r#1", status: "escalated", process_key: "pi-1" },
  ]);
  completions.push({ id: 1, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1" } };
  await handler(job as any, app as any);
  assertEquals(updates.length, 1, "the current-process job is honoured");
  assertEquals(adjudications.length, 1, "and its adjudication is recorded");
  assertEquals(adjudications[0].adjudicated_by, "alice");
});

test("a blank answer records NO adjudication (not a replayable decision) (#806)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications } = fakeApp(rows);
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "   ", answerContext: "convergence" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 0);
});

// --- Copilot review of #806: this ONE worker services both loops (`record-answer` in the convergence
// loop AND `record-merge-answer` in the merge loop, #256). Only a CONVERGENCE answer may feed the
// convergence adjudication memory — a merge decision recorded here could be replayed for a later
// convergence `wait-answer` whose text happens to match, replaying a merge-context answer that was
// never a convergence adjudication. The originating step stamps `answerContext`. ---

test("a MERGE-loop answer is NOT recorded as a convergence adjudication (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Rebase or merge-commit?" }];
  const { app, adjudications, updates, prUpdates } = fakeApp(rows);
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Rebase.", answerContext: "merge" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 0, "a merge-context answer never contaminates the convergence adjudication memory");
  assertEquals(updates[0].patch.status, "answered", "the escalation row is still reconciled");
  assertEquals(prUpdates[0].patch.status, "converging", "the PR row is still moved off `escalated`");
});

test("an absent answerContext (legacy) is NOT recorded as a convergence adjudication (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications } = fakeApp(rows);
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5." } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 0, "only an explicit convergence context feeds the adjudication memory");
});

test("records the adjudication BEFORE the escalation row transitions off `open` (crash safety, #806 review)", async () => {
  // The suppressed advisory: if the adjudication insert happened AFTER the rows flip off `open`, a
  // crash in that window would lose the adjudication (a retry finds no open row and returns), so the
  // answered question could re-escalate after restart. Recording it FIRST + INSERT-if-absent makes a
  // retry re-record a no-op. Assert the ordering by capturing when each write ran.
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const order: string[] = [];
  const adjudications: Record<string, unknown>[] = [];
  const completions = [{ id: 1, process_instance_key: "pi-1", user_task_key: "ut-1", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) }];
  const app = {
    data: {
      open() {
        return {
          async exec(sql: string, params: unknown[] = []) {
            if (/^\s*INSERT INTO "pr_adjudications"/.test(sql)) {
              order.push("adjudication");
              adjudications.push({ pr_key: params[0], question_fingerprint: params[1], answer: params[2], adjudicated_by: params[3], adjudicated_kind: params[4] });
              return { changed: 1 };
            }
            return { changed: 0 };
          },
        };
      },
      table(name: string) {
        if (name === "pull_requests") return { async find() { return []; }, async update() { order.push("pr"); } };
        if (name === "pr_adjudications") {
          return { async find() { return []; } };
        }
        if (name === "task_completions") {
          return { async find(where: Record<string, unknown>) { return completions.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)); } };
        }
        if (name !== "escalations") throw new Error(`unexpected table ${name}`);
        return {
          async find() { return rows; },
          async update() { order.push("escalation"); },
        };
      },
    },
  };
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-1" } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1, "the adjudication is recorded");
  assertEquals(order[0], "adjudication", "the adjudication is persisted BEFORE any row transitions off `open`");
});

// --- issue #806 review: a null-provenance adjudication (an uncorrelated answer) makes the poller
// fail open and re-park a human every round. A LATER known-adjudicator answer to the same question,
// arriving through this worker, must HEAL the durable row to a replayable decision instead of being
// dropped by INSERT-if-absent — otherwise the question re-parks forever. ---

test("a later known-adjudicator answer heals an earlier uncorrelated (null-provenance) adjudication (#806 review)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications, completions } = fakeApp(rows);
  // Round A: an out-of-band answer that carried no completion identity → recorded with null provenance.
  const jobA = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 3.", answerContext: "convergence" } };
  await handler(jobA as any, app as any);
  assertEquals(adjudications.length, 1);
  assertEquals(adjudications[0].adjudicated_by, null, "round A recorded unknown provenance");
  // Round B: the question re-parked a human (unknown provenance fails open); the human answers via the
  // canonical completer, stamping the exact winning completion id. The durable row must be healed.
  rows.push({ id: 8, pr_key: "o/r#1", status: "open", question: "Which retry cap?" });
  completions.push({ id: 40, process_instance_key: "pi-1", user_task_key: "ut-b", actor_id: "alice", actor_kind: "human", variables_json: JSON.stringify({ answer: "Cap at 5." }) });
  const jobB = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5.", answerContext: "convergence", completedUserTaskKey: "ut-b", completedCompletionId: 40 } };
  await handler(jobB as any, app as any);
  assertEquals(adjudications.length, 1, "still one durable row for the (pr, question)");
  assertEquals(adjudications[0].adjudicated_by, "alice", "provenance healed to the known adjudicator");
  assertEquals(adjudications[0].answer, "Cap at 5.", "the healed row replays the human's answer, not the earlier uncorrelated one");
});
