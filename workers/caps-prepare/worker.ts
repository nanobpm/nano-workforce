// pr.caps-prepare — hoist a task's capability-barrier key + gate flag into the MI-child scope
// (issue #289).
//
// The `implement` multi-instance subprocess must decide, PER child, whether the task declared
// cross-repo capability `needs` and — if so — park at the `wait-caps-resolved` message barrier keyed
// on a per-task correlation key. The MI `inputElement` `task` is only readable inside a *service
// task's* ioMapping in the WASM testkit (an in-subprocess gateway / catch reads a stale/empty value
// — see AGENTS.md "Testing flows against the testkit"). So this worker runs first in the subprocess,
// derives the barrier key + the boolean from `task`, and RETURNS them; the model hoists both into the
// child scope with `zeebe:output source="=var" target="var"` so the following gateway (`w_gw_needs`)
// and the catch event's `correlationKey=capsGateKey` can read them reliably.
//
// PURE: no I/O. `capsGateKey` MUST equal `capabilityTaskBarrierKey(planKey, taskId)` — the same key
// the host reconciler (`pollCapabilityGatesImpl`) publishes `caps-resolved` on — or the barrier never
// releases.
//
// Deterministic per-slice branch (issue #945): this worker ALSO stamps the implement-cell's
// repository envelope with the slice's deterministic `branch.create` (`feat/<task.id>`). The
// whole-epic seed (`startPlan`) emits the `io.nanobpm.agentTask` envelope with `repository` + `task`
// but NO `branch` — each slice's branch differs per MI child, so it can't be named at seed time.
// Without it, every c8ctl retry cut a random `nano/agent-work/*` fallback branch and the durable WIP
// checkpoint (keyed on `feat/<task.id>`) was never restored, discarding the prior session's work.
// Because this worker runs once per MI child (reading that child's `task.id`) BEFORE the
// `implement-cell` callActivity, returning the key here materialises it as a FLAT dotted process
// variable (`io.nanobpm.agentTask.branch.create`) in the child scope. The c8ctl harness's
// `collectEnvelopeFrom` deep-merges dotted-name variables with the whole-object seed envelope, so the
// implement-task job's merged envelope carries the right `branch.create` — and a retry re-derives the
// SAME branch (it is a pure function of `task.id`), so the checkpoint restore matches. The value is
// derived via the ONE canonical `sliceBranchCreate` so the envelope and the prompt's `feat/<task.id>`
// instruction share a single source. A `<zeebe:ioMapping>` dotted target canNOT do this (it builds a
// nested object the harness never reads) — only a worker result key literally NAMED with the dotted
// string materialises the flat variable.
import type { AppJobHandler } from "@nanobpm/urban";
import { capabilityTaskBarrierKey, parseCapabilityNeeds } from "../../app/capabilityNeed.ts";
import { AGENT_TASK_BRANCH_CREATE_VAR, sliceBranchCreate } from "../../app/repoEnvelope.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

type In = WorkerInputs["pr.caps-prepare"];
interface Out extends Record<string, unknown> {
  capsGateKey: string;
  hasNeeds: boolean;
}

const handler: AppJobHandler<In, Out> = async (job) => {
  const planKey = String(job.variables.planKey ?? "");
  const taskId = String(job.variables.taskId ?? "");
  // Tolerant re-parse: `needs` arrives as the modelled CapabilityNeed[] but a malformed entry must
  // never wedge the fan-out — drop it and gate only on the valid remainder (mirrors record-plan).
  const needs = parseCapabilityNeeds(job.variables.needs);
  // Issue #945: the deterministic per-slice `branch.create`. `sliceBranchCreate` returns null for an
  // implausible id; a null result value would still materialise the variable (as null), so spread it
  // conditionally — omitting the key entirely degrades to the pre-#945 agent-cuts-its-own-branch
  // behaviour rather than emitting an unusable branch.create.
  const branchCreate = sliceBranchCreate(taskId);
  return {
    capsGateKey: capabilityTaskBarrierKey(planKey, taskId),
    hasNeeds: needs.length > 0,
    ...(branchCreate !== null ? { [AGENT_TASK_BRANCH_CREATE_VAR]: branchCreate } : {}),
  };
};

export default handler;
