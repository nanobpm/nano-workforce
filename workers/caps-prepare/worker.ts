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
import type { AppJobHandler } from "@nanobpm/urban";
import { capabilityTaskBarrierKey, parseCapabilityNeeds } from "../../app/capabilityNeed.ts";
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
  return {
    capsGateKey: capabilityTaskBarrierKey(planKey, taskId),
    hasNeeds: needs.length > 0,
  };
};

export default handler;
