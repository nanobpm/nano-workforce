// Red/green regression for pr.answer-escalation (Copilot review of PR #180).
//
// The review-loop escalation migrated from a message catch to a native `wait-answer` userTask.
// Completing the task resumes the token, but nothing retired the durable `escalations` audit row —
// so it stayed `status="open"` with a null `answer`/`answered_at` forever, both losing the Q&A
// trail and (since `activePrs` derives `openEscalation` from that row) surfacing a phantom open
// escalation on `/status` after it was answered. `pr.answer-escalation` runs on `wait-answer`
// completion and must transition the latest open row to `answered`, recording the submitted answer.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "../workers/answer-escalation/worker.ts";

function fakeApp(escalationRows: Record<string, unknown>[]) {
  const updates: { key: unknown; patch: Record<string, unknown> }[] = [];
  const app = {
    data: {
      table(name: string, _key: string) {
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
  return { app, updates };
}

test("retires the latest open escalation to answered with the submitted answer", async () => {
  const rows = [
    { id: 5, pr_key: "o/r#1", status: "answered", question: "old" },
    { id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" },
  ];
  const { app, updates } = fakeApp(rows);
  const job = { variables: { prKey: "o/r#1", answer: "  Cap at 5.  " } };
  await handler(job as any, app as any);
  assertEquals(updates.length, 1, "exactly the one open row is retired");
  assertEquals(updates[0].key, 7, "the newest open row (not the already-answered one) is retired");
  assertEquals(updates[0].patch.status, "answered");
  assertEquals(updates[0].patch.answer, "Cap at 5.", "the answer is trimmed and recorded");
  assertEquals(typeof updates[0].patch.answered_at, "string", "answered_at is stamped");
});

test("no open row is a no-op (idempotent re-completion)", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "answered", question: "Which retry cap?" }];
  const { app, updates } = fakeApp(rows);
  const job = { variables: { prKey: "o/r#1", answer: "again" } };
  await handler(job as any, app as any);
  assertEquals(updates.length, 0, "nothing to retire when no escalation is open");
});

test("a blank answer is recorded as NULL, not an empty string", async () => {
  const rows = [{ id: 7, pr_key: "o/r#1", status: "open", question: "Which retry cap?" }];
  const { app, updates } = fakeApp(rows);
  const job = { variables: { prKey: "o/r#1", answer: "   " } };
  await handler(job as any, app as any);
  assertEquals(updates[0].patch.answer, null);
  assertEquals(updates[0].patch.status, "answered");
});
