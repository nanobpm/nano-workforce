// Structural regression guard for the merge-loop transient-retry arm (issue #334).
//
// #334: a transient, GitHub-flagged-retryable merge race ("Base branch was modified. Review and
// try the merge again.") was mapped to `blocked` → a decision-required human escalation on a PR
// that was actually mergeable once the base settled. The fix adds a `retry` merge outcome that
// re-enters the merge loop on the settled base through a *bounded* budget gate — mirroring the
// `gw-ci-fix` within-budget / budget-exhausted pattern — WITHOUT any remediation agent, and
// escalates via the existing `merge-esc-attempt` only when the retry budget is exhausted (so a
// continuously-moving base still escalates promptly rather than spinning forever).
//
// This test asserts the arm's topology on the committed model so it cannot regress silently. It is
// a pure text assertion over the BPMN (no engine), matching the repo's lightweight model-guard style.

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/merge-loop.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

function hasFlow(source: string, target: string): boolean {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*\\bsourceRef="${source}"[^>]*\\btargetRef="${target}"|` +
      `<bpmn:sequenceFlow\\b[^>]*\\btargetRef="${target}"[^>]*\\bsourceRef="${source}"`,
  );
  return re.test(flat);
}

function flowHasId(id: string, source: string, target: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:sequenceFlow\\b[^>]*\\bid="${id}"[^>]*/?>`));
  if (!m) return false;
  const tag = m[0];
  return tag.includes(`sourceRef="${source}"`) && tag.includes(`targetRef="${target}"`);
}

function gatewayDefault(id: string, def: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:exclusiveGateway\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!m) return false;
  return m[0].includes(`default="${def}"`);
}

// Assert the conditionExpression *of a specific sequenceFlow* contains `needle`, so the guard
// cannot be satisfied by the same substring appearing on an unrelated flow (e.g. the
// merge-esc-attempt question FEEL also mentions `mergeStatus = "retry"`).
function flowHasCondition(id: string, needle: string): boolean {
  const m = flat.match(
    new RegExp(`<bpmn:sequenceFlow\\b[^>]*\\bid="${id}"[^>]*>(.*?)</bpmn:sequenceFlow>`),
  );
  if (!m) return false;
  const cond = m[1].match(/<bpmn:conditionExpression\b[^>]*>(.*?)<\/bpmn:conditionExpression>/);
  return cond ? cond[1].includes(needle) : false;
}

test("gw-merge routes the retry outcome to a dedicated budget gate, not to a human", () => {
  // A `retry` merge result must reach the retry-budget gate…
  assert(hasFlow("gw-merge", "gw-merge-retry"), "gw-merge → gw-merge-retry (retry) missing");
  // …guarded by the exact retry condition (mergeStatus = "retry").
  assert(flowHasId("f_m_gRetry", "gw-merge", "gw-merge-retry"), "f_m_gRetry must be gw-merge → gw-merge-retry");
  // Assert the retry condition on f_m_gRetry ITSELF — not merely anywhere in the model — so the
  // guard cannot be satisfied by the identical substring in the merge-esc-attempt question FEEL.
  assert(
    flowHasCondition("f_m_gRetry", 'mergeStatus = "retry"'),
    'f_m_gRetry conditionExpression must be mergeStatus = "retry"',
  );
});

test("retry arm mirrors the fix-ci arm: budget gate → re-arm, exhausted → escalate", () => {
  // Within budget → re-arm the merge poller (re-attempt on the settled base). No remediation agent.
  assert(hasFlow("gw-merge-retry", "arm-merge"), "gw-merge-retry → arm-merge (within budget) missing");
  assert(flowHasId("f_mr_go", "gw-merge-retry", "arm-merge"), "f_mr_go must be gw-merge-retry → arm-merge");
  assertStringIncludes(flat, "mergeRetryRound &lt;= mergeRetryMax");

  // Budget exhausted → the EXISTING human escalation (merge-esc-attempt), and it is the gateway default
  // so a continuously-moving base can never spin past the cap.
  assert(
    hasFlow("gw-merge-retry", "merge-esc-attempt"),
    "gw-merge-retry → merge-esc-attempt (budget exhausted) missing",
  );
  assert(gatewayDefault("gw-merge-retry", "f_mr_giveup"), "gw-merge-retry must default to f_mr_giveup");
  assert(
    flowHasId("f_mr_giveup", "gw-merge-retry", "merge-esc-attempt"),
    "f_mr_giveup must default gw-merge-retry → merge-esc-attempt",
  );
});

test("the retry arm advances the attempt counter only on a transient retry outcome", () => {
  // The counter advances ONLY when the merge attempt returned `retry` — mirroring how fix-ci/rebase
  // advance their own rounds only on their own remediation — so unrelated merge attempts (initial,
  // post-rebase, post-fix-ci, post-evict) can't consume the transient-retry budget. N consecutive
  // transient races then trip the `mergeRetryRound <= mergeRetryMax` gate at exactly the cap.
  assertStringIncludes(flat, "=if mergeStatus = &#34;retry&#34; then mergeRetryRound + 1 else mergeRetryRound");
});

test("the retry arm has NO remediation agent (contrast the conflict/rebase arm)", () => {
  // The base-moved race needs only a re-attempt on the settled base — no rebase/CI-fix agent. The
  // within-budget flow goes straight back to arm-merge, never through a `senior:*` task.
  assert(flowHasId("f_mr_go", "gw-merge-retry", "arm-merge"), "retry within-budget must go directly to arm-merge");
  // Sanity: the untouched blocked path still escalates directly (a genuine refusal is unchanged).
  assert(flowHasId("f_m_gBlocked", "gw-merge", "merge-esc-attempt"), "blocked → merge-esc-attempt must remain");
});
