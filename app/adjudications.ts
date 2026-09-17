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
//     on a fingerprint match it auto-resumes through the same `completeEscalationAsHuman` door a
//     human uses, attributed to the prior adjudicator.
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

/** Persist a human adjudication of `question` for `prKey`, INSERT-if-absent so the ORIGINAL
 *  adjudicator/answer is preserved across later auto-resumes (which re-run record-answer with the
 *  same fingerprint). A blank answer is not a decision and is not recorded. Idempotent: a second
 *  answer to the identical question keeps the first settled row. */
export async function recordAdjudication(
  data: DataLayer,
  input: { prKey: string; question: string; answer: string | undefined; adjudicatedBy: string | undefined; adjudicatedKind: string | undefined },
): Promise<void> {
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (answer === "") return;
  const question = input.question.trim();
  if (question === "") return;
  const fp = questionFingerprint(question);
  const existing = await prAdjudications(data).find({ pr_key: input.prKey, question_fingerprint: fp });
  if (existing.length > 0) return;
  try {
    await prAdjudications(data).insert({
      pr_key: input.prKey,
      question_fingerprint: fp,
      answer,
      adjudicated_by: input.adjudicatedBy?.trim() || null,
      adjudicated_kind: input.adjudicatedKind?.trim() || null,
      adjudicated_at: new Date().toISOString(),
    });
  } catch (err) {
    // The `find`-then-`insert` above is racy against the `UNIQUE(pr_key, question_fingerprint)` fence:
    // a concurrent/redelivered answer job can insert the SAME fingerprint between our read and our
    // write, so the loser's insert hits the fence. Tolerate ONLY that collision as the idempotent
    // no-op the sequential path yields (the winner's ORIGINAL row is already durable) — never surface
    // it as a spurious `pr.answer-escalation` incident. Any other error still propagates. This is the
    // ONE canonical fence classifier (`app/dbFence.ts`), the same pattern as `deliveryConnector`'s
    // claim insert and `WorldStore`'s checkpoint insert (derivation over duplication).
    if (!isUniqueConstraintFence(err)) throw err;
  }
}
