// Regression guard for the question-less merge escalation defect (issue #329).
//
// The merge loop (`resources/processes/merge-loop.bpmn`) raised escalations with NO question
// whenever a PR was blocked by anything other than a merge conflict: `merge-esc-attempt` called
// `pr.persist-escalation` with no `question`/`status` ioMapping, and its output flowed
// UNCONDITIONALLY into `wait-merge-answer`. Two coupled defects fell out of that:
//
//   1. A blank question surfaced on the merge-driving inbox — the human was asked to answer but
//      told nothing (observed live on nano-ide PR #354).
//   2. Per ADR 0002 §1 a blank question is a NON-escalation: `pr.persist-escalation` opens no row
//      and returns `escalated:false`. The convergence loop honours this via a `gw-escalated`
//      branch; the merge loop had none, so a question-less job still parked a dead
//      `wait-merge-answer` with nothing for a human to answer.
//
// The fix (mirroring the convergence loop): give `merge-esc-attempt` a human-actionable
// `status`/`question` that distinguishes its four trigger conditions, and add a `gw-merge-escalated`
// guard so a `persist-escalation` returning `escalated:false` re-enters the loop (re-arms the
// poller) instead of parking a dead wait.
//
// These are pure text assertions over the committed BPMN (no engine), matching the repo's
// lightweight model-guard style (see mergeRebaseArm.test.ts, mergeEscalationUserTask.test.ts).

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/merge-loop.bpmn", "utf8");
// Collapse whitespace so attribute-order / line-wrapping churn doesn't make the assertions brittle.
const flat = bpmn.replace(/\s+/g, " ");

