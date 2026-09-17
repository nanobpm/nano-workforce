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
// are written; the rest of the row is untouched. `process_key` is READ (never written here) to reject a
// delayed/redelivered job from a superseded process instance (Copilot review of #806).
interface PullRequest extends Record<string, unknown> {
  pr_key: string;
  status: string;
  process_key: string | null;
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
  // The exact identity of the `wait-*` completion that resumed THIS token (Copilot review of #806),
  // stamped by `completeUserTaskAttributed` on the resumed token. Used to correlate the durable
  // adjudication to the completion the engine actually accepted; absent for an out-of-band resume.
  const completedUserTaskKey = nonBlank(job.variables.completedUserTaskKey);
  const prs = app.data.table<PullRequest>("pull_requests", "pr_key");
  // Reject a delayed/redelivered job from a SUPERSEDED process instance (Copilot review of #806).
  // `pull_requests.process_key` always tracks the CURRENT loop instance for this PR — the convergence
  // instance at submit, reassigned to the merge instance at merge-start (app/service.ts). A job whose
  // `processInstanceKey` no longer matches is from an old run that a re-submit (or the merge hand-off)
  // replaced; accepting it would let a stale process reinsert its adjudication after the fresh run's
  // reset, or even answer the new run's open escalation, so a re-submit would not be a reliable
  // fresh-decision boundary. No-op such jobs BEFORE any adjudication/escalation/PR write. When the
  // current process is unknown (no row / null `process_key`) we cannot classify the job as stale, so
  // we proceed rather than silently drop a legitimate operator answer.
  const currentProcessKey = nonBlank((await prs.find({ pr_key: prKey }))[0]?.process_key);
  const jobProcessKey = job.processInstanceKey != null ? String(job.processInstanceKey) : undefined;
  if (currentProcessKey !== undefined && jobProcessKey !== undefined && jobProcessKey !== currentProcessKey) {
    return {};
  }
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
      const adjudicator = await latestAdjudicator(app, job.processInstanceKey, answer, completedUserTaskKey);
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
    await prs.update(prKey, { status: "converging", updated_at: ts });
  }
  return {};
};

/** Who just completed this `wait-answer`: the `{ id, kind }` of the `task_completions` row that
 *  actually WON the user-task race, so the durable adjudication is attributed to the completion the
 *  engine accepted — never a losing racer's transient row NOR an older round's completion. Both
 *  canonical completers (`completeUserTaskAttributed`) insert their ledger row BEFORE calling
 *  `completeUserTask` and the loser only removes its row AFTER the engine rejects it, so a bare
 *  "newest row for this process instance" can transiently select a higher-id LOSER; and because a
 *  convergence-loop instance is REUSED across rounds, an older round's completion (or a delayed
 *  same-answer redelivery) with a higher id can also linger for the SAME process instance (Copilot
 *  review of #806). Correlate on the EXACT completion identity first: the resumed token carries the
 *  `completedUserTaskKey` this completion stamped, so the winner is a ledger row for that exact
 *  `user_task_key`. Both racers on that task share the key, so also require the WINNING answer — the
 *  engine resumed this token with exactly one completion's variables and `answer` here is that winning
 *  submission — to drop the losing racer, whose recorded answer differs. The KIND (`human`/`agent`,
 *  ADR 0046) is preserved so a later auto-resume replays with the ORIGINAL attribution and never
 *  launders an agent decision into a human one. `undefined` (fails open to a fresh human task) when the
 *  identity is unavailable (an out-of-band resume that carried no `completedUserTaskKey`) or no ledger
 *  row exactly matches — rather than attribute a wrong one. */
async function latestAdjudicator(app: Parameters<AppJobHandler<In>>[1], processInstanceKey: unknown, winningAnswer: string | undefined, completedUserTaskKey: string | undefined): Promise<{ id: string; kind: string } | undefined> {
  const key = processInstanceKey != null ? String(processInstanceKey) : "";
  if (key === "") return undefined;
  // Require the carried user-task identity — without it we cannot EXACTLY identify the completion for
  // THIS wait-answer among a reused instance's accumulated rows, so fail open rather than guess.
  if (completedUserTaskKey == null || completedUserTaskKey === "") return undefined;
  const rows = await taskCompletions(app.data).find({ process_instance_key: key });
  // Exact ledger match: keep only rows for the completion this token actually resumed with (drops other
  // rounds' completions and any unrelated task in the same instance). Then, when the winning answer is
  // known, keep only rows whose recorded answer matches it — dropping the same-task losing racer, whose
  // recorded submission differs. Selecting nothing returns undefined and fails open.
  let candidates = rows.filter((r) => String(r.user_task_key) === completedUserTaskKey);
  if (winningAnswer != null && winningAnswer !== "") {
    candidates = candidates.filter((r) => completionAnswer(r.variables_json) === winningAnswer);
  }
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
