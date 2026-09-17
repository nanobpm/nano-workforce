// Durable wait-answer adjudication memory (issue #806) — the app's record that "(this PR, this
// question) was already adjudicated to X by a human at T", so a stateless convergence round that
// re-derives the identical escalation condition auto-resumes with the recorded answer instead of
// re-parking a human from scratch (PR #800 / proc 46310: the same design question escalated at
// round 2 and again at round 13).
//
// A human adjudication is NOT GitHub-derivable — the convergence gate is intentionally stateless
// w.r.t. GitHub, but a human's decision is a fact only the app can remember — so it is persisted
// durably in `pr_adjudications` (migration 109), keyed by the PR and the canonical QUESTION
// FINGERPRINT (the SAME `normalizeAdvisoryText` + `fingerprint` normalisation advisory acks key on,
// exported from app/github.ts — no second fingerprint implementation).
//
// Two touch points on the CANONICAL escalation/answer path own this store (no parallel adjudication
// store, no second suppression heuristic — derivation over duplication):
//   • `pr.answer-escalation` (record-answer) calls `recordAdjudication` on answering a `wait-answer`,
//     persisting the settled answer + adjudicator.
//   • the poller (`pollUserTasks`) calls `matchAdjudication` before surfacing a NEW `wait-answer`;
//     on a fingerprint match it auto-resumes through `completeEscalationAutoApplied` — which shares the
//     canonical `completeUserTaskAttributed` door a human's `completeEscalationAsHuman` uses, but records
//     the completion `auto_applied`/`reversible` (never laundering the replay into a first-class human
//     decision) — attributed to the prior adjudicator.
import type { DataLayer } from "@nanobpm/urban";
import { isUniqueConstraintFence } from "./dbFence.ts";
import { questionFingerprint } from "./github.ts";

/** One durable human adjudication of a convergence question, keyed by `(pr_key, question_fingerprint)`
 *  (a `UNIQUE` constraint; `id` is the surrogate single-column PK for the `Table<T>` gateway). */
export interface PrAdjudicationRow {
  id: number;
  pr_key: string;
  /** The canonical `questionFingerprint` (app/github.ts) of the settled escalation question. */
  question_fingerprint: string;
  /** The human's settled answer, replayed verbatim on auto-resume. */
  answer: string | null;
  /** Who settled it (the prior adjudicator), attributed on auto-resume. */
  adjudicated_by: string | null;
  /** Whether the prior adjudicator was a `human` or an `agent` (ADR 0046), preserved so an auto-resume
   *  replays with the ORIGINAL attribution kind — never laundering an agent decision into a human one. */
  adjudicated_kind: string | null;
  adjudicated_at: string;
}

export const prAdjudications = (data: DataLayer) => data.table<PrAdjudicationRow>("pr_adjudications", "id");

/** Pure: the durable adjudication whose fingerprint matches `question` (via the canonical
 *  `questionFingerprint`), or `undefined`. Only a row carrying a non-blank `answer` is returned — a
 *  blank/absent answer is not a replayable decision (the `pr-escalation.form` requires a non-blank
 *  answer, so auto-resuming with a blank one would fail validation), so it never suppresses a fresh
 *  escalation. */
export function matchAdjudication(
  rows: readonly PrAdjudicationRow[],
  question: string,
): PrAdjudicationRow | undefined {
  const fp = questionFingerprint(question);
  return rows.find((r) => r.question_fingerprint === fp && typeof r.answer === "string" && r.answer.trim() !== "");
}

/** Input to {@link recordAdjudication}. `expectedProcessKey` is the run generation this answer job
 *  belongs to (the `pr.answer-escalation` job's own process-instance key); every write is fenced on it
 *  (see {@link generationGuard}) so a pre-reset straggler cannot resurrect a stale adjudication for a
 *  fresh run. `undefined` (a job carrying no instance key) fails open, matching the worker's staleness
 *  gate — an unclassifiable job proceeds rather than dropping a legitimate operator answer. */
interface RecordAdjudicationInput {
  prKey: string;
  question: string;
  answer: string | undefined;
  adjudicatedBy: string | undefined;
  adjudicatedKind: string | undefined;
  expectedProcessKey?: string | undefined;
}

/** A SQL predicate (+ bind params) that is TRUE only while this write still belongs to the CURRENT run
 *  generation: no `pull_requests` row for `prKey` carries a `process_key` that is BOTH set AND different
 *  from the writer's `expectedProcessKey`. Woven into the adjudication INSERT/UPDATE so the ownership
 *  check and the write are ONE atomic statement — the fix `submitPr` advances `process_key` BEFORE it
 *  clears the memory relies on (Copilot review of #806): an `answer-escalation` straggler that read the
 *  old key, then paused across a re-submit that advanced the key and deleted the rows, finds this guard
 *  false at write time and no-ops, so it cannot insert its stale adjudication after the reset for the
 *  fresh run to auto-apply. When `expectedProcessKey` is absent the guard is a constant TRUE (fail open,
 *  mirroring the worker gate — an unclassifiable job must not be silently dropped). */
function generationGuard(prKey: string, expectedProcessKey: string | undefined): { sql: string; params: unknown[] } {
  if (expectedProcessKey == null || expectedProcessKey === "") return { sql: "1 = 1", params: [] };
  return {
    sql: `NOT EXISTS (SELECT 1 FROM "pull_requests" WHERE "pr_key" = ? AND "process_key" IS NOT NULL AND "process_key" <> ?)`,
    params: [prKey, expectedProcessKey],
  };
}