function flowHasId(id: string, source: string, target: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:sequenceFlow\\b[^>]*\\bid="${id}"[^>]*(?:/>|>)`));
  if (!m) return false;
  const tag = m[0];
  return tag.includes(`sourceRef="${source}"`) && tag.includes(`targetRef="${target}"`);
}

function gatewayDefault(id: string, def: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:exclusiveGateway\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!m) return false;
  return m[0].includes(`default="${def}"`);
}

// The <serviceTask> element for merge-esc-attempt, including its ioMapping. Unescape XML entities so
// FEEL string literals (authored as `&#34;ready&#34;` inside the attribute) read naturally here.
const escAttemptRaw = flat.match(/<bpmn:serviceTask\b[^>]*\bid="merge-esc-attempt"[\s\S]*?<\/bpmn:serviceTask>/);
const escAttempt = escAttemptRaw
  ? [escAttemptRaw[0].replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&#10;/g, "\n")]
  : null;

test("merge-esc-attempt carries a non-blank, human-actionable status + question", () => {
  assert(escAttempt, "merge-esc-attempt service task must exist");
  const el = escAttempt![0];
  // Mirror the merge-esc-conflict mapping style: an explicit `blocked` status…
  assertStringIncludes(el, "<zeebe:ioMapping", "merge-esc-attempt must set an ioMapping (was absent — the #329 defect)");
  assertStringIncludes(el, 'target="status"', "merge-esc-attempt must set a `status`");
  assertStringIncludes(el, 'target="question"', "merge-esc-attempt must set a non-blank `question`");
  // Tighten: assert the explicit `status` INPUT MAPPING sets blocked, not merely the substring
  // `="blocked"` (which the FEEL question's `agentVerdict = "blocked"` comparison would also satisfy
  // even if the status mapping were removed/changed). Match tolerant of attribute order/spacing: the
  // file is XML and a formatter could reorder `source`/`target` within the tag.
  const escInputs = el.match(/<zeebe:input\b[^>]*\/>/g) ?? [];
  const setsBlockedStatus = escInputs.some(
    (t) => t.includes('target="status"') && t.includes('source="="blocked""'),
  );
  assert(setsBlockedStatus, "the explicit `status` input mapping must set `blocked`");
});

test("arm-merge clears the prior verdict `status` so a stale `blocked` cannot misclassify the CI-fix SLA escalation", () => {
  // merge-esc-attempt captures `agentVerdict = status` to split its CI could-not-fix vs SLA question
  // arms. On the SLA boundary path (`f_ci_sla`) no worker sets a fresh `status`, and every escalation
  // task overwrites `status = "blocked"` (merge-esc-attempt line 194, merge-esc-conflict line 174).
  // Without a reset, a retry after any prior escalation re-enters fix-ci with `status` still
  // "blocked", so an SLA timeout would render the wrong ("could not fix") question. arm-merge is the
  // single loop hub every fix-ci entry passes through, so clearing `status` there (to null) each
  // iteration guarantees a genuine SLA reads no stale verdict. Nothing between arm-merge and the next
  // verdict-setter (fix-ci/rebase) reads `status`, so the reset is safe.
  const armRaw = flat.match(/<bpmn:serviceTask\b[^>]*\bid="arm-merge"[\s\S]*?<\/bpmn:serviceTask>/);
  assert(armRaw, "arm-merge service task must exist");
  const armOutputs = armRaw![0].match(/<zeebe:output\b[^>]*\/>/g) ?? [];
  const clearsStatus = armOutputs.some(
    (t) => t.includes('target="status"') && t.includes('source="=null"'),
  );
  assert(clearsStatus, "arm-merge must reset `status` to null each loop iteration so a stale `blocked` cannot misclassify the SLA escalation");
});

test("the question distinguishes all four blocked/SLA triggers rather than a single generic string", () => {
  // Four flows route into merge-esc-attempt — the gate `blocked` default, CI could-not-fix,
  // rebase could-not-resolve, and the CI-fix SLA. Each is a legitimately different escalation and
  // the question must explain which one fired.
  assert(escAttempt, "merge-esc-attempt service task must exist");
  const el = escAttempt![0];
  // gate blocked (gw-merge default): distinguishes on the `ready` mergeState + surfaces mergeStatus.
  assertStringIncludes(el, 'mergeState = "ready"', "must branch on the gate-blocked (ready) trigger");
  assertStringIncludes(el, "mergeStatus", "the gate-blocked question must surface the merge result");
  // rebase could-not-resolve (conflict arm).
  assertStringIncludes(el, 'mergeState = "conflict"', "must branch on the rebase (conflict) trigger");
  // CI could-not-fix vs CI SLA both arrive with mergeState = blocked — split on the agent verdict,
  // captured into a dedicated `agentVerdict` binding so the escalation-classification `status =
  // "blocked"` override in the SAME ioMapping cannot make the SLA branch unreachable (issue #329
  // review). Assert the question branches on that binding, not on the overwritten `status`.
  assertStringIncludes(el, "agentVerdict", "must capture the agent verdict into a dedicated binding");
  assertStringIncludes(el, 'agentVerdict = "blocked"', "must branch CI could-not-fix vs SLA on the agent verdict binding, not the overwritten status");
});

test("retry-budget-exhausted escalation reads as a repeated race, not a generic merge refusal", () => {
  // `f_mr_giveup` (transient merge-retry budget exhausted) routes into merge-esc-attempt with
  // mergeState = "ready" AND mergeStatus = "retry". Without a dedicated branch this reused the
  // generic gate-blocked ("Investigate why GitHub refused the merge") text, which is misleading for
  // a repeated base/head-moved race whose retry budget simply ran out. The question must branch on
  // mergeStatus = "retry" — ahead of the generic `mergeState = "ready"` arm — and name the budget.
  assert(escAttempt, "merge-esc-attempt service task must exist");
  const el = escAttempt![0];
  assertStringIncludes(el, 'mergeStatus = "retry"', "must branch the retry-budget-exhausted escalation on mergeStatus = retry");
  assertStringIncludes(el, "mergeRetryMax", "the retry-exhausted question must surface the retry budget");
  // The retry branch must precede the generic `mergeState = "ready"` branch, or the generic arm
  // (also true here) would shadow it and re-emit the misleading refusal text.
  const retryIdx = el.indexOf('mergeStatus = "retry"');
  const readyIdx = el.indexOf('mergeState = "ready"');
  assert(retryIdx !== -1 && readyIdx !== -1 && retryIdx < readyIdx, "the retry branch must be evaluated before the generic ready branch");
});

test("a gw-merge-escalated guard honours persist-escalation's escalated:false (mirrors the convergence loop)", () => {
  // The escalation output no longer flows UNCONDITIONALLY into the durable answer wait: it passes
  // through a gateway that reads the worker's `escalated` output.
  assert(
    flowHasId("f_m_escA", "merge-esc-attempt", "gw-merge-escalated"),
    "merge-esc-attempt must route through gw-merge-escalated, not straight to wait-merge-answer",
  );
  // escalated:true → park the native user task for a human to answer.
  assert(
    flowHasId("f_m_escWait", "gw-merge-escalated", "wait-merge-answer"),
    "gw-merge-escalated → wait-merge-answer (escalated) missing",
  );
  const escWait = flat.match(/<bpmn:sequenceFlow[^>]*id="f_m_escWait"[\s\S]*?<\/bpmn:sequenceFlow>/);
  assert(escWait, "f_m_escWait flow missing");
  assertStringIncludes(escWait![0], "escalated = true", "the wait arm must be guarded by escalated = true");
  // escalated:false (a non-escalation, e.g. a blank question) → re-enter the loop, NOT a dead wait.
  assert(
    gatewayDefault("gw-merge-escalated", "f_m_escReenter"),
    "gw-merge-escalated must default to f_m_escReenter (re-enter, not park)",
  );
  assert(
    flowHasId("f_m_escReenter", "gw-merge-escalated", "arm-merge"),
    "f_m_escReenter must re-arm the merge poller instead of parking a dead wait-merge-answer",
  );
});

test("regression: a question-less escalation can no longer park a dead wait-merge-answer", () => {
  // The exact #329 wedge: `merge-esc-attempt → wait-merge-answer` as a direct, unconditional edge.
  // It must be gone — the only path into the answer wait from the attempt arm is now guarded by
  // `escalated = true`.
  assert(
    !flowHasId("f_m_escA", "merge-esc-attempt", "wait-merge-answer"),
    "merge-esc-attempt must NOT flow directly into wait-merge-answer (the #329 dead-wait defect)",
  );
});

// ── Draft PR escalation (issue #454) ─────────────────────────────────────────────────────────────
//
// A draft PR is never landable — `classifyMergeability` now yields a first-class `"draft"` verdict
// (app/github.ts) that the poller (app/service.ts) publishes as `mergeState = "draft"`. It routes
// through `gw-mergeable`'s default (`f_m_mBlocked → merge-esc-conflict`), so `merge-esc-conflict`'s
// question must recognise `draft` and give the ACTIONABLE remedy (mark it ready) instead of the
// generic "resolve the conflict or failing required check" text (which is the wrong remedy for a
// draft), and — before this fix — instead of `merge-esc-attempt`'s misleading "the merge attempt did
// not land (blocked), investigate why GitHub refused the merge".
const escConflictRaw = flat.match(/<bpmn:serviceTask\b[^>]*\bid="merge-esc-conflict"[\s\S]*?<\/bpmn:serviceTask>/);
const escConflict = escConflictRaw ? escConflictRaw[0].replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&") : null;

test("merge-esc-conflict gives a draft PR an actionable 'mark it ready' question (issue #454)", () => {
  assert(escConflict, "merge-esc-conflict service task must exist");
  const el = escConflict!;
  // Branches on the draft verdict…
  assertStringIncludes(el, 'mergeState = "draft"', "merge-esc-conflict must branch on the draft verdict");
  // …with the actionable remedy (mark it ready), not the conflict/failing-check remedy.
  assertStringIncludes(el, "draft and can't be merged", "the draft question must state the PR is in draft");
  assertStringIncludes(el, "gh pr ready", "the draft question must tell the human to mark it ready");
});

test("merge-esc-conflict keeps the non-draft not-mergeable branch intact (regression guard, issue #454)", () => {
  assert(escConflict, "merge-esc-conflict service task must exist");
  const el = escConflict!;
  // The original conflict/failing-check message must still be reachable for non-draft states.
  assertStringIncludes(el, "This PR is not mergeable (state:", "the non-draft not-mergeable message must remain");
  // The draft branch must precede the generic message so it isn't shadowed.
  const draftIdx = el.indexOf('mergeState = "draft"');
  const genericIdx = el.indexOf("This PR is not mergeable (state:");
  assert(draftIdx !== -1 && genericIdx !== -1 && draftIdx < genericIdx, "the draft branch must be evaluated before the generic not-mergeable message");
});
