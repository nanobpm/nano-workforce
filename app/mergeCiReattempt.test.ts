// Structural regression guard for the CI-concurrency-cancellation drift class (issue #348).
//
// The merge loop escalated a human whenever `senior:fix-ci` returned `blocked` — even when the
// failing required checks were STALE/TRANSIENT (CANCELLED runs superseded by a newer green run on
// the identical head SHA) and the agent honestly pushed nothing. The `fix-ci` prompt actively
// funnelled that self-healing case into `blocked`, and `blocked` routed straight to the merge
// escalation user task. A phantom-blocked, self-healing merge paged a human.
//
// The fix adds a first-class re-attempt path and a reconcile-before-escalate guard:
//
//   1. `status = "reattempt"` (a first-class fix-ci verdict for stale/transient checks) routes to
//      `arm-merge`, re-queuing the merge from ground truth — no human, and declared explicitly
//      beside the `f_ci_reconcile` empty-status default rather than relying on the fall-through.
//   2. A `blocked` verdict with no push (`pushed != true`) reconciles ONCE via ground truth
//      (`gw-ci-blocked` → `ci-reconcile` → re-arm the poller) and escalates only if it is STILL
//      blocked — so even a mislabelled `blocked` self-heals.
//
// Pure text assertions over the committed BPMN (no engine), matching the repo's lightweight
// model-guard style (see mergeEscalationQuestion.test.ts, mergeRebaseArm.test.ts).

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/merge-loop.bpmn", "utf8");
// Collapse whitespace so attribute-order / line-wrapping churn doesn't make the assertions brittle.
const flat = bpmn.replace(/\s+/g, " ");

