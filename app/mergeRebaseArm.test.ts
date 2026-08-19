// Structural regression guard for the merge-loop rebase remediation arm (issue #42).
//
// #42: the conflict arm routed a human's escalation answer straight back to `arm-merge`
// (`f_m_answer → arm-merge`) with NO actor that rebases the branch, so a `CONFLICTING`
// (moved-base) PR re-escalated forever — a human-in-the-loop livelock. The fix mirrors the
// CI-fix arm: a `mergeState = "conflict"` verdict goes to a budgeted `senior:rebase` agent, and
// escalates to a human only on the result gate.
//
// This test asserts the arm's topology on the committed model so it cannot regress silently the
// way it originally shipped. It is a pure text assertion over the BPMN (no engine), matching the
// repo's lightweight model-guard style.

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/merge-loop.bpmn", "utf8");

// Collapse whitespace so attribute-order / line-wrapping churn doesn't make the assertions brittle.
const flat = bpmn.replace(/\s+/g, " ");

// A `<sequenceFlow>` whose source/target match, regardless of attribute order or an inline
// conditionExpression child. Returns true if such a flow is present.
function hasFlow(source: string, target: string): boolean {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*\\bsourceRef="${source}"[^>]*\\btargetRef="${target}"|` +
      `<bpmn:sequenceFlow\\b[^>]*\\btargetRef="${target}"[^>]*\\bsourceRef="${source}"`,
  );
  return re.test(flat);
}

// Assert a specific `<sequenceFlow>` (matched by id) has the given source/target, regardless of
// attribute order. Unlike `hasFlow`, this pins the *named* flow so a test can't be satisfied by a
// sibling flow that happens to share the same source/target (e.g. a success arm masking a default).
function flowHasId(id: string, source: string, target: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:sequenceFlow\\b[^>]*\\bid="${id}"[^>]*/?>`));
  if (!m) return false;
  const tag = m[0];
  return tag.includes(`sourceRef="${source}"`) && tag.includes(`targetRef="${target}"`);
}

// Assert an `<exclusiveGateway>` (matched by id) declares the given `default` flow, regardless of
// attribute order. Matching the start tag by id and reading `default` from it keeps the guard
// robust to harmless XML reformatting (attribute reordering / wrapping) that a fixed-order literal
// substring would spuriously trip on.
function gatewayDefault(id: string, def: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:exclusiveGateway\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!m) return false;
  return m[0].includes(`default="${def}"`);
}

test("conflict routes to the rebase budget gate, not straight to a human", () => {
  // The conflict verdict must reach the auto-rebase gate…
  assert(hasFlow("gw-mergeable", "gw-rebase"), "gw-mergeable → gw-rebase (conflict) missing");
  // …guarded by the exact conflict condition (DIRTY → mergeState = "conflict").
  assertStringIncludes(flat, 'mergeState = "conflict"');
});

test("rebase arm mirrors the fix-ci arm: budget gate → agent → result gate", () => {
  // Budget gate: within budget → the agent; exhausted → the (existing) conflict escalation.
  assert(hasFlow("gw-rebase", "rebase"), "gw-rebase → rebase (within budget) missing");
  assert(hasFlow("gw-rebase", "merge-esc-conflict"), "gw-rebase → merge-esc-conflict (budget exhausted) missing");
  assertStringIncludes(flat, "rebaseRound &lt; rebaseMax");

  // The agent is the senior:rebase fleet task, carrying its base prompt via the rebase.md linked resource.
  assertStringIncludes(flat, 'type="senior:rebase"');
  assertStringIncludes(flat, 'resourceId="rebase.md"');

  // Agent → result gate; the round counter advances so the budget can actually be exhausted.
  assert(hasFlow("rebase", "gw-rebase-result"), "rebase → gw-rebase-result missing");
  assertStringIncludes(flat, "=rebaseRound + 1");
});

test("rebase result: success re-arms the poller; unresolved escalates to a human", () => {
  // Success loops back to re-attempt the merge — forward progress, no human needed.
  assert(hasFlow("gw-rebase-result", "arm-merge"), "gw-rebase-result → arm-merge (rebased) missing");
  assertStringIncludes(flat, 'status = "rebased"');
  // A genuine (semantic) conflict the agent can't resolve escalates to the human attempt path.
  assert(
    hasFlow("gw-rebase-result", "merge-esc-attempt"),
    "gw-rebase-result → merge-esc-attempt (could not resolve) missing",
  );
});

