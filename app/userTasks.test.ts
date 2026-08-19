// Pure derivation tests for the unified Tasks-inbox read-model (issue #236). `buildUserTaskRow` turns
// one resolved open escalation user task into its desired `user_tasks` row (or null for a
// non-escalation / blank key), and `reconcileUserTasks` diffs the desired open set against the
// persisted rows into the minimal insert/update/delete plan the `pollUserTasks` reconcile applies.
// These are the pure source of truth the poller projects.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { PlanReview } from "./plan.ts";
import type { TrialMergeAuditRow } from "./trialMerge.ts";
import {
  buildUserTaskRow,
  PLAN_REVIEW_ELEMENT,
  PR_WAIT_ANSWER_ELEMENT,
  latestFeatureEscalationQuestion,
  latestOpenEscalationQuestion,
  latestPlanReviewFindings,
  latestTrialMergeQuestion,
  type PrEscalationRow,
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
    subject_title: "o/r#1",
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

test("buildUserTaskRow: subject_title carries the subject title, trimmed, and coalesces to subject_key when absent/blank (issue #308)", () => {
  const titled = buildUserTaskRow(
    {
      userTaskKey: "ut-t1",
      elementId: PLAN_REVIEW_ELEMENT,
      subjectType: "plan",
      subjectKey: "o/r#1",
      subjectTitle: "  Add the widget  ",
    },
    AT,
  );
  assertEquals(titled?.subject_title, "Add the widget");

  for (const subjectTitle of [undefined, null, "   "]) {
    const row = buildUserTaskRow(
      { userTaskKey: "ut-t2", elementId: PLAN_REVIEW_ELEMENT, subjectType: "plan", subjectKey: "o/r#2", subjectTitle },
      AT,
    );
    assertEquals(row?.subject_title, "o/r#2");
  }
});

function row(key: string, extra: Partial<UserTaskRow> = {}): UserTaskRow {
  return {
    user_task_key: key,
    element_id: PLAN_REVIEW_ELEMENT,
    kind_label: "Plan review",
    subject_type: "plan",
    subject_key: "o/r#1",
    subject_title: "o/r#1",
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

// ── Audit-log derivations for the plan escalations (migration 027 retired the bespoke mirror tables,
//    so the question text is derived from the surviving `plan_reviews` / `plan_trial_merges` logs). ──

const review = (over: Partial<PlanReview>): PlanReview => ({
  plan_key: "o/r#20",
  epoch: 0,
  round: 0,
  approved: 0,
  findings: null,
  created_at: AT,
  job_key: null,
  ...over,
});

const audit = (over: Partial<TrialMergeAuditRow>): TrialMergeAuditRow => ({
  id: 1,
  plan_key: "o/r#20",
  wave: 0,
  result: "suite-failed",
  heads: null,
  conflicts: null,
  failing: null,
  summary: null,
  job_key: null,
  resolved: 0,
  created_at: AT,
  updated_at: AT,
  ...over,
});

test("latestPlanReviewFindings: picks the latest round's findings across epochs", () => {
  const reviews = [
    review({ epoch: 0, round: 0, findings: "epoch0 round0" }),
    review({ epoch: 1, round: 1, findings: "latest" }),
    review({ epoch: 1, round: 0, findings: "epoch1 round0" }),
  ];
  assertEquals(latestPlanReviewFindings(reviews), "latest");
});

test("latestPlanReviewFindings: null when there are no review rows", () => {
  assertEquals(latestPlanReviewFindings([]), null);
});

test("latestTrialMergeQuestion: picks the newest UNRESOLVED red row's summary", () => {
  const audits = [
    audit({ id: 1, wave: 0, result: "suite-failed", summary: "old red", resolved: 1 }),
    audit({ id: 2, wave: 0, result: "suite-failed", summary: "latest red", resolved: 0 }),
    audit({ id: 3, wave: 1, result: "clean", summary: "green", resolved: 0 }),
  ];
  assertEquals(latestTrialMergeQuestion(audits), "latest red");
});

test("latestTrialMergeQuestion: null when every red row is resolved (escalation answered)", () => {
  const audits = [audit({ id: 1, result: "suite-failed", summary: "red", resolved: 1 })];
  assertEquals(latestTrialMergeQuestion(audits), null);
});

function esc(o: Partial<PrEscalationRow> & { id: number }): PrEscalationRow {
  return {
    pr_key: "o/r#1",
    round_no: 1,
    kind: "question",
    question: "q",
    answer: null,
    status: "open",
    asked_at: "t",
    answered_at: null,
    ...o,
  };
}

test("latestOpenEscalationQuestion: picks the newest OPEN row (highest id), not a positional [0]", () => {
  const rows = [
    esc({ id: 3, question: "stale open" }),
    esc({ id: 7, question: "newest open" }),
    esc({ id: 9, status: "answered", question: "answered" }),
  ];
  assertEquals(latestOpenEscalationQuestion(rows), "newest open");
});

test("latestOpenEscalationQuestion: null when there is no open escalation", () => {
  assertEquals(latestOpenEscalationQuestion([esc({ id: 1, status: "answered" })]), null);
  assertEquals(latestOpenEscalationQuestion([]), null);
});

test("latestFeatureEscalationQuestion: picks the newest audit row (highest id), not a positional [0]", () => {
  const rows = [
    { id: 3, feature_key: "o/r#1", question: "stale", created_at: "t0", job_key: "j0" },
    { id: 8, feature_key: "o/r#1", question: "newest", created_at: "t1", job_key: "j1" },
    { id: 5, feature_key: "o/r#1", question: "middle", created_at: "t2", job_key: "j2" },
  ];
  assertEquals(latestFeatureEscalationQuestion(rows), "newest");
});

test("latestFeatureEscalationQuestion: null when the feature has no recorded escalation", () => {
  assertEquals(latestFeatureEscalationQuestion([]), null);
});
