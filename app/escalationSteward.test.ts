// Unit tests for the opt-in escalation steward domain core (issue #889).
//
// Covers the PURE eligibility/guard derivations and the record/claim I/O against the real
// provisioned SQLite data layer:
//   • eligibility — opted-in only, answerable kinds only, min-age, not-already-claimed;
//   • the claim/lease fence — two claims for one task can never both win (no double-answer);
//   • the destructive-option + loop guards — abstain, never submit;
//   • record writing + dismiss/intervene review transitions;
//   • the opt-in map derivation across every subject table.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import {
  claimEscalations,
  countSubjectResolutions,
  escalationAutoResolutions,
  isDestructiveOption,
  isEligibleEscalation,
  isStewardAnswerableElement,
  listAutoResolutions,
  liveClaimedTaskKeys,
  loopGuardTripped,
  LOOP_GUARD_MAX_RESOLUTIONS,
  optInByProcessKey,
  pendingAutoResolutionCount,
  recordResolution,
  reviewResolution,
  STEWARD_NEVER_RESOLVE_ELEMENTS,
} from "./escalationSteward.ts";
import type { UserTaskRow } from "./userTasks.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-steward-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

function taskRow(over: Partial<UserTaskRow>): UserTaskRow {
  return {
    user_task_key: "UT-1",
    element_id: "wait-answer",
    kind_label: "PR review",
    subject_type: "pr",
    subject_key: "o/r#1",
    subject_title: "o/r#1",
    subject_url: "https://github.com/o/r/pull/1",
    question: "Which approach?",
    process_key: "PI-1",
    form_key: "pr-escalation",
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min old
    updated_at: new Date().toISOString(),
    ...over,
  };
}

// ── Pure eligibility ─────────────────────────────────────────────────────────────────────────────

test("isEligibleEscalation: requires opt-in (non-opted-in work is never touched)", () => {
  const row = taskRow({});
  const base = { minAgeMs: 300_000, claimedUserTaskKeys: new Set<string>(), at: Date.now() };
  assertEquals(isEligibleEscalation(row, { ...base, optedIn: true }), true);
  assertEquals(isEligibleEscalation(row, { ...base, optedIn: false }), false, "not opted in → ineligible");
});

test("isEligibleEscalation: enforces the minimum age so a human already answering wins", () => {
  const fresh = taskRow({ created_at: new Date().toISOString() }); // just opened
  const base = { optedIn: true, claimedUserTaskKeys: new Set<string>(), at: Date.now() };
  assertEquals(isEligibleEscalation(fresh, { ...base, minAgeMs: 300_000 }), false, "too fresh → ineligible");
  assertEquals(isEligibleEscalation(taskRow({}), { ...base, minAgeMs: 300_000 }), true, "past min age → eligible");
});

test("isEligibleEscalation: a task already claimed by a live steward run is skipped", () => {
  const row = taskRow({});
  const base = { optedIn: true, minAgeMs: 300_000, at: Date.now() };
  assertEquals(isEligibleEscalation(row, { ...base, claimedUserTaskKeys: new Set(["UT-1"]) }), false, "claimed → ineligible");
});

test("isStewardAnswerableElement: refuses human-only / irreversible / credential kinds", () => {
  for (const el of ["merge-approval", "acp-permission", "readiness-escalation", "readiness-escalation-pf", "feature-blocked", "conformance-escalation", "empty-plan-escalation"]) {
    assertEquals(isStewardAnswerableElement(el), false, `${el} must never be steward-answered`);
    assertEquals(STEWARD_NEVER_RESOLVE_ELEMENTS.has(el), true);
  }
  // The agent-answerable escalation kinds ARE steward-answerable.
  for (const el of ["wait-answer", "wait-merge-answer", "feature-escalation", "escalation", "plan-review-decision", "trial-merge-decision"]) {
    assertEquals(isStewardAnswerableElement(el), true, `${el} is steward-answerable`);
  }
});

// ── Destructive-option + loop guards ─────────────────────────────────────────────────────────────

test("isDestructiveOption: flags irreversible/destructive choices for abstention", () => {
  for (const v of ["abandon", "abandon-run", "delete", "destroy", "discard", "force-merge", "merge-admin", "override-checks"]) {
    assertEquals(isDestructiveOption(v), true, `${v} is destructive`);
  }
  for (const v of ["retry", "continue", "answer", "proceed", "revise", "rebase"]) {
    assertEquals(isDestructiveOption(v), false, `${v} is safe`);
  }
});

test("loopGuardTripped: trips once a subject has been auto-resolved the max times", () => {
  assertEquals(loopGuardTripped(0), false);
  assertEquals(loopGuardTripped(LOOP_GUARD_MAX_RESOLUTIONS - 1), false);
  assertEquals(loopGuardTripped(LOOP_GUARD_MAX_RESOLUTIONS), true, "at the cap → abstain");
  assertEquals(loopGuardTripped(LOOP_GUARD_MAX_RESOLUTIONS + 1), true);
});

// ── Claim/lease fence + record I/O against the real data layer ──────────────────────────────────

test("claimEscalations: the durable fence lets only ONE steward claim a task (no double-answer)", async () => {
  await withData(async (data) => {
    const rows = [taskRow({})];
    const first = await claimEscalations(data, rows, "steward-A");
    assertEquals(first.length, 1, "the first claim wins");
    // A second, overlapping steward run claiming the SAME task loses the fence (skipped, not an error).
    const second = await claimEscalations(data, rows, "steward-B");
    assertEquals(second.length, 0, "the second claim is fenced out — the task is never double-answered");
    const live = await liveClaimedTaskKeys(data);
    assertEquals(live.has("UT-1"), true, "the live claim is visible to the eligibility derivation");
  });
});

