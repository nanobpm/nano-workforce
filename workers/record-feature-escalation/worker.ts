// pr.record-feature-escalation — the shared `implement-cell`'s escalation recorder (ADR 0006 S4).
//
// The atomic `implement-cell` owns its `record-escalation` → `human-escalation` loop, so this one
// service task runs on the cell's `escalated` arm (`ic_gw` "clean terminal?" → `record-escalation`),
// immediately BEFORE the shared `human-escalation` cell parks on its user task, for EVERY caller that
// composes the cell: a standalone `feature` run (`subjectKey` = its `feature_key`) and a plan-fanout
// wave slice (`subjectKey` = the epic's `plan_key`, which has no standalone `feature_runs` row). It:
//
//   • synthesises an answerable `question` when the agent left none (a no-machine-readable result, or a
//     blank-question `escalated`) via the #360 no-result net, so the parked task is never a dead end,
//     and re-emits it as the `question` variable so the `feature-escalation` form (and the answer loop)
//     see it (mirrors record-trial-merge),
//   • appends that question to the append-only `feature_escalations` audit log keyed by `subjectKey` —
//     the canonical, poller-readable source `pollUserTasks` reads to enrich the parked task's question
//     on the Tasks inbox (issue #358), and
//   • flips the run to the non-terminal `escalated` status so status-based views/counts flag it — but
//     ONLY when a `feature_runs` row for `subjectKey` exists. A plan-embedded wave has NO such row (the
//     plan/epic IS the subject), so the flip is a guarded no-op there (it never fabricates a row).
//
// The completable `userTaskKey` is NOT recorded here — the task does not exist yet (it lives on the
// `human-escalation` grandchild instance the cell spawns next). Capturing the question HERE (not in the
// poller) is required because the WASM engine does not surface a user task's ioMapping-mapped local
// variables through the user-task query, so the process variable must be persisted while it is still in
// scope on this job.
import type { AppJobHandler } from "@nanobpm/urban";
import { classifyEscalation } from "../../app/escalationTaxonomy.ts";
import { featureRuns, recordFeatureEscalation } from "../../app/feature.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordEscalationIn` in implement-cell.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-feature-escalation"];
interface Out extends Record<string, unknown> {
  question: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

// The answerable prompt synthesised when the agent left no usable question — the implement-stage
// analogue of record-trial-merge's synthesised trial-merge question. It names the recoverable work (a
// PR may exist on the slice's branch) and the two answers the cell's `ic_gw_answer` gateway routes on.
const NO_RESULT_QUESTION =
  'The implementation agent finished without a machine-readable result (no status was reported), so we cannot tell whether the slice succeeded. It may still have opened a PR (check for a branch targeting the epic base). Choose "Answer" and give guidance to re-run the slice — or choose "Abandon" to skip it and continue.';

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const subjectKey = job.variables.subjectKey;
  // Fail fast rather than keying the `feature_escalations` audit log (and the guarded `feature_runs`
  // flip) with `undefined`. The cell's `escalated` arm always supplies `subjectKey` (the callActivity
  // input — a feature run's `feature_key` or a wave slice's `plan_key`), so a missing key can only mean
  // the `implement-cell` ioMapping/dataEnvelope regressed. Raising an incident surfaces that regression
  // with a clear trail instead of appending a corrupt `undefined`-keyed audit row and masking it —
  // symmetric with `record-feature-implementing`'s fail-fast guard (#642).
  if (!subjectKey) {
    throw new Error(
      "record-feature-escalation: subjectKey absent — the implement-cell's escalation-arm ioMapping/dataEnvelope has regressed (would key feature_escalations/feature_runs with undefined)",
    );
  }
  const rawQuestion = str(job.variables.question);
  // The agent's own question is authoritative when it declared a real escalation with one; otherwise
  // (a no-machine-readable result, or an escalation with a blank question) synthesise an answerable one
  // so the parked task is never a dead end. Route through the single canonical taxonomy so this net can
  // never drift from the tier logic every other raise site uses. A "task"-kind escalation is
  // `decision-required` only when the agent left an answerable question, so this already covers the
  // blank-question case; the extra `&& rawQuestion` is the type narrowing that lets us hand the string
  // through without an assertion.
  const agentEscalated = classifyEscalation({ kind: "task", status: job.variables.status, question: rawQuestion }) ===
    "decision-required";
  const question = agentEscalated && rawQuestion ? rawQuestion : NO_RESULT_QUESTION;

  // Append to the canonical `feature_escalations` audit log (the surviving table `pollUserTasks` reads),
  // keyed by `subjectKey` — the feature run's `feature_key`, or the epic's `plan_key` for a wave slice.
  await recordFeatureEscalation(app.data, { featureKey: subjectKey, question, jobKey: job.jobKey });

  // Guarded status flip: a standalone `feature` run has a `feature_runs` row to flip to the non-terminal
  // `escalated`; a plan-embedded wave (`subjectKey` = `plan_key`) has none, so the flip is a no-op there
  // rather than fabricating a bogus row (the plan/epic is the subject, tracked in `plans`).
  const runs = featureRuns(app.data);
  if (await runs.get(subjectKey)) {
    await runs.update(subjectKey, { status: "escalated", updated_at: new Date().toISOString() });
  }

  app.log.info("record-escalation", { subjectKey, synthesised: question === NO_RESULT_QUESTION });

  // Re-emit the resolved question so the `feature-escalation` form (and the answer loop) see it.
  return { question };
};

export default handler;
export { NO_RESULT_QUESTION };
