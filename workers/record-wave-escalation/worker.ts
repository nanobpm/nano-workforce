// pr.record-wave-escalation — a plan-fanout wave slice did NOT return a clean terminal result, so its
// `implement` subprocess routes here (the `w_gw` "clean terminal?" gateway's `not clean` arm) BEFORE
// the `feature-escalation` user task is created. It is the plan-fanout analogue of feature.bpmn's
// `record-feature-escalation`, extended with the no-result net of issue #360.
//
// The implement stage was the ONLY agent stage with no net for "I couldn't read the agent's result":
//   • review rounds re-enter the durable review wait (app/roundResultDefault.ts),
//   • trial merge raises an answerable human escalation (workers/record-trial-merge/worker.ts),
//   • implement/wave coerced a missing status straight to terminal `blocked` — silently failing the
//     epic and orphaning any PR the agent opened (issue #360).
// This worker closes that gap by routing every non-clean-terminal slice onto the SAME
// `feature-escalation` user task a genuine `status:"escalated"` already uses, so a human can enrol the
// PR or abandon the slice instead of the epic dying with a blank reason.
//
// It does two things while the process variables are still in scope on the job:
//   • synthesises an answerable `question` when the agent didn't provide one (a no-machine-readable
//     result carries no question), mirroring record-trial-merge, and re-emits it as the `question`
//     variable so the `feature-escalation` form and the poller both see it, and
//   • appends that question to the append-only `feature_escalations` audit log keyed by `planKey` — the
//     canonical, poller-readable source `pollUserTasks` reads to enrich the parked task's question on
//     the Tasks inbox (issue #358). The plan-root embeds the slice as a multi-instance subprocess, so
//     there is no standalone `feature_runs` row; the epic (plan) IS the subject, hence the `planKey`
//     key. Capturing it HERE (not in the poller) is required because the WASM engine does not surface a
//     user task's ioMapping-mapped local variables through the user-task query.
import type { AppJobHandler } from "@nanobpm/urban";
import { classifyEscalation } from "../../app/escalationTaxonomy.ts";
import { recordFeatureEscalation } from "../../app/feature.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordWaveEscalationIn` in plan-fanout.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-wave-escalation"];
interface Out extends Record<string, unknown> {
  question: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

// The answerable prompt synthesised when the agent left no usable question — the implement-stage
// analogue of record-trial-merge's synthesised trial-merge question. It names the recoverable work (a
// PR may exist on the slice's branch) and the two answers the `w_gw_answer` gateway routes on.
const NO_RESULT_QUESTION =
  'The implementation agent finished without a machine-readable result (no status was reported), so we cannot tell whether the slice succeeded. It may still have opened a PR (check for a branch targeting the epic base). Choose "Answer" and give guidance to re-run the slice — or choose "Abandon" to skip it and continue the epic.';

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const rawQuestion = str(job.variables.question);
  // The agent's own question is authoritative when it declared a real escalation with one; otherwise
  // (a no-machine-readable result, or an escalation with a blank question) synthesise an answerable
  // one so the parked task is never a dead end. Route through the single canonical taxonomy so this
  // net can never drift from the tier logic every other raise site uses.
  // A "task"-kind escalation is `decision-required` only when the agent left an answerable question, so
  // this already covers the blank-question case; the extra `&& rawQuestion` is the type narrowing that lets
  // us hand the string through without an assertion.
  const agentEscalated = classifyEscalation({ kind: "task", status: job.variables.status, question: rawQuestion }) ===
    "decision-required";
  const question = agentEscalated && rawQuestion ? rawQuestion : NO_RESULT_QUESTION;

  // Append to the canonical `feature_escalations` audit log (the surviving table `pollUserTasks` reads),
  // keyed by `planKey` because the plan-root instance IS the subject of the embedded slice's escalation.
  await recordFeatureEscalation(app.data, { featureKey: planKey, question, jobKey: job.jobKey });
  app.log.info("record-wave-escalation", { planKey, synthesised: question === NO_RESULT_QUESTION });

  // Re-emit the resolved question so the `feature-escalation` form (and the answer loop) see it.
  return { question };
};

export default handler;
export { NO_RESULT_QUESTION };
