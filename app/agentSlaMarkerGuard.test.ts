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

test("DEFECT-CLASS GUARD: every SLA-builder recorder pins agentSlaJobType to a literal (agent output cannot select the SLA path)", () => {
  let recorderCount = 0;
  for (const file of PROCESS_FILES) {
    const xml = readFileSync(join(PROCESSES_DIR, file), "utf8");
    for (const [block] of xml.matchAll(SERVICE_TASK)) {
      if (!RECORDER_TYPES.some((t) => block.includes(`type="${t}"`))) continue;
      const id = block.match(/<bpmn:serviceTask\b[^>]*\bid="([^"]*)"/)?.[1] ?? "(unknown)";
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
  // Sanity: the guard is not vacuously green — the corpus really has these recorders (the 11
  // normal-path recorders + the SLA arms across the six processes).
  assert(recorderCount >= 11, `expected >=11 SLA-builder recorder tasks, found ${recorderCount}`);
});
