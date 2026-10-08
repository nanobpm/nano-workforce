// DEFECT-CLASS GUARD (PR #881 review, thread r4214170285): `agentSlaJobType` is the marker that
// selects the agent-SLA escalation builder in the four recorder workers (`pr.persist-escalation`,
// `pr.record-feature-escalation`, `pr.record-trial-merge`, `pr.conformance-record`). It is set
// ONLY by the BPMN SLA arm (an interrupting timer boundary's route), never by the agent — but the
// c8ctl harness HOISTS the agent's result-JSON keys into the SAME process-variable namespace the
// recorders read it from. So a NORMAL (non-SLA) agent result that happens to carry an
// `agentSlaJobType` key would wrongly select the SLA builder and replace a genuine question or
// audit summary with a timeout diagnosis.
//
// This is the exact defect class PR #864 (review r4181010853) already closed for the boolean
// SLA-control flags `agentSlaElapsed` / `preserveConformance` — by pinning each to a LITERAL on
// every recorder task's ioMapping so hoisted agent output can never select the internal control
// path. `agentSlaJobType` was left unpinned. This guard closes that gap: every NORMAL-path recorder
// (one that does NOT set the marker to a real job-type literal) must pin `agentSlaJobType` to the
// `=null` literal, so a hoisted agent-supplied value is overridden to null on the normal path.
// SLA-arm recorders legitimately pin it to a job-type literal (e.g. `="senior:feature"`); those
// are the trusted source and are NOT required to pin null.
//
// The guard scans the deployed corpus and fails if any recorder task reads `agentSlaJobType`
// without pinning it to a literal (null on the normal path, a job-type on an SLA arm) — so a
// newly-added or edited recorder can never re-open the hole.
//
// EXCEPTION — merge-loop's SHARED SLA-sink recorders (PR #881 review, adversarial round 3): unlike
// the other processes, merge-loop has NO dedicated `*-sla` recorder task. Its fix-ci / rebase
// interrupting-SLA arms (`end_ci_sla` → "senior:fix-ci", `end_reb_sla` → "senior:rebase") and its
// NON-SLA escalation arms CONVERGE on the SAME two recorders (`merge-esc-attempt`,
// `merge-esc-conflict`). So those two recorders MUST READ `agentSlaJobType` from process scope
// (set by the trusted SLA end event) — a blanket `=null` input pin there would clobber the
// legitimate SLA job type and silently regress the issue-#879 never-started-vs-hung diagnosis. The
// hoisted-agent-output hole is closed on these shared sinks a DIFFERENT way: every path that can
// carry a hoisted (spoofable) value CLEARS `agentSlaJobType` to null via an OUTPUT mapping before
// it reaches the recorder — at the loop head (`arm-merge`, scrubbing any stale/cross-iteration
// value) and on the two non-SLA escalate end events that bypass the loop head (`end_ci_esc`,
// `end_reb_blocked`). Only the trusted SLA arms leave it set. This guard therefore (a) requires the
// shared sinks to NOT pin, and (b) requires those clears + the SLA-arm literals to exist.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "#test-assert";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../resources/processes");
const PROCESS_FILES = [
  "convergence-loop.bpmn",
  "merge-loop.bpmn",
  "implement-cell.bpmn",
  "merge-cell.bpmn",
  "plan-fanout.bpmn",
  "retro.bpmn",
];

// The recorder job types that read `agentSlaJobType` to select the SLA builder.
const RECORDER_TYPES = [
  "pr.persist-escalation",
  "pr.record-feature-escalation",
  "pr.record-trial-merge",
  "pr.conformance-record",
];

const SERVICE_TASK = /<bpmn:serviceTask\b[\s\S]*?<\/bpmn:serviceTask>/g;
// A trusted pin is a LITERAL input: `=null` (normal path) or `="..."`/`=&#34;...&#34;` (SLA arm's
// job-type). A process-variable REFERENCE (e.g. `=agentSlaJobType`) is NOT a pin — it would read
// hoisted agent output, which is exactly the hole being closed.
const LITERAL_PIN =
  /<zeebe:input\s+source="=(?:null|&#[0-9]+;[^"]*&#[0-9]+;|"[^"]*")"\s+target="agentSlaJobType"\s*\/>/;

// Any INPUT mapping on `agentSlaJobType` (literal OR reference) — used to assert the shared SLA-sink
// recorders carry NONE (they must read the SLA arm's value from process scope, not shadow it).
const ANY_INPUT_PIN = /<zeebe:input\s+source="=[^"]*"\s+target="agentSlaJobType"\s*\/>/;
// A `=null` OUTPUT clear (writes process scope) — the fail-closed scrub on merge-loop's spoofable
// non-SLA paths.
const NULL_OUTPUT_CLEAR = /<zeebe:output\s+source="=null"\s+target="agentSlaJobType"\s*\/>/;

// merge-loop's two SHARED SLA-sink recorders: both SLA and non-SLA arms converge on them, so they
// MUST read `agentSlaJobType` from scope and MUST NOT pin it (see header).
const SHARED_SLA_SINKS = new Set(["merge-esc-attempt", "merge-esc-conflict"]);

