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
import { generationGuard, recordAdjudication } from "../../app/adjudications.ts";
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
// A finite integer variable, or undefined when absent/blank/non-numeric. The `completedCompletionId`
// envelope field is typed `integer`, so it arrives as a number; tolerate a numeric string defensively.
function nonBlankInt(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const handler: AppJobHandler<In> = async (job, app) => {
  const { prKey } = job.variables;
  const answer = nonBlank(job.variables.answer);
  // The exact identity of the `wait-*` completion that resumed THIS token (Copilot review of #806),
  // stamped by `completeUserTaskAttributed` on the resumed token. Used to correlate the durable
  // adjudication to the completion the engine actually accepted; absent for an out-of-band resume.
  const completedUserTaskKey = nonBlank(job.variables.completedUserTaskKey);
  // The exact ledger id of the winning completion (Copilot review of #806), stamped by
  // `completeUserTaskAttributed`. When present it uniquely identifies the winner — even against a
  // same-answer losing racer on the same `user_task_key` — so record-answer selects that exact row
  // rather than correlating by answer. Absent for an out-of-band resume.
  const completedCompletionId = nonBlankInt(job.variables.completedCompletionId);
  // The durable id of the escalation THIS completion answers (Copilot review of #806). The originating
  // `pr.persist-escalation` returns its inserted `escalations.id` as a process variable (`EscalationOut`),
  // which the `wait-*` completion carries through here. Answering by this exact id — rather than the
  // newest open row — is what makes a REDELIVERED older answer safe: if the process has since opened a
  // NEWER escalation (a different question), a stale Q1 `record-answer` whose `escalationId` no longer
  // matches any open row is a no-op instead of misfiling Q1's answer under Q2's fingerprint and retiring
  // Q2 unanswered. Absent for a pre-#806 / out-of-band resume — we then fall back to the newest open row.
  const escalationId = nonBlankInt(job.variables.escalationId);
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
  //
  // The `process_key` is read AS LATE AS POSSIBLE — immediately before the writes below, not at handler
  // entry — so a concurrent re-submit that advances `process_key` and resets the adjudication memory is
  // observed here (Copilot review of #806). Paired with submitPr advancing `process_key` BEFORE it
  // clears the memory, this shrinks the reset window to a single check-then-write step: a straggler is
  // rejected once the new identity is installed, and any pre-advance insert is cleared by the
  // post-advance reset.
  const jobProcessKey = job.processInstanceKey != null ? String(job.processInstanceKey) : undefined;
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
  const currentProcessKey = nonBlank((await prs.find({ pr_key: prKey }))[0]?.process_key);
  if (currentProcessKey !== undefined && jobProcessKey !== undefined && jobProcessKey !== currentProcessKey) {
    return {};
  }
  // The escalation this completion actually answers. Prefer the exact `escalationId` the winning
  // completion carried; fall back to the newest open row only when it is absent (a pre-#806 / out-of-band
  // resume). If an `escalationId` was carried but no OPEN row bears it, this is a redelivered answer for
  // an escalation that has already been retired (or superseded by a newer question) — no-op rather than
  // misfile the answer under a different escalation's question (Copilot review of #806).
  const target = escalationId != null ? open.find((e) => e.id === escalationId) : open[0];
  if (target !== undefined) {
    const ts = new Date().toISOString();
    // Persist the DURABLE adjudication FIRST, BEFORE the escalation/PR rows transition off `open`
    // (issue #806, Copilot review — crash safety). `recordAdjudication` is INSERT-if-absent idempotent,
    // so if the worker crashes after this write but before the row transitions, a retry re-finds the
    // still-open row and re-records a no-op; whereas recording it LAST would mean a crash in the window
    // after the rows flip loses the adjudication entirely (the retry finds no open row and returns), so
    // the answered question could re-escalate after restart. Scoped to convergence answers only.
    if (isConvergence) {
      const adjudicator = await latestAdjudicator(app, job.processInstanceKey, answer, completedUserTaskKey, completedCompletionId);
      await recordAdjudication(app.data, {
        prKey,
        question: target.question,
        answer,
        adjudicatedBy: adjudicator?.id,
        adjudicatedKind: adjudicator?.kind,
        // Link the decision to the winning completion (issue #806 review) so a later revert of that
        // completion can tombstone it even when it is a FIRST-HAND agent answer with no
        // `source_adjudication_id`. INSERT-if-absent, so it pins to the original first-hand winner.
        sourceCompletionId: completedCompletionId,
        // Run generation this answer belongs to: every adjudication write is fenced on the PR's current
        // `process_key` still matching it, so a pre-reset straggler (one that passed the check above,
        // then paused across a re-submit that advanced `process_key` and cleared the memory) cannot
        // resurrect a stale adjudication after the reset (issue #806, Copilot review). Undefined when the
        // job carries no instance key — the fence then fails open, exactly like the staleness gate above.
        expectedProcessKey: jobProcessKey,
      });
    }
    // Fence the escalation/PR transitions on the run generation too (Copilot review of #806). The
    // ownership check above is READ-TIME — not atomic with these writes — so in the window between it
    // and here a concurrent re-submit could advance `process_key` and open a FRESH escalation; a naive
    // `escs.update`/`prs.update` would then answer the new run's snapshot and flip its PR to
    // `converging`. Each write is now a guarded conditional statement carrying the SAME `generationGuard`
    // predicate as the adjudication writes (one guard, no second implementation): it applies only while
    // the PR's current `process_key` still matches this job's generation, so a superseded worker touches
    // nothing. Fails open when `jobProcessKey` is undefined, exactly like the gate above.
    const db = app.data.open();
    const guard = generationGuard(prKey, jobProcessKey);
    await db.exec(
      `UPDATE "escalations" SET "answer" = ?, "status" = 'answered', "answered_at" = ? WHERE "id" = ? AND ${guard.sql}`,
      [answer ?? null, ts, target.id, ...guard.params],
    );
    // Mark any OTHER still-open row `stale` (a `pr.persist-escalation` retry can leave more than one
    // open for the same question). We retire every open row except the one we just answered so a phantom
    // `activePrs` never keeps deriving while the PR is `escalated`.
    for (const dup of open) {
      if (dup.id === target.id) continue;
      await db.exec(
        `UPDATE "escalations" SET "status" = 'stale' WHERE "id" = ? AND ${guard.sql}`,
        [dup.id, ...guard.params],
      );
    }
    // Move the PR off `status="escalated"` back to
    // `"converging"` now that the question is answered. Without this the row stays `escalated` (with
    // a now-null derived `openEscalation`) until the re-entered round's `persist-round` runs — a
    // `/status` inconsistency and a divergence from the merge path both loops are meant to share.
    await db.exec(
      `UPDATE "pull_requests" SET "status" = 'converging', "updated_at" = ? WHERE "pr_key" = ? AND ${guard.sql}`,
      [ts, prKey, ...guard.params],
    );
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
 *  review of #806). Correlate on the EXACT completion identity: the resumed token carries the
 *  `completedCompletionId` — the ledger id of the exact completion the engine accepted — so the winner
 *  is the row with that id, unambiguous even when both racers submitted the IDENTICAL answer (answer
 *  correlation alone cannot separate two same-answer rows on one `user_task_key`; the higher-id one may
 *  be the loser). A pre-#806-fix out-of-band resume that carried no `completedCompletionId` falls back
 *  to the exact `completedUserTaskKey` + winning-answer correlation, and attributes ONLY when that
 *  leaves exactly one candidate — an ambiguous same-answer set fails open rather than guess a winner.
 *  The KIND (`human`/`agent`, ADR
 *  0046) is preserved so a later auto-resume replays with the ORIGINAL attribution and never launders
 *  an agent decision into a human one. `undefined` (fails open to a fresh human task) when the identity
 *  is unavailable or no ledger row exactly matches — rather than attribute a wrong one. */
async function latestAdjudicator(app: Parameters<AppJobHandler<In>>[1], processInstanceKey: unknown, winningAnswer: string | undefined, completedUserTaskKey: string | undefined, completedCompletionId: number | undefined): Promise<{ id: string; kind: string } | undefined> {
  const key = processInstanceKey != null ? String(processInstanceKey) : "";
  if (key === "") return undefined;
  const rows = await taskCompletions(app.data).find({ process_instance_key: key });
  // Exact ledger-id match: the engine resumed this token with exactly ONE completion's variables, and
  // that completion stamped its own ledger id here, so the winner is unambiguously the row bearing it —
  // dropping a same-answer losing racer a pure answer correlation could not separate. Selecting nothing
  // returns undefined and fails open (never attribute a wrong row).
  if (completedCompletionId != null) {
    const exact = rows.find((r) => Number(r.id) === completedCompletionId);
    return exact ? { id: exact.actor_id, kind: exact.actor_kind } : undefined;
  }
  // Fallback for a resume that carried no completion id (a pre-fix / out-of-band token): require the
  // carried user-task identity, then — when the winning answer is known — keep only rows whose recorded
  // answer matches it, dropping the same-task losing racer whose recorded submission differs. Without a
  // completion id there is no evidence WHICH row won, so attribute ONLY when the candidate set is
  // exactly one (Copilot review of #806): more than one same-answer row on this `user_task_key` is the
  // very ambiguity the completion id was added to resolve — picking the newest could attribute to the
  // losing racer — so return undefined and fail open to a human rather than guess.
  if (completedUserTaskKey == null || completedUserTaskKey === "") return undefined;
  let candidates = rows.filter((r) => String(r.user_task_key) === completedUserTaskKey);
  if (winningAnswer != null && winningAnswer !== "") {
    candidates = candidates.filter((r) => completionAnswer(r.variables_json) === winningAnswer);
  }
  if (candidates.length !== 1) return undefined;
  const only = candidates[0];
  return { id: only.actor_id, kind: only.actor_kind };
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