function flowElement(id: string): string | null {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*?\\bid="${id}"[^>]*?(?:/>|>(?:(?!<bpmn:sequenceFlow\\b).)*?</bpmn:sequenceFlow>)`,
  );
  const m = flat.match(re);
  return m ? m[0] : null;
}

function flowHasId(id: string, source: string, target: string): boolean {
  const el = flowElement(id);
  if (!el) return false;
  return el.includes(`sourceRef="${source}"`) && el.includes(`targetRef="${target}"`);
}

function serviceTask(id: string): string | null {
  const m = flat.match(new RegExp(`<bpmn:serviceTask\\b[^>]*\\bid="${id}"[\\s\\S]*?</bpmn:serviceTask>`));
  return m ? m[0].replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&#10;/g, "\n") : null;
}

test("a first-class `reattempt` verdict re-attempts the merge (arm-merge), not escalation", () => {
  // gw-ci-result must carry an explicit `status = "reattempt"` arm to arm-merge, declared beside
  // (not folded into) the empty-status `f_ci_reconcile` default.
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-ci-result"[\s\S]*?<\/bpmn:exclusiveGateway>/);
  assert(gw, "gw-ci-result gateway must exist");
  assertStringIncludes(gw![0], "f_ci_reattempt", "gw-ci-result must declare the reattempt outgoing arm");

  const reattempt = flowElement("f_ci_reattempt");
  assert(reattempt, "f_ci_reattempt flow missing");
  assert(
    flowHasId("f_ci_reattempt", "gw-ci-result", "arm-merge"),
    "a reattempt verdict must re-arm the merge poller (arm-merge), never escalate",
  );
  assertStringIncludes(reattempt!, 'status = "reattempt"', "the reattempt arm must be gated on status = reattempt");
  // It must be an EXPLICIT labelled flow, not the empty-status default.
  assert(!/default="f_ci_reattempt"/.test(flat), "reattempt must be an explicit arm, not the gateway default");
});

test("a fix-ci `reattempt` result does NOT create a merge escalation", () => {
  // No flow originating from the reattempt classification may reach the merge-escalation task.
  assert(
    !flowHasId("f_ci_reattempt", "gw-ci-result", "merge-esc-attempt"),
    "reattempt must never route to merge-esc-attempt",
  );
});

test("a blocked-with-no-push verdict reconciles once from ground truth before escalating", () => {
  // The `blocked` arm no longer flows straight into the escalation: it passes through gw-ci-blocked.
  assert(
    flowHasId("f_ci_blocked", "gw-ci-result", "gw-ci-blocked"),
    "a blocked verdict must route through gw-ci-blocked, not straight to merge-esc-attempt",
  );

  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-ci-blocked"[^>]*>/);
  assert(gw, "gw-ci-blocked gateway must exist");
  // Default is escalate (still blocked), so a missing/true reconcile flag never wedges.
  assertStringIncludes(gw![0], 'default="f_cib_esc"', "gw-ci-blocked must default to escalation");

  // The reconcile-once arm: pushed nothing AND not yet reconciled → re-derive via ci-reconcile.
  const recon = flowElement("f_cib_recon");
  assert(recon, "f_cib_recon flow missing");
  assert(flowHasId("f_cib_recon", "gw-ci-blocked", "ci-reconcile"), "reconcile arm must target ci-reconcile");
  assertStringIncludes(recon!, "pushed != true", "reconcile only when the agent pushed nothing");
  assertStringIncludes(recon!, "ciBlockedReconciled != true", "reconcile at most once");

  // The escalate arm (default): still blocked → the human merge escalation.
  assert(flowHasId("f_cib_esc", "gw-ci-blocked", "merge-esc-attempt"), "the still-blocked arm must escalate");
  assert(
    !/conditionExpression/.test(flowElement("f_cib_esc") ?? ""),
    "f_cib_esc is the default arm and must not carry a conditionExpression",
  );
});

test("ci-reconcile re-arms the canonical merge poller and marks the reconcile as spent", () => {
  const el = serviceTask("ci-reconcile");
  assert(el, "ci-reconcile service task must exist");
  // Reuses the canonical arm-merge worker — one poller implementation, no second poller pass.
  assertStringIncludes(el!, 'type="pr.arm-merge"', "ci-reconcile must reuse the canonical pr.arm-merge worker");
  // Marks the reconcile spent so the SECOND blocked (still blocked after re-derivation) escalates.
  const outs = el!.match(/<zeebe:output\b[^>]*\/>/g) ?? [];
  assert(
    outs.some((t) => t.includes('target="ciBlockedReconciled"') && t.includes('source="=true"')),
    "ci-reconcile must set ciBlockedReconciled = true so a still-blocked PR escalates on the next pass",
  );
  // Re-derivation flows back through the mergeable wait (re-runs the ground-truth mergeable gate).
  assert(flowHasId("f_cib_armed", "ci-reconcile", "wait-mergeable"), "ci-reconcile must re-enter wait-mergeable");
});

test("arm-merge clears the reconcile flag each loop so a fresh block episode gets its own reconcile", () => {
  const el = serviceTask("arm-merge");
  assert(el, "arm-merge service task must exist");
  const outs = el!.match(/<zeebe:output\b[^>]*\/>/g) ?? [];
  assert(
    outs.some((t) => t.includes('target="ciBlockedReconciled"') && t.includes('source="=null"')),
    "arm-merge must reset ciBlockedReconciled each loop so a later, unrelated block still reconciles once",
  );
});

test("regression: a stale/transient fix-ci result can no longer page a human", () => {
  // The old wedge: `status = "blocked"` flowing directly into merge-esc-attempt. The blocked
  // verdict now routes through gw-ci-blocked (reconcile-before-escalate), never straight to the
  // escalation.
  assert(
    !flowHasId("f_ci_blocked", "gw-ci-result", "merge-esc-attempt"),
    "the blocked verdict must not route directly into merge-esc-attempt (the #348 phantom escalation)",
  );
  // The blocked arm targets the reconcile gateway; the reattempt arm re-arms the poller. Neither
  // gw-ci-result arm may target the escalation directly.
  assertStringIncludes(flowElement("f_ci_blocked") ?? "", 'targetRef="gw-ci-blocked"');
  assertStringIncludes(flowElement("f_ci_reattempt") ?? "", 'targetRef="arm-merge"');
});
