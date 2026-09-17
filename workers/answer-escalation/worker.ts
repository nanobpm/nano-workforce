// pr.answer-escalation — retires the escalation the operator just answered, for BOTH the review loop
// (`wait-answer`, convergence-loop.bpmn) and the merge loop (`wait-merge-answer`, merge-loop.bpmn).
// Both loops now park on a native `wait-*` userTask (backed by `pr-escalation.form`) and run this same
// reconcile step on completion (#256) — there is one answer path, not two.
// Completing that task resumes the token, but the engine folds the completed instance's variables
// away — so without this step the durable `escalations` audit row raised by `pr.persist-escalation`
// would stay `status="open"` forever, its `answer`/`answered_at` never recorded. That both loses the
// Q&A audit trail and (because `activePrs` derives `openEscalation` from the open-row status — the
// single source of truth, ADR "derivation over duplication") would keep surfacing a phantom open
// escalation on `/status` after it was answered.
//
// It answers the newest still-open `escalations` row, marks any duplicate open rows `stale` (a
// retry of `pr.persist-escalation` can leave more than one open), AND moves the `pull_requests` row
// off `status="escalated"` back to `"converging"`, so an answered escalation is never left dangling
// and `/status` never shows an escalated PR with a null question or a phantom open row. The token
// resume itself is owned by the engine (userTask completion), so this worker only reconciles the
// durable rows; it returns no variables, leaving the submitted `answer` untouched so it flows on to
// the next review round.
import type { AppJobHandler } from "@nanobpm/urban";
import { recordAdjudication } from "../../app/adjudications.ts";
import { taskCompletions } from "../../app/agentCompletion.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

interface Escalation extends Record<string, unknown> {
  id: number;
  pr_key: string;
  status: string;
  question: string;
  answer: string | null;
  answered_at: string | null;
}

// The PR-row fields this worker reconciles when an escalation is answered. Only `status`/`updated_at`
// are written; the rest of the row is untouched.
interface PullRequest extends Record<string, unknown> {
  pr_key: string;
  status: string;
  updated_at: string;
}

// Input typed off the model data envelope (`PrAnswerEscalationIn` in convergence-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.answer-escalation"];
// A string variable, or undefined when it is absent/blank. The form marks `answer` required, so a
// blank here would be an out-of-band completion; record it as NULL rather than an empty string.
function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

const handler: AppJobHandler<In> = async (job, app) => {
  const { prKey } = job.variables;
  const answer = nonBlank(job.variables.answer);
  const escs = app.data.table<Escalation>("escalations", "id");
  // Retire EVERY still-open escalation for this PR. `pr.persist-escalation` always INSERTs a new
  // open row, so a retry/duplicate activation can leave more than one open — answering only the
  // newest would leave an older duplicate `open`, a phantom `activePrs` keeps deriving while the PR
  // is still `escalated`. Answer the newest (it carries the operator's reply) and mark any remaining
  // open rows `stale`, mirroring `submitPr`'s resubmit cleanup.
  const open = (await escs.find({ pr_key: prKey, status: "open" })).sort((a, b) => b.id - a.id);
  if (open.length > 0) {
    const ts = new Date().toISOString();
    await escs.update(open[0].id, {
      answer: answer ?? null,
      status: "answered",
      answered_at: ts,
    });
    for (const dup of open.slice(1)) {
      await escs.update(dup.id, { status: "stale" });
    }
    // Move the PR off `status="escalated"` back to
    // `"converging"` now that the question is answered. Without this the row stays `escalated` (with
    // a now-null derived `openEscalation`) until the re-entered round's `persist-round` runs — a
    // `/status` inconsistency and a divergence from the merge path both loops are meant to share.
    const prs = app.data.table<PullRequest>("pull_requests", "pr_key");
    await prs.update(prKey, { status: "converging", updated_at: ts });

    // Persist a DURABLE adjudication of the settled question (issue #806) so a later stateless round
    // that re-derives the IDENTICAL escalation condition auto-resumes with this answer instead of
    // re-parking a human (PR #800 / proc 46310: the same design question escalated at round 2 and
    // again at round 13). Keyed by `(prKey, questionFingerprint(question))` — the canonical
    // normaliser/fingerprint advisory acks use — so only a semantically-identical, already-answered
    // question is later suppressed. INSERT-if-absent, so the ORIGINAL adjudicator/answer survives the
    // record-answer re-run a later auto-resume drives. Attribute it to whoever just completed the
    // `wait-answer`: the newest `task_completions` row this resume's completion stamped for this
    // process instance (the canonical completion ledger, app/agentCompletion.ts) — a human operator
    // or an agent assignee (ADR 0046) — falling back to `null` when the ledger row is absent.
    await recordAdjudication(app.data, {
      prKey,
      question: open[0].question,
      answer,
      adjudicatedBy: await latestAdjudicator(app, job.processInstanceKey),
    });
  }
  return {};
};

/** Who just completed this `wait-answer`: the actor of the newest `task_completions` row the resume's
 *  completion stamped for this process instance (`completeUserTaskAttributed` records the actor +
 *  process-instance key on completion). `undefined` when no ledger row is correlated (e.g. an
 *  out-of-band resume), so the adjudication records a null adjudicator rather than a wrong one. */
async function latestAdjudicator(app: Parameters<AppJobHandler<In>>[1], processInstanceKey: unknown): Promise<string | undefined> {
  const key = processInstanceKey != null ? String(processInstanceKey) : "";
  if (key === "") return undefined;
  const rows = await taskCompletions(app.data).find({ process_instance_key: key });
  let newest: { id: number; actor_id: string } | undefined;
  for (const r of rows) {
    if (!newest || r.id > newest.id) newest = r;
  }
  return newest?.actor_id;
}

export default handler;
