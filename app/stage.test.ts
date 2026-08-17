// Unit tests for the canonical feature-run pipeline stage model (issue #254 §1). `deriveStage` is the
// ONE source of truth the feature_runs gateway projects onto the stored pipeline columns, so the
// mapping must be TOTAL and DETERMINISTIC over every FEATURE_RUN_STATUS and emit the urban 0.53.0
// `kind:"pipeline"` renderer's EXACT vocabulary (state `ok|failed|blocked|null`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { FEATURE_RUN_STATUSES } from "./feature.ts";
import { deriveEscalationOpen, deriveListBucket, deriveStage, type StageInput } from "./stage.ts";

const base = (over: Partial<StageInput> & { status: string }): StageInput => ({
  pr_key: null,
  converge: 1,
  auto_merge: 1,
  escalation_question: null,
  escalation_user_task_key: null,
  blocked_user_task_key: null,
  ...over,
});

test("deriveStage is TOTAL: every one of the 11 statuses maps to a defined stage and state", () => {
  assertEquals(FEATURE_RUN_STATUSES.length, 11);
  for (const status of FEATURE_RUN_STATUSES) {
    const d = deriveStage(base({ status }));
    assert(d.stage !== undefined, `stage undefined for ${status}`);
    assert(
      ["Requested", "Implementing", "PR open", "Converging", "Merging", "Done"].includes(d.stage),
      `stage out of range for ${status}: ${d.stage}`,
    );
    // state is one of the renderer's exact values (null allowed)
    assert([null, "ok", "failed", "blocked"].includes(d.state), `state out of range for ${status}: ${d.state}`);
  }
});

test("status -> stage mapping (each row)", () => {
  // Terminal tier → Done.
  for (const status of ["merged", "converged", "blocked", "failed", "skipped", "abandoned"]) {
    assertEquals(deriveStage(base({ status })).stage, "Done", status);
  }
  // Live/parked tier.
  assertEquals(deriveStage(base({ status: "converging" })).stage, "Converging");
  assertEquals(deriveStage(base({ status: "opened" })).stage, "PR open");
  assertEquals(deriveStage(base({ status: "running", pr_key: "o/r#9" })).stage, "PR open");
  assertEquals(deriveStage(base({ status: "running" })).stage, "Implementing");
  // The pre-start/created initial state (unknown non-terminal, no pr_key) → Requested.
  assertEquals(deriveStage(base({ status: "created" })).stage, "Requested");
});

test("state: the three non-null values plus the null in-progress case", () => {
  assertEquals(deriveStage(base({ status: "merged" })).state, "ok");
  assertEquals(deriveStage(base({ status: "converged" })).state, "ok");
  assertEquals(deriveStage(base({ status: "failed" })).state, "failed");
  assertEquals(deriveStage(base({ status: "skipped" })).state, "failed");
  assertEquals(deriveStage(base({ status: "abandoned" })).state, "failed");
  assertEquals(deriveStage(base({ status: "blocked" })).state, "blocked");
  // Every non-terminal status → null (in-progress).
  for (const status of ["running", "opened", "converging", "escalated", "awaiting_operator"]) {
    assertEquals(deriveStage(base({ status })).state, null, status);
  }
});

test("state emits 'failed' (not 'fail') so the renderer does not degrade a failure to active", () => {
  assertEquals(deriveStage(base({ status: "failed" })).state, "failed");
});

test("skipped: the three converge/auto_merge cases", () => {
  // converge off → skip both.
  assertEquals(deriveStage(base({ status: "running", converge: 0, auto_merge: 0 })).skipped, "Converging Merging");
  // converge on, auto_merge off → skip Merging only.
  assertEquals(deriveStage(base({ status: "running", converge: 1, auto_merge: 0 })).skipped, "Merging");
  // both on → empty.
  assertEquals(deriveStage(base({ status: "running", converge: 1, auto_merge: 1 })).skipped, "");
});

test("attention: blocked, escalation, none", () => {
  assertEquals(deriveStage(base({ status: "awaiting_operator", blocked_user_task_key: "ut-1" })).attention, "blocked");
  assertEquals(deriveStage(base({ status: "escalated", escalation_user_task_key: "ut-2" })).attention, "⚠");
  assertEquals(deriveStage(base({ status: "escalated", escalation_question: "which base?" })).attention, "⚠");
  assertEquals(deriveStage(base({ status: "running" })).attention, null);
});

// The three parked-status rows called out by the plan review.
test("escalated WITH pr_key → PR open / null", () => {
  const d = deriveStage(base({ status: "escalated", pr_key: "o/r#5" }));
  assertEquals(d.stage, "PR open");
  assertEquals(d.state, null);
});

test("escalated WITHOUT pr_key → Implementing / null", () => {
  const d = deriveStage(base({ status: "escalated", pr_key: null }));
  assertEquals(d.stage, "Implementing");
  assertEquals(d.state, null);
});

test("awaiting_operator WITHOUT pr_key → Implementing / null, attention 'blocked' when parked", () => {
  const d = deriveStage(base({ status: "awaiting_operator", pr_key: null, blocked_user_task_key: "ut-3" }));
  assertEquals(d.stage, "Implementing");
  assertEquals(d.state, null);
  assertEquals(d.attention, "blocked");
});

test("deriveListBucket: history iff terminal AND acknowledged, else active", () => {  assertEquals(deriveListBucket("merged", null), "active");
  assertEquals(deriveListBucket("merged", "2024-01-01T00:00:00Z"), "history");
  // A non-terminal status is always active, even if (spuriously) acknowledged.
  assertEquals(deriveListBucket("running", "2024-01-01T00:00:00Z"), "active");
  assertEquals(deriveListBucket("blocked", "2024-01-01T00:00:00Z"), "history");
});

// deriveEscalationOpen (issue #272): the single fail-closed "open escalation" display signal. TRUE iff
// all three independently-written escalation columns AGREE the run is parked at an answerable
// escalation; any single missing/torn field yields FALSE so the pages render not-escalated.
test("deriveEscalationOpen: true only when status, pointer AND question all present", () => {
  assertEquals(
    deriveEscalationOpen({ status: "escalated", escalation_user_task_key: "ut-7", escalation_question: "which base?" }),
    true,
  );
});

test("deriveEscalationOpen: torn tuple (pointer set, question blank) renders as NOT escalated", () => {
  // The mirror tear observed on nwf#270: status=escalated + live pointer + blank question.
  assertEquals(
    deriveEscalationOpen({ status: "escalated", escalation_user_task_key: "ut-7", escalation_question: null }),
    false,
  );
  assertEquals(
    deriveEscalationOpen({ status: "escalated", escalation_user_task_key: "ut-7", escalation_question: "" }),
    false,
  );
});

test("deriveEscalationOpen: torn tuple (question set, pointer null) renders as NOT escalated", () => {
  // The entry-window tear: record-feature-escalation persisted the question but the poller has not yet
  // denormalised the pointer.
  assertEquals(
    deriveEscalationOpen({ status: "escalated", escalation_user_task_key: null, escalation_question: "which base?" }),
    false,
  );
});

test("deriveEscalationOpen: a resumed run whose status lags behind a cleared tuple is NOT escalated", () => {
  // status still 'escalated' but the answer op already cleared pointer + question → fail closed.
  assertEquals(
    deriveEscalationOpen({ status: "escalated", escalation_user_task_key: null, escalation_question: null }),
    false,
  );
  // A non-escalated status can never be open regardless of stray column values.
  assertEquals(
    deriveEscalationOpen({ status: "running", escalation_user_task_key: "ut-7", escalation_question: "which base?" }),
    false,
  );
});
