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
//  4. Every execution path into the `implement-task` agent job passes through the `pr.slice-branch`
//     emitter, which runs INSIDE each implement-cell process instance (so siblings can't clobber it) —
//     checked on the sourceRef/targetRef graph, not on XML declaration order.
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

/** Parse the `<bpmn:sequenceFlow>` graph (sourceRef → targetRef) and the boundary-event attachments
 * (host → boundary, an implicit edge) of one process file. */
function flowGraph(xml: string): Map<string, string[]> {
  const g = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    g.set(from, [...(g.get(from) ?? []), to]);
  };
  for (const m of xml.matchAll(/<bpmn:sequenceFlow\b[^>]*>/g)) {
    const src = /sourceRef="([^"]+)"/.exec(m[0])?.[1];
    const tgt = /targetRef="([^"]+)"/.exec(m[0])?.[1];
    if (src && tgt) add(src, tgt);
  }
  for (const m of xml.matchAll(/<bpmn:boundaryEvent\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const host = /attachedToRef="([^"]+)"/.exec(m[0])?.[1];
    if (id && host) add(host, id);
  }
  return g;
}

/** Can `to` be reached from any of `from` without visiting `avoid`? */
function reachableAvoiding(g: Map<string, string[]>, from: string[], to: string, avoid: string): boolean {
  const seen = new Set<string>();
  const stack = from.filter((f) => f !== avoid);
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined || seen.has(n)) continue;
    if (n === to) return true;
    seen.add(n);
    for (const next of g.get(n) ?? []) if (next !== avoid) stack.push(next);
  }
  return false;
}

function startEvents(xml: string): string[] {
  return [...xml.matchAll(/<bpmn:startEvent\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1] ?? "");
}

test("contract: every path into the implement-task agent job passes through the slice-branch emitter (#945)", () => {
  const xml = flat("implement-cell.bpmn");
  assert(
    /<bpmn:serviceTask id="slice-branch"[^>]*> <bpmn:extensionElements> <zeebe:taskDefinition type="pr\.slice-branch"/.test(xml),
    "implement-cell must declare the slice-branch task backed by the pr.slice-branch worker",
  );
  const g = flowGraph(xml);
  const starts = startEvents(xml);
  assert(starts.length > 0, "implement-cell must have a start event");
  assert(reachableAvoiding(g, starts, "implement-task", "__none__"), "implement-task must be reachable at all");
  assert(
    !reachableAvoiding(g, starts, "implement-task", "slice-branch"),
    "no execution path may reach implement-task without first passing the slice-branch emitter",
  );
});

test("contract: the path checker detects a bypass of the emitter (guards the guard) (#945)", () => {
  const bypass = flat("implement-cell.bpmn").replace(
    /<bpmn:sequenceFlow id="ic_toSliceBranch" sourceRef="Start" targetRef="slice-branch" \/>/,
    '<bpmn:sequenceFlow id="ic_toSliceBranch" sourceRef="Start" targetRef="implement-task" />',
  );
  assert(bypass.includes('sourceRef="Start" targetRef="implement-task"'), "fixture rewrite must apply");
  assert(reachableAvoiding(flowGraph(bypass), startEvents(bypass), "implement-task", "slice-branch"));
});

test("contract: plan-fanout composes the implement step as a callActivity to implement-cell (#945)", () => {
  // The emitter must run in a SEPARATE process instance per slice (its result keys land on that
  // instance's root, never the shared epic root), so the MI body must call implement-cell rather than
  // inline the agent task.
  const xml = flat("plan-fanout.bpmn");
  assert(
    /<bpmn:callActivity[^>]*id="implement-cell-call"/.test(xml) &&
      /<zeebe:calledElement processId="implement-cell"/.test(xml),
    "plan-fanout must compose the per-wave implement step as a callActivity to implement-cell",
  );
  assert(!xml.includes('type="senior:feature"'), "plan-fanout must not inline the implement agent task");
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
