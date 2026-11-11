// pr.slice-branch — stamp the implement-cell agent job's deterministic per-slice `branch.create`
// (issue #945).
//
// Runs as the FIRST step of the `implement-cell` process, i.e. inside each slice's OWN called process
// instance. That is what makes the value child-local: a worker result key is propagated to the root
// of the process instance the job belongs to, and every implement-cell call is a separate instance —
// so sibling slices of one plan-fanout wave can never overwrite one another's branch (a key emitted
// from the plan-fanout MI body would land on the shared epic root, where a sibling's prepare could
// clobber it while this slice waits at its capability barrier).
//
// The value rides a result key literally NAMED `io.nanobpm.agentTask.branch.create`, which the engine
// materialises as a FLAT dotted process variable the c8ctl harness's `collectEnvelopeFrom` deep-merges
// with the whole-object seed envelope. A `<zeebe:ioMapping>` dotted target canNOT do this (it builds a
// nested object the harness never reads). It is derived via the ONE canonical `sliceBranchCreate`, so
// the envelope, the prompt's `feat/<task.id>` instruction, and the reconcile lookup share one source;
// a retry (record-implementing → implement-task) stays in the same instance and re-reads the SAME
// value, so the durable WIP checkpoint restore matches.
//
// PURE: no I/O. An implausible/missing `task.id` emits nothing (degrades to the agent cutting its own
// branch) rather than an unusable branch.create.
import type { AppJobHandler } from "@nanobpm/urban";
import { AGENT_TASK_BRANCH_CREATE_VAR, sliceBranchCreate } from "../../app/repoEnvelope.ts";

interface In {
  task?: unknown;
}

export function sliceTaskId(task: unknown): string | null {
  if (task === null || typeof task !== "object" || Array.isArray(task)) return null;
  const id: unknown = Reflect.get(task, "id");
  return typeof id === "string" ? id : null;
}

const handler: AppJobHandler<In, Record<string, unknown>> = async (job) => {
  const branchCreate = sliceBranchCreate(sliceTaskId(job.variables.task));
  return branchCreate !== null ? { [AGENT_TASK_BRANCH_CREATE_VAR]: branchCreate } : {};
};

export default handler;