test("rebase result: a missing/ambiguous status reconciles from ground truth, not escalation (#134)", () => {
  // #134 / Magikcraft/nano-bpm#751: the rebase agent resolved everything and the PR became
  // MERGEABLE, but it emitted no machine-readable `status`, so the old default arm escalated a
  // PR that was already landable. Ground truth is authoritative: the default (no-verdict) arm
  // now re-arms the merge poller, which re-checks `gw-mergeable` from GitHub state — bounded by
  // the existing rebaseMax budget — instead of pulling in a human.
  assert(
    gatewayDefault("gw-rebase-result", "f_reb_reconcile"),
    'gw-rebase-result must default to f_reb_reconcile (reconcile)',
  );
  // Pin the *default* reconcile flow itself, not just any gw-rebase-result → arm-merge edge (the
  // success arm `f_reb_rebased` shares that target), so a mis-wired default can't pass silently.
  assert(
    flowHasId("f_reb_reconcile", "gw-rebase-result", "arm-merge"),
    "f_reb_reconcile must default gw-rebase-result → arm-merge (reconcile)",
  );
  // Escalation is now reserved for the agent's explicit "I cannot proceed" verdict.
  assertStringIncludes(flat, 'id="f_reb_blocked"');
  const rebBlocked = flat.match(/<bpmn:sequenceFlow[^>]*id="f_reb_blocked"[\s\S]*?<\/bpmn:sequenceFlow>/);
  assert(rebBlocked, "f_reb_blocked flow missing");
  assertStringIncludes(rebBlocked![0], 'status = "blocked"');
});

test("ci-fix result: a missing/ambiguous status reconciles from ground truth, not escalation (#134)", () => {
  // Symmetric to the rebase arm: the CI-fix agent's no-verdict default re-arms the merge poller
  // (ground-truth re-check, bounded by ciFixMax) rather than escalating a possibly-green PR.
  assert(
    gatewayDefault("gw-ci-result", "f_ci_reconcile"),
    'gw-ci-result must default to f_ci_reconcile (reconcile)',
  );
  // Pin the *default* reconcile flow itself, not just any gw-ci-result → arm-merge edge (the
  // success arm `f_ci_fixed` shares that target), so a mis-wired default can't pass silently.
  assert(
    flowHasId("f_ci_reconcile", "gw-ci-result", "arm-merge"),
    "f_ci_reconcile must default gw-ci-result → arm-merge (reconcile)",
  );
  // Escalation reserved for the agent's explicit `blocked` verdict — but now via a
  // reconcile-before-escalate guard (issue #348): a `blocked` with no push reconciles once from
  // ground truth, and only a still-blocked PR reaches the human escalation.
  const ciBlocked = flat.match(/<bpmn:sequenceFlow[^>]*id="f_ci_blocked"[\s\S]*?<\/bpmn:sequenceFlow>/);
  assert(ciBlocked, "f_ci_blocked flow missing");
  assertStringIncludes(ciBlocked![0], 'status = "blocked"');
  assert(hasFlow("gw-ci-result", "gw-ci-blocked"), "blocked verdict must pass through gw-ci-blocked (reconcile-before-escalate)");
  assert(hasFlow("gw-ci-blocked", "merge-esc-attempt"), "gw-ci-blocked → merge-esc-attempt (still blocked) missing");
});

test("regression: the conflict verdict passes through the rebase actor, not straight to escalation", () => {
  // The original #42 livelock had the conflict verdict escalate to a human with no remediation
  // actor. The primary target of the conflict verdict must now be the rebase gate.
  assert(
    hasFlow("gw-mergeable", "gw-rebase"),
    "conflict must reach the rebase gate (the #42 remediation actor)",
  );
  // Sanity: the untouched ready path still lands the merge directly.
  assert(hasFlow("gw-mergeable", "attempt-merge"), "ready → attempt-merge path should still exist");
});
