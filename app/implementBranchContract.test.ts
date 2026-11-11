// DEFECT-CLASS GUARD (issue #945): every process path that activates an agent job backed by a
// repository envelope MUST name a deterministic `branch.create`, and that branch MUST be the one the
// agent's prompt tells it to use — `feat/<task.id>` (resources/prompts/feature.md). Before #945 the
// plan-fanout implement-cell carried NO `branch.create`: the deterministic branch existed only as
// prose in the prompt, so every c8ctl retry cut a random `nano/agent-work/*` fallback branch and the
// durable WIP checkpoint (keyed on `feat/<task.id>`) was never restored — each retry discarded the
// prior session's work. The root cause was a DRIFT SURFACE: two sources of truth (the prompt text and
// the envelope) for one fact.
//
// This guard pins the single source of truth (`sliceBranchCreate`, app/repoEnvelope.ts) and asserts
// every consumer derives the SAME branch from it, so a new agent-job-with-repo path — or an edit that
// re-introduces a hand-written branch — fails CI:
//
//  1. The ONE derivation: `sliceBranchCreate(taskId)` is `feat/<taskId>`, validated as a plausible git
//     ref (an ill-formed id degrades to omission, never an unusable branch.create).
//  2. Every consumer delegates to it: the whole-run feature seed (`feature.ts`), the implement-cell
//     reconcile lookup (`implementReconcile.ts` `implementCellBranch`), and the per-slice envelope
//     emission (`workers/caps-prepare`).
//  3. The prompt's branch instruction is the SAME `feat/<task.id>` the envelope cuts — the two read
//     off one value, not two.
//  4. The plan-fanout MI body runs the `caps-prepare` emitter BEFORE the `implement-cell` callActivity,
//     so the per-child `branch.create` is in scope when the implement-task job activates.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { implementCellBranch } from "./implementReconcile.ts";
import { AGENT_TASK_BRANCH_CREATE_VAR, sliceBranchCreate } from "./repoEnvelope.ts";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../resources/processes");
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../resources/prompts");

function flat(rel: string): string {
  return readFileSync(join(PROCESSES_DIR, rel), "utf8").replace(/\s+/g, " ");
}

test("contract: sliceBranchCreate is the ONE canonical feat/<task.id> derivation (#945)", () => {
  // The deterministic branch for a real task id.
  assertEquals(sliceBranchCreate("issue-7"), "feat/issue-7");
  assertEquals(sliceBranchCreate("tool-metadata-engine"), "feat/tool-metadata-engine");
  assertEquals(sliceBranchCreate("t1"), "feat/t1");
  // A blank / missing id yields NO branch (the caller degrades to omission, never a bare `feat/`).
  assertEquals(sliceBranchCreate(""), null);
  assertEquals(sliceBranchCreate("   "), null);
  assertEquals(sliceBranchCreate(null), null);
  assertEquals(sliceBranchCreate(undefined), null);
  // An id whose derived branch is not a plausible git ref degrades to null (no unusable branch.create).
  assertEquals(sliceBranchCreate("bad..id"), null);
  assertEquals(sliceBranchCreate("has space"), null);
});

test("contract: every implement-cell branch consumer derives from the ONE source (#945)", () => {
  // The reconcile lookup (`implementCellBranch`) — which finds the adoptable PR on the slice's branch —
  // MUST name the same branch the harness cuts (the envelope) and the prompt instructs. It delegates to
  // `sliceBranchCreate`, so the two can never drift.
  for (const taskId of ["issue-7", "tool-metadata-engine", "t1"]) {
    assertEquals(
      implementCellBranch(taskId),
      sliceBranchCreate(taskId),
      `implementCellBranch(${taskId}) must equal the canonical sliceBranchCreate (one source)`,
    );
  }
});

test("contract: the agent prompt's branch instruction is the SAME feat/<task.id> the envelope cuts (#945)", () => {
  // The implement-cell's base prompt (feature.md) tells the agent to branch `feat/<task.id>`. That
  // prose is the SECOND half of the contract — it must name the very branch `sliceBranchCreate`
  // derives for the envelope, so the agent's self-cut branch (pre-#945 fallback) and the harness-cut
  // branch (post-#945) are identical. Pin the literal placeholder so a prompt edit that renames the
  // branch convention fails here.
  const prompt = readFileSync(join(PROMPTS_DIR, "feature.md"), "utf8");
  assert(
    prompt.includes("feat/<task.id>"),
    "feature.md must instruct the agent to branch `feat/<task.id>` — the same branch sliceBranchCreate derives",
  );
  // And the derivation of a concrete id must slot into that placeholder exactly.
  assertEquals(`feat/<task.id>`.replace("<task.id>", "t1"), sliceBranchCreate("t1"));
});

test("contract: the plan-fanout MI body runs the caps-prepare branch.create emitter BEFORE implement-cell (#945)", () => {
  // The per-slice `branch.create` is stamped by the `pr.caps-prepare` worker (it alone runs per MI
  // child and reads that child's `task.id`). For the implement-task job to carry it, caps-prepare must
  // run upstream of the `implement-cell` callActivity inside the wave subprocess. Pin that wiring: the
  // caps-prepare task is declared, AND the implement-cell callActivity is declared, AND caps-prepare's
  // outgoing path reaches the implement-cell (both live in the same MI body, caps-prepare first).
  const xml = flat("plan-fanout.bpmn");
  assert(
    /<zeebe:taskDefinition type="pr\.caps-prepare"/.test(xml),
    "plan-fanout must declare the pr.caps-prepare task (the per-slice branch.create emitter)",
  );
  assert(
    /<bpmn:callActivity[^>]*id="implement-cell-call"/.test(xml) &&
      /<zeebe:calledElement processId="implement-cell"/.test(xml),
    "plan-fanout must compose the per-wave implement step as a callActivity to implement-cell",
  );
  // Ordering: within the wave MI body, caps-prepare's sequence flow leads (transitively) to the
  // implement-cell call. Both are in the same subprocess; assert caps-prepare appears before the
  // implement-cell callActivity in the model so the variable is in scope at activation.
  assert(
    xml.indexOf('type="pr.caps-prepare"') < xml.indexOf('id="implement-cell-call"'),
    "caps-prepare must be modelled before the implement-cell call so the per-child branch.create is in scope",
  );
});

test("contract: the per-slice branch.create rides the FLAT dotted variable the harness reads (#945)", () => {
  // The emission channel is a process variable literally NAMED `io.nanobpm.agentTask.branch.create` —
  // the dotted key the harness's `collectEnvelopeFrom` reassembles and deep-merges with the whole-object
  // seed envelope. Pin the constant to that exact dotted name so a refactor can't silently move it to a
  // nested object (a `<zeebe:ioMapping>` dotted target) the harness never reads.
  assertEquals(AGENT_TASK_BRANCH_CREATE_VAR, "io.nanobpm.agentTask.branch.create");
  assert(
    AGENT_TASK_BRANCH_CREATE_VAR.startsWith("io.nanobpm.agentTask."),
    "the per-slice branch.create variable must live under the reserved io.nanobpm.agentTask namespace",
  );
});
