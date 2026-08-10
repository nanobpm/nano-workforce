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

import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const bpmn = await Deno.readTextFile("resources/processes/merge-loop.bpmn");

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

Deno.test("conflict routes to the rebase budget gate, not straight to a human", () => {
  // The conflict verdict must reach the auto-rebase gate…
  assert(hasFlow("gw-mergeable", "gw-rebase"), "gw-mergeable → gw-rebase (conflict) missing");
  // …guarded by the exact conflict condition (DIRTY → mergeState = "conflict").
  assertStringIncludes(flat, 'mergeState = "conflict"');
});

Deno.test("rebase arm mirrors the fix-ci arm: budget gate → agent → result gate", () => {
  // Budget gate: within budget → the agent; exhausted → the (existing) conflict escalation.
  assert(hasFlow("gw-rebase", "rebase"), "gw-rebase → rebase (within budget) missing");
  assert(hasFlow("gw-rebase", "merge-esc-conflict"), "gw-rebase → merge-esc-conflict (budget exhausted) missing");
  assertStringIncludes(flat, "rebaseRound &lt; rebaseMax");

  // The agent is the senior:rebase fleet task, carrying its base prompt via the {{rebase}} header.
  assertStringIncludes(flat, 'type="senior:rebase"');
  assertStringIncludes(flat, 'value="{{rebase}}"');

  // Agent → result gate; the round counter advances so the budget can actually be exhausted.
  assert(hasFlow("rebase", "gw-rebase-result"), "rebase → gw-rebase-result missing");
  assertStringIncludes(flat, "=rebaseRound + 1");
});

Deno.test("rebase result: success re-arms the poller; unresolved escalates to a human", () => {
  // Success loops back to re-attempt the merge — forward progress, no human needed.
  assert(hasFlow("gw-rebase-result", "arm-merge"), "gw-rebase-result → arm-merge (rebased) missing");
  assertStringIncludes(flat, 'status = "rebased"');
  // A genuine (semantic) conflict the agent can't resolve escalates to the human attempt path.
  assert(
    hasFlow("gw-rebase-result", "merge-esc-attempt"),
    "gw-rebase-result → merge-esc-attempt (could not resolve) missing",
  );
});

Deno.test("regression: the conflict verdict passes through the rebase actor, not straight to escalation", () => {
  // The original #42 livelock had the conflict verdict escalate to a human with no remediation
  // actor. The primary target of the conflict verdict must now be the rebase gate.
  assert(
    hasFlow("gw-mergeable", "gw-rebase"),
    "conflict must reach the rebase gate (the #42 remediation actor)",
  );
  // Sanity: the untouched ready path still lands the merge directly.
  assert(hasFlow("gw-mergeable", "attempt-merge"), "ready → attempt-merge path should still exist");
});