/** Extract the XML block for a BPMN element by id (any element tag). */
function elementBlock(xml: string, id: string): string | undefined {
  const re = new RegExp(`<bpmn:(\\w+)\\b[^>]*\\bid="${id}"[\\s\\S]*?</bpmn:\\1>`);
  return xml.match(re)?.[0];
}

test("DEFECT-CLASS GUARD: every SLA-builder recorder pins agentSlaJobType to a literal (agent output cannot select the SLA path)", () => {
  let recorderCount = 0;
  for (const file of PROCESS_FILES) {
    const xml = readFileSync(join(PROCESSES_DIR, file), "utf8");
    for (const [block] of xml.matchAll(SERVICE_TASK)) {
      if (!RECORDER_TYPES.some((t) => block.includes(`type="${t}"`))) continue;
      const id = block.match(/<bpmn:serviceTask\b[^>]*\bid="([^"]*)"/)?.[1] ?? "(unknown)";
      // The shared SLA-sink recorders read the marker from scope — they must NOT pin it, else a
      // `=null` pin would clobber the trusted SLA job type (issue #879 regression). They are
      // protected by the OUTPUT clears asserted below, not by an input pin.
      if (SHARED_SLA_SINKS.has(id)) {
        assert(
          !ANY_INPUT_PIN.test(block),
          `${file}: shared SLA-sink recorder "${id}" must NOT pin agentSlaJobType — both the SLA ` +
            `and non-SLA arms converge on it, so it must READ the SLA end event's value from ` +
            `process scope. A =null pin here clobbers the trusted SLA job type and regresses the ` +
            `never-started-vs-hung diagnosis (PR #881 adversarial review). Remove the pin; the ` +
            `hole is closed by the =null OUTPUT clears on arm-merge / end_ci_esc / end_reb_blocked.`,
        );
        continue;
      }
      recorderCount++;
      assert(
        LITERAL_PIN.test(block),
        `${file}: recorder task "${id}" reads agentSlaJobType but does not pin it to a literal ` +
          `(=null on the normal path, a job-type literal on an SLA arm). A hoisted agent result ` +
          `carrying agentSlaJobType would wrongly select the SLA escalation builder (PR #881 review ` +
          `r4214170285). Pin it: <zeebe:input source="=null" target="agentSlaJobType" /> on the ` +
          `normal path.`,
      );
    }
  }
  // Sanity: the guard is not vacuously green — the corpus really has these recorders (the
  // normal-path recorders + the SLA arms across the six processes).
  assert(recorderCount >= 11, `expected >=11 SLA-builder recorder tasks, found ${recorderCount}`);
});

test("DEFECT-CLASS GUARD: merge-loop's shared SLA sinks are fed a trusted agentSlaJobType (SLA arms set it; spoofable non-SLA paths clear it)", () => {
  const xml = readFileSync(join(PROCESSES_DIR, "merge-loop.bpmn"), "utf8");

  // The two shared sinks really exist and read from scope (no input pin) — guards against the file
  // being renamed/removed and silently passing.
  for (const id of SHARED_SLA_SINKS) {
    const block = elementBlock(xml, id);
    assert(block, `merge-loop.bpmn: expected shared SLA-sink recorder "${id}" to exist`);
    assert(
      !ANY_INPUT_PIN.test(block),
      `merge-loop.bpmn: "${id}" must read agentSlaJobType from scope, not pin it`,
    );
  }

  // The trusted SLA arms SET the job-type literal (this is the value the shared sinks must receive).
  for (const [id, literal] of [
    ["end_ci_sla", "senior:fix-ci"],
    ["end_reb_sla", "senior:rebase"],
  ] as const) {
    const block = elementBlock(xml, id);
    assert(block, `merge-loop.bpmn: expected SLA arm "${id}" to exist`);
    const re = new RegExp(
      `<zeebe:output\\s+source="=&#34;${literal.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}&#34;"\\s+target="agentSlaJobType"\\s*/>`,
    );
    assert(
      re.test(block),
      `merge-loop.bpmn: SLA arm "${id}" must set agentSlaJobType to the "${literal}" literal via ` +
        `an output mapping (the trusted source the shared sink reads).`,
    );
  }

  // Every spoofable path that can carry a hoisted agentSlaJobType into a shared sink CLEARS it to
  // null via output BEFORE the recorder: the loop head (stale/cross-iteration) and the two non-SLA
  // escalate end events that bypass the loop head (same-iteration agent spoof).
  for (const id of ["arm-merge", "end_ci_esc", "end_reb_blocked"]) {
    const block = elementBlock(xml, id);
    assert(block, `merge-loop.bpmn: expected "${id}" to exist`);
    assert(
      NULL_OUTPUT_CLEAR.test(block),
      `merge-loop.bpmn: "${id}" must clear agentSlaJobType to null via ` +
        `<zeebe:output source="=null" target="agentSlaJobType" /> so a hoisted (spoofable) agent ` +
        `value can never reach the shared SLA-sink recorder and fabricate a never-started/hung ` +
        `SLA diagnosis (PR #881 adversarial review).`,
    );
  }
});
