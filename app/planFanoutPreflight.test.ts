// Structural guard for the inter-epic capability PREFLIGHT wired into plan-fanout (issue #292, slice
// S3). Before S3, `plan-fanout.bpmn` fanned out every epic immediately and `readiness-gate.bpmn` was a
// standalone process it never invoked. S3 seeds a LEADING capability readiness-gate before wave 0 for
// dependent epics: an exclusive gateway after Start routes a ROOT (readinessProbes == null) straight to
// ensure-base-branch, and a DEPENDENT into a multi-instance preflight subprocess (over =readinessProbes)
// that polls each producer's capability via the reused `pr.readiness-probe` worker and escalates
// (bounded) via the reused `readiness-escalation` form — never fanning a wave until the gate is green.
// The bound `pkg@version`s (resolvedArtifacts) ride the implement task's appendPrompt.
//
// Pure text assertions over the committed BPMN (no engine), matching the repo's model-guard style
// (see mergeEscalationUserTask.test.ts / mergeRebaseArm.test.ts).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";

const bpmn = readFileSync("resources/processes/plan-fanout.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

function hasFlow(source: string, target: string): boolean {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*\\bsourceRef="${source}"[^>]*\\btargetRef="${target}"|` +
      `<bpmn:sequenceFlow\\b[^>]*\\btargetRef="${target}"[^>]*\\bsourceRef="${source}"`,
  );
  return re.test(flat);
}

test("Start routes through a readiness gateway that a ROOT skips and a DEPENDENT enters", () => {
  assert(hasFlow("Start", "gw-readiness"), "Start must reach the readiness gateway");
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-readiness"[\s\S]*?<\/bpmn:exclusiveGateway>/);
  assert(gw, "gw-readiness must be an exclusiveGateway");
  // Default (root) skips straight to ensure-base-branch; the gated flow enters the preflight only when
  // readinessProbes is present (a dependent).
  assertStringIncludes(gw![0], 'default="f_readiness_skip"', "root (no probes) is the default skip flow");
  assert(hasFlow("gw-readiness", "ensure-base-branch"), "root skips straight to ensure-base-branch");
  assert(hasFlow("gw-readiness", "readiness-preflight"), "dependent enters the preflight subprocess");
  const gate = flat.match(/<bpmn:sequenceFlow\b[^>]*\bid="f_readiness_gate"[\s\S]*?<\/bpmn:sequenceFlow>/);
  assert(gate, "the gated flow must be conditional");
  assertStringIncludes(gate![0], "readinessProbes != null", "only a dependent (has probes) is gated");
});

test("the preflight is a multi-instance subprocess over =readinessProbes collecting resolvedArtifacts", () => {
  const sub = flat.match(/<bpmn:subProcess\b[^>]*\bid="readiness-preflight"[\s\S]*?<\/bpmn:subProcess>/);
  assert(sub, "readiness-preflight must be a subProcess");
  assertStringIncludes(sub![0], "<bpmn:multiInstanceLoopCharacteristics", "it waits for ALL producers in parallel");
  assertStringIncludes(sub![0], 'inputCollection="=readinessProbes"', "one instance per seeded capability probe");
  assertStringIncludes(sub![0], 'outputCollection="resolvedArtifacts"', "binds each resolved pkg@version");
  assert(hasFlow("readiness-preflight", "ensure-base-branch"), "the gate leads into the fan-out, before wave 0");
});

test("the preflight reuses the pr.readiness-probe worker and the readiness-escalation form (no reinvention)", () => {
  assertStringIncludes(flat, 'type="pr.readiness-probe"', "reuses the existing capability probe worker");
  assertStringIncludes(flat, 'value="ReadinessProbeIn"', "feeds the shared probe input envelope");
  assertStringIncludes(flat, 'value="ReadinessProbeOut"', "reads the shared probe output envelope");
  assertStringIncludes(flat, 'formId="readiness-escalation"', "reuses the existing readiness escalation form");
});

test("a never-green producer escalates (bounded) without wedging: probe timeout + SLA both settle the gate", () => {
  // The probe loop carries an interrupting timeout bound (reuses the gate's =probeTimeout), and the
  // human escalation carries the shared SLA bound — so a stuck producer can never wedge the dependent.
  assertStringIncludes(flat, "=probeTimeout", "the probe loop is bounded by the reused =probeTimeout");
  assertStringIncludes(flat, "=probePollEvery", "retry cadence is driven by the engine timer");
  assertStringIncludes(flat, "=escalationSlaTimeout", "the escalation is bounded by the shared SLA");
  assert(hasFlow("be_pf_probe_timeout", "preflight-probe-last-attempt"), "a timed-out loop routes to one last empirical probe");
  assert(hasFlow("preflight-probe-last-attempt", "pf_gw"), "the last attempt can still take the ready path");
  assert(hasFlow("pf_gw", "readiness-escalation-pf"), "a not-ready final probe routes to escalation");
  assert(hasFlow("be_pf_sla", "pf_end"), "an elapsed escalation SLA settles the preflight instead of wedging");
});

test("the bound resolvedArtifacts version rides the implement task's appendPrompt", () => {
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="implement-task"[\s\S]*?<\/bpmn:serviceTask>/);
  assert(task, "implement-task must exist");
  assertStringIncludes(task![0], "resolvedArtifacts", "the bound pkg@version is threaded into the slice prompt");
});
