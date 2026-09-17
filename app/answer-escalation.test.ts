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

function fakeApp(escalationRows: Record<string, unknown>[]) {
  const updates: { key: unknown; patch: Record<string, unknown> }[] = [];
  const prUpdates: { key: unknown; patch: Record<string, unknown> }[] = [];
  const adjudications: Record<string, unknown>[] = [];
  const completions: Record<string, unknown>[] = [];
  const app = {
    data: {
      table(name: string, _key: string) {
        if (name === "pull_requests") {
          return {
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
  // The resume's completion stamped a ledger row for this process instance (alice answered).
  completions.push({ id: 1, process_instance_key: "pi-1", element_id: "wait-answer", actor_id: "alice" });
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "Cap at 5." } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 1, "one durable adjudication row is written");
  assertEquals(adjudications[0].pr_key, "o/r#1");
  assertEquals(adjudications[0].question_fingerprint, questionFingerprint("Which retry cap?"), "keyed by the canonical fingerprint");
  assertEquals(adjudications[0].answer, "Cap at 5.");
  assertEquals(adjudications[0].adjudicated_by, "alice", "attributed to the completer from the ledger");
});

test("a blank answer records NO adjudication (not a replayable decision) (#806)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, adjudications } = fakeApp(rows);
  const job = { processInstanceKey: "pi-1", variables: { prKey: "o/r#1", answer: "   " } };
  await handler(job as any, app as any);
  assertEquals(adjudications.length, 0);
});