test("recordResolution: finalises a claim into a resolved record; the fence then releases the task", async () => {
  await withData(async (data) => {
    await claimEscalations(data, [taskRow({})], "steward-A");
    await recordResolution(data, "UT-1", {
      outcome: "resolved",
      submittedVariables: { answer: "Retry with a corrective note." },
      rationale: "nothing was pushed — retry",
      evidence: "git ls-remote showed no branch",
      options: ["retry", "abandon"],
      agentJobKey: "J-1",
    });
    const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "resolved");
    assertEquals(rows[0].submitted_variables, JSON.stringify({ answer: "Retry with a corrective note." }));
    assertEquals(rows[0].rationale, "nothing was pushed — retry");
    assertEquals(rows[0].claimed_by, null, "finalised — the claim is released");
    // A resolved row no longer holds the open-claim fence, so a FRESH escalation of the same task key
    // (a re-escalation) can be claimed/recorded afresh.
    const live = await liveClaimedTaskKeys(data);
    assertEquals(live.has("UT-1"), false);
  });
});

test("countSubjectResolutions: only RESOLVED rows count toward the loop guard (abstentions do not)", async () => {
  await withData(async (data) => {
    // Two resolved + one abstained for the same subject.
    for (const key of ["UT-1", "UT-2"]) {
      await claimEscalations(data, [taskRow({ user_task_key: key })], "steward-A");
      await recordResolution(data, key, { outcome: "resolved", submittedVariables: { answer: "x" } });
    }
    await claimEscalations(data, [taskRow({ user_task_key: "UT-3" })], "steward-A");
    await recordResolution(data, "UT-3", { outcome: "abstained", rationale: "unclear" });
    assertEquals(await countSubjectResolutions(data, "o/r#1"), 2, "only the two resolved rows count");
    assertEquals(loopGuardTripped(await countSubjectResolutions(data, "o/r#1")), true, "the guard trips at the cap");
  });
});

test("listAutoResolutions + pendingAutoResolutionCount: only FINAL records are listed; filters work", async () => {
  await withData(async (data) => {
    // One resolved (pending review), one abstained (pending), one dismissed.
    await claimEscalations(data, [taskRow({ user_task_key: "UT-1" })], "s");
    await recordResolution(data, "UT-1", { outcome: "resolved", submittedVariables: { answer: "x" } });
    await claimEscalations(data, [taskRow({ user_task_key: "UT-2", element_id: "feature-escalation", kind_label: "Feature escalation" })], "s");
    await recordResolution(data, "UT-2", { outcome: "abstained", rationale: "unclear" });
    await claimEscalations(data, [taskRow({ user_task_key: "UT-3" })], "s");
    await recordResolution(data, "UT-3", { outcome: "resolved", submittedVariables: { answer: "y" } });
    // An in-flight claim (never finalised) must NOT appear in the review surface.
    await claimEscalations(data, [taskRow({ user_task_key: "UT-4" })], "s");

    const all = await listAutoResolutions(data);
    assertEquals(all.length, 3, "the in-flight claim is not listed");
    assertEquals(await pendingAutoResolutionCount(data), 3);
    const pending = await listAutoResolutions(data, { reviewState: "pending" });
    assertEquals(pending.length, 3);
    const byKind = await listAutoResolutions(data, { kind: "feature-escalation" });
    assertEquals(byKind.length, 1);
    assertEquals(byKind[0].element_id, "feature-escalation");
  });
});

test("reviewResolution: dismiss/intervene fold review_state off pending, idempotently", async () => {
  await withData(async (data) => {
    await claimEscalations(data, [taskRow({})], "s");
    await recordResolution(data, "UT-1", { outcome: "resolved", submittedVariables: { answer: "x" } });
    const id = (await escalationAutoResolutions(data).find({ user_task_key: "UT-1" }))[0].id;

    assertEquals(await reviewResolution(data, id, "dismissed", "alice", "looks right"), true);
    let row = (await escalationAutoResolutions(data).find({ user_task_key: "UT-1" }))[0];
    assertEquals(row.review_state, "dismissed");
    assertEquals(row.reviewed_by, "alice");
    assertEquals(row.review_note, "looks right");
    assertEquals(typeof row.reviewed_at, "string");

    // A second review is a no-op (already off pending) — the record keeps its first review.
    assertEquals(await reviewResolution(data, id, "intervened", "bob", "stepping in"), false);
    row = (await escalationAutoResolutions(data).find({ user_task_key: "UT-1" }))[0];
    assertEquals(row.review_state, "dismissed", "an already-reviewed record is unchanged");
    assertEquals(await pendingAutoResolutionCount(data), 0);
  });
});

test("optInByProcessKey: derives the opt-in flag from every subject table, keyed by process instance", async () => {
  await withData(async (data) => {
    const ts = new Date().toISOString();
    // An opted-in PR and a NOT-opted-in feature run.
    await data.table("pull_requests", "pr_key").insert({
      pr_key: "o/r#1", repo: "o/r", number: 1, url: "u", status: "converging", current_round: 0,
      process_key: "PI-PR", auto_resolve_escalations: 1, created_at: ts, updated_at: ts,
    });
    await data.table("feature_runs", "feature_key").insert({
      feature_key: "o/r#2", repo: "o/r", issue_number: 2, issue_url: "u", base_branch: "main",
      status: "running", process_key: "PI-FEAT", auto_resolve_escalations: 0, created_at: ts, updated_at: ts,
    });
    const map = await optInByProcessKey(data);
    assertEquals(map.get("PI-PR"), true, "the opted-in PR is eligible");
    assertEquals(map.get("PI-FEAT"), false, "the non-opted-in feature is not");
    assertEquals(map.get("PI-UNKNOWN"), undefined, "an untracked instance is absent (fail-closed)");
  });
});