/** Persist a human adjudication of `question` for `prKey`, INSERT-if-absent so the ORIGINAL
 *  adjudicator/answer is preserved across later auto-resumes (which re-run record-answer with the
 *  same fingerprint). A blank answer is not a decision and is not recorded. Idempotent: a second
 *  answer to the identical question keeps the first settled row — UNLESS that first row was recorded
 *  with UNKNOWN provenance (a blank `adjudicated_by`, from an answer that could not be correlated to
 *  an adjudicator). `pollUserTasks` refuses to auto-resume an unknown-provenance decision (it never
 *  launders an unattributed replay into a human authority), so such a row keeps re-parking a human
 *  every round; when a KNOWN adjudicator later answers the same question, promote the row to a
 *  replayable decision — its answer AND attribution — so future rounds auto-resume instead of
 *  re-parking forever (issue #806 review). A row that ALREADY carries known provenance stays immutable.
 *
 *  Every write is fenced on the run generation ({@link generationGuard}) so a pre-reset straggler cannot
 *  write after `submitPr` advances `process_key`, AND the blank→known promotion is a conditional
 *  compare-and-set (see {@link healBlankProvenance}) so two concurrent known healers cannot clobber each
 *  other's answer/adjudicator — only the first promotion of a blank row wins, keeping the documented
 *  first-known decision immutable (Copilot review of #806). */
export async function recordAdjudication(data: DataLayer, input: RecordAdjudicationInput): Promise<void> {
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (answer === "") return;
  const question = input.question.trim();
  if (question === "") return;
  const fp = questionFingerprint(question);
  const db = data.open();
  const guard = generationGuard(input.prKey, input.expectedProcessKey);
  try {
    // Conditional INSERT-if-absent: the `... SELECT ? … WHERE <generationGuard>` is atomic, so the
    // ownership check and the insert are ONE statement — a stale straggler's guard is false and the
    // insert affects zero rows (no separate read-then-write TOCTOU window). A concurrent/redelivered
    // answer that already inserted the SAME fingerprint trips the `UNIQUE(pr_key, question_fingerprint)`
    // fence, which we tolerate below exactly as the sequential no-op the winner's durable row yields.
    const res = await db.exec(
      `INSERT INTO "pr_adjudications" ("pr_key","question_fingerprint","answer","adjudicated_by","adjudicated_kind","adjudicated_at")
       SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      [input.prKey, fp, answer, input.adjudicatedBy?.trim() || null, input.adjudicatedKind?.trim() || null, new Date().toISOString(), ...guard.params],
    );
    if (res.changed > 0) return; // fresh insert won under the current generation
  } catch (err) {
    // Tolerate ONLY the UNIQUE fence as the idempotent no-op the sequential path yields (the winner's
    // ORIGINAL row is already durable) — never surface it as a spurious `pr.answer-escalation` incident.
    // Any other error still propagates. This is the ONE canonical fence classifier (`app/dbFence.ts`),
    // the same pattern as `deliveryConnector`'s claim insert and `WorldStore`'s checkpoint insert
    // (derivation over duplication).
    if (!isUniqueConstraintFence(err)) throw err;
  }
  // We reach here when the insert affected no row: either a row already exists (UNIQUE fence, or another
  // writer's row already present) OR the generation guard was false (a stale straggler — leave it a
  // no-op). Re-read the ACTUAL current row and apply the blank→known promotion the winner would have; a
  // stale straggler's heal is likewise fenced to a no-op, and an already-attributed row is immutable.
  const winner = await prAdjudications(data).find({ pr_key: input.prKey, question_fingerprint: fp });
  if (winner.length > 0) await healBlankProvenance(data, winner[0], answer, input);
}

/** Promote an UNKNOWN-provenance adjudication row to a replayable decision (issue #806 review). The
 *  prior answer could not be attributed, so auto-resume fails open and the question re-parks a human
 *  every round; a now-known adjudicator's answer heals the row — its answer AND attribution together, so
 *  the replayed decision is the human's, not the earlier uncorrelated one. Only heal blank→known: a row
 *  that ALREADY carries known provenance is immutable (INSERT-if-absent preserves the ORIGINAL). A no-op
 *  when the prior row is already attributed or the incoming answer is still unattributed.
 *
 *  The promotion is a CONDITIONAL compare-and-set — the `UPDATE … WHERE "adjudicated_by" IS NULL OR
 *  TRIM("adjudicated_by") = ''` re-checks the blank precondition INSIDE the write, so of two concurrent
 *  known healers that both read the same blank row only the FIRST promotes it; the second's guard is
 *  already false and its update affects zero rows, leaving the first healer's answer/adjudicator intact
 *  (Copilot review of #806 — a read-then-unconditional-update would let the later writer clobber the
 *  earlier known decision). The write is ALSO fenced on the run generation so a pre-reset straggler
 *  cannot heal after a re-submit reset. */
async function healBlankProvenance(
  data: DataLayer,
  prior: PrAdjudicationRow,
  answer: string,
  input: { prKey: string; adjudicatedBy: string | undefined; adjudicatedKind: string | undefined; expectedProcessKey?: string | undefined },
): Promise<void> {
  const priorBy = prior.adjudicated_by?.trim();
  const nowBy = input.adjudicatedBy?.trim();
  if (priorBy || !nowBy) return;
  const db = data.open();
  const guard = generationGuard(input.prKey, input.expectedProcessKey);
  await db.exec(
    `UPDATE "pr_adjudications" SET "answer" = ?, "adjudicated_by" = ?, "adjudicated_kind" = ?, "adjudicated_at" = ?
     WHERE "id" = ? AND ("adjudicated_by" IS NULL OR TRIM("adjudicated_by") = '') AND ${guard.sql}`,
    [answer, nowBy, input.adjudicatedKind?.trim() || null, new Date().toISOString(), prior.id, ...guard.params],
  );
}
