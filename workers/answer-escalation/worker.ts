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
  // This one worker services BOTH loops' answer steps (`record-answer` in the convergence loop AND
  // `record-merge-answer` in the merge loop, #256). Only a CONVERGENCE answer may feed the durable
  // adjudication memory the convergence poller replays — a merge-loop decision recorded here would let
  // a later convergence `wait-answer` with the same text replay a merge-context answer that was never a
  // convergence adjudication (Copilot review of #806). The originating step stamps `answerContext` via a
  // literal ioMapping so this reconcile can tell them apart.
  const isConvergence = nonBlank(job.variables.answerContext) === "convergence";
  const escs = app.data.table<Escalation>("escalations", "id");
  // Retire EVERY still-open escalation for this PR. `pr.persist-escalation` always INSERTs a new
  // open row, so a retry/duplicate activation can leave more than one open — answering only the
  // newest would leave an older duplicate `open`, a phantom `activePrs` keeps deriving while the PR
  // is still `escalated`. Answer the newest (it carries the operator's reply) and mark any remaining
  // open rows `stale`, mirroring `submitPr`'s resubmit cleanup.
  const open = (await escs.find({ pr_key: prKey, status: "open" })).sort((a, b) => b.id - a.id);
  if (open.length > 0) {
    const ts = new Date().toISOString();
    // Persist the DURABLE adjudication FIRST, BEFORE the escalation/PR rows transition off `open`
    // (issue #806, Copilot review — crash safety). `recordAdjudication` is INSERT-if-absent idempotent,
    // so if the worker crashes after this write but before the row transitions, a retry re-finds the
    // still-open row and re-records a no-op; whereas recording it LAST would mean a crash in the window
    // after the rows flip loses the adjudication entirely (the retry finds no open row and returns), so
    // the answered question could re-escalate after restart. Scoped to convergence answers only.
    if (isConvergence) {
      const adjudicator = await latestAdjudicator(app, job.processInstanceKey, answer);
      await recordAdjudication(app.data, {
        prKey,
        question: open[0].question,
        answer,
        adjudicatedBy: adjudicator?.id,
        adjudicatedKind: adjudicator?.kind,
      });
    }
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
  }
  return {};
};

/** Who just completed this `wait-answer`: the `{ id, kind }` of the `task_completions` row that
 *  actually WON the user-task race, so the durable adjudication is attributed to the completion the
 *  engine accepted — never a losing racer's transient row. Both canonical completers
 *  (`completeUserTaskAttributed`) insert their ledger row BEFORE calling `completeUserTask` and the
 *  loser only removes its row AFTER the engine rejects it, so a bare "newest row for this process
 *  instance" can transiently select a higher-id LOSER and persist/replay the wrong `actor_kind`
 *  (Copilot review of #806). Correlate instead on the WINNING answer: the engine resumed this token
 *  with exactly one completion's variables, and `answer` here is that winning submission — so the
 *  winner is the newest ledger row whose recorded `variables_json.answer` matches it. The KIND
 *  (`human`/`agent`, ADR 0046) is preserved so a later auto-resume replays with the ORIGINAL
 *  attribution and never launders an agent decision into a human one. `undefined` when no ledger row
 *  is correlated (e.g. an out-of-band resume, or a winner that did not route through the ledger), so
 *  the adjudication records a null adjudicator — which fails open to a fresh human task — rather than
 *  a wrong one. */
async function latestAdjudicator(app: Parameters<AppJobHandler<In>>[1], processInstanceKey: unknown, winningAnswer: string | undefined): Promise<{ id: string; kind: string } | undefined> {
  const key = processInstanceKey != null ? String(processInstanceKey) : "";
  if (key === "") return undefined;
  const rows = await taskCompletions(app.data).find({ process_instance_key: key });
  // Correlate on the winning answer whenever we know it: the loser recorded a DIFFERENT submission, so
  // filtering to rows whose recorded answer matches the accepted one drops the transient loser row. If
  // the winning answer is unknown (blank/out-of-band — recordAdjudication won't persist it anyway) fall
  // back to the whole set. Selecting nothing (a known winner with no matching ledger row) returns
  // undefined and fails open, rather than attributing to an unrelated row.
  const candidates = winningAnswer != null && winningAnswer !== "" ? rows.filter((r) => completionAnswer(r.variables_json) === winningAnswer) : rows;
  let newest: { id: number; actor_id: string; actor_kind: string } | undefined;
  for (const r of candidates) {
    if (!newest || r.id > newest.id) newest = r;
  }
  return newest ? { id: newest.actor_id, kind: newest.actor_kind } : undefined;
}

/** The trimmed `answer` field recorded in a completion's `variables_json`, or undefined when the JSON
 *  is unparseable or carries no string answer. Used to correlate a ledger row with the submission the
 *  engine actually accepted (see `latestAdjudicator`). */
function completionAnswer(variablesJson: unknown): string | undefined {
  if (typeof variablesJson !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(variablesJson);
    if (parsed === null || typeof parsed !== "object" || !("answer" in parsed)) return undefined;
    const answer = parsed.answer;
    return typeof answer === "string" && answer.trim() !== "" ? answer.trim() : undefined;
  } catch {
    return undefined;
  }
}

export default handler;
