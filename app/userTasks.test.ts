// Pure derivation tests for the unified Tasks-inbox read-model (issue #236). `buildUserTaskRow` turns
// one resolved open escalation user task into its desired `user_tasks` row (or null for a
// non-escalation / blank key), and `reconcileUserTasks` diffs the desired open set against the
// persisted rows into the minimal insert/update/delete plan the `pollUserTasks` reconcile applies.
// These are the pure source of truth the poller projects, mirroring `deriveFeatureEscalationPatch`.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  buildUserTaskRow,
  PLAN_REVIEW_ELEMENT,
  PR_WAIT_ANSWER_ELEMENT,
  reconcileUserTasks,
  TRIAL_MERGE_ELEMENT,
  type UserTaskRow,
} from "./userTasks.ts";

const AT = "2026-01-01T00:00:00.000Z";

test("buildUserTaskRow: a plan-review task becomes a labelled row with its findings as the question", () => {
  const row = buildUserTaskRow(
    {
      userTaskKey: "ut-1",
      elementId: PLAN_REVIEW_ELEMENT,
      subjectType: "plan",
      subjectKey: "o/r#1",
      subjectUrl: "https://github.com/o/r/issues/1",
      question: "  cap reached: revise scope  ",
      processKey: "pk-1",
    },
    AT,
  );
  assertEquals(row, {
    user_task_key: "ut-1",
    element_id: PLAN_REVIEW_ELEMENT,
    kind_label: "Plan review",
    subject_type: "plan",
    subject_key: "o/r#1",
    subject_url: "https://github.com/o/r/issues/1",
    question: "cap reached: revise scope",
    process_key: "pk-1",
    created_at: AT,
    updated_at: AT,
  });
});

test("buildUserTaskRow: a blank question / missing url normalises to null", () => {
  const row = buildUserTaskRow(
    { userTaskKey: "ut-2", elementId: TRIAL_MERGE_ELEMENT, subjectType: "plan", subjectKey: "o/r#2", question: "   " },
    AT,
  );
  assert(row !== null);
  assertEquals(row?.question, null);
  assertEquals(row?.subject_url, null);
  assertEquals(row?.process_key, null);
  assertEquals(row?.kind_label, "Trial merge");
});

test("buildUserTaskRow: an unknown (non-escalation) element yields null — no arbitrary user task leaks", () => {
  const row = buildUserTaskRow(
    { userTaskKey: "ut-3", elementId: "some-internal-task", subjectType: "plan", subjectKey: "o/r#3" },
    AT,
  );
  assertEquals(row, null);
});

test("buildUserTaskRow: a blank userTaskKey or subjectKey yields null", () => {
  assertEquals(
    buildUserTaskRow({ userTaskKey: "  ", elementId: PR_WAIT_ANSWER_ELEMENT, subjectType: "pr", subjectKey: "o/r#4" }, AT),
    null,
  );
  assertEquals(
    buildUserTaskRow({ userTaskKey: "ut-4", elementId: PR_WAIT_ANSWER_ELEMENT, subjectType: "pr", subjectKey: " " }, AT),
    null,
  );
});

function row(key: string, extra: Partial<UserTaskRow> = {}): UserTaskRow {
  return {
    user_task_key: key,
    element_id: PLAN_REVIEW_ELEMENT,
    kind_label: "Plan review",
    subject_type: "plan",
    subject_key: "o/r#1",
    subject_url: null,
    question: null,
    process_key: null,
    created_at: AT,
    updated_at: AT,
    ...extra,
  };
}

test("reconcileUserTasks: a new open task is an insert; a vanished task is a delete", () => {
  const persisted = [row("keep"), row("gone")];
  const desired = [row("keep"), row("fresh")];
  const { inserts, updates, deletes } = reconcileUserTasks(persisted, desired);
  assertEquals(inserts.map((r) => r.user_task_key), ["fresh"]);
  assertEquals(updates, []);
  assertEquals(deletes, ["gone"]);
});

test("reconcileUserTasks: an unchanged steady state yields no writes (idempotent)", () => {
  const persisted = [row("a", { question: "q" }), row("b")];
  const desired = [row("a", { question: "q" }), row("b")];
  assertEquals(reconcileUserTasks(persisted, desired), { inserts: [], updates: [], deletes: [] });
});

test("reconcileUserTasks: a drifted question is an update that preserves the original created_at", () => {
  const persisted = [row("a", { question: "old", created_at: "2025-06-01T00:00:00.000Z", updated_at: "2025-06-01T00:00:00.000Z" })];
  const desired = [row("a", { question: "new" })];
  const { inserts, updates, deletes } = reconcileUserTasks(persisted, desired);
  assertEquals(inserts, []);
  assertEquals(deletes, []);
  assertEquals(updates.length, 1);
  assertEquals(updates[0].question, "new");
  assertEquals(updates[0].created_at, "2025-06-01T00:00:00.000Z");
});
