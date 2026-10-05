// Implement-stage escalation reason — the single canonical builder for the human-facing escalation
// text when an implement-cell slice reaches the escalation arm with no adoptable PR (issue #865).
//
// The defect #865 fixed: the shared `implement-cell` synthesised ONE generic reason — "finished
// without a machine-readable result (no status was reported)" — for EVERY non-clean-terminal outcome.
// But an agent that reported `status: "completed"` (an off-vocabulary status) with a summary, yet
// opened no PR, DID report a status: the generic text was a false diagnosis the human had to untangle.
// This module classifies the escalation precisely and always carries the agent's own `summary` and the
// run's transcript link (cf. #863) so the human sees an accurate, self-contained reason.
//
// It is a pure, exhaustively-testable builder shared by `record-feature-escalation` (the escalation
// recorder) so the reason can never drift between raise sites — the "one canonical implementation"
// rule applied to the escalation text.

/** The agent result vocabulary the implement-cell recognises (resources/prompts/feature.md). Any other
 *  reported status — e.g. `completed`/`done`/`success` — is OFF-vocabulary: the agent claimed an outcome
 *  the cell cannot route on. `opened`/`blocked`/`skipped` are clean terminals the `ic_gw` "clean
 *  terminal?" gate converges before the escalation arm; `escalated` is the agent's own answerable
 *  escalation. This set is the shared source of truth for "did the agent report a recognised status?" —
 *  `implementReconcile` reads it to decide whether to look for a delivered PR, and this module reads it
 *  to decide whether the agent CLAIMED COMPLETION with an off-vocabulary word. */
export const RECOGNIZED_IMPLEMENT_STATUSES: ReadonlySet<string> = new Set([
  "opened",
  "blocked",
  "skipped",
  "escalated",
]);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** True iff `status` is a non-blank value that is NOT in the recognised vocabulary — the
 *  "claimed-completion-without-delivery" signal (e.g. `status: "completed"`). A blank/absent status is
 *  NOT a claimed completion (it is a no-result), and a recognised status is not off-vocabulary. */
export function isClaimedCompletion(status: unknown): boolean {
  const s = str(status);
  return s !== undefined && !RECOGNIZED_IMPLEMENT_STATUSES.has(s);
}

/** The outcome the escalation reason distinguishes. `no-result` = blank/absent status (or a recognised
 *  non-terminal with no answerable question); `completed-without-delivery` = an off-vocabulary status was
 *  reported (the agent claimed completion) but no PR/branch was delivered. */
export type ImplementEscalationKind = "no-result" | "completed-without-delivery";

export function classifyImplementEscalation(status: unknown): ImplementEscalationKind {
  return isClaimedCompletion(status) ? "completed-without-delivery" : "no-result";
}

/** What the escalation builder needs from the implement-step outcome. `summary` is the agent's own
 *  one-line result (always surfaced when present); `transcriptUrl` is the run's transcript link
 *  (cf. #863). */
export interface ImplementEscalationReasonInput {
  status?: unknown;
  summary?: unknown;
  transcriptUrl?: unknown;
}

// The lead sentence for a genuine no-result (blank status) — the agent returned nothing we can read.
const NO_RESULT_LEAD =
  "The implementation agent finished without a machine-readable result (no status was reported), so we cannot tell whether the slice succeeded.";

// The lead sentence when the agent reported an off-vocabulary status (e.g. `completed`) but delivered
// no PR — it claimed completion without delivering any work. Names the exact status it reported so the
// human sees this is distinct from a true no-result.
const completedWithoutDeliveryLead = (status: string): string =>
  `The implementation agent reported status "${status}" but opened no pull request (and pushed no branch) — it claimed completion without delivering any work.`;

// The shared tail: how recovery works (a delivered PR on the deterministic branch would have been
// adopted automatically), the workspace-confinement hint (#865 ask 3 — edits outside the run workspace
// are discarded on teardown), and the two answers the cell's `ic_gw_answer` gateway routes on.
const RECOVERY_TAIL =
  'A delivered PR on the slice\'s `feat/<task.id>` branch would have been adopted automatically; none was found (if the agent worked OUTSIDE its run workspace — e.g. `cd /tmp/<repo>` — those edits were discarded on teardown). Choose "Answer" and give guidance to re-run the slice — or choose "Abandon" to skip it and continue.';

/** Build the accurate, self-contained escalation reason for an implement-cell slice that reached the
 *  escalation arm with no adoptable PR. Distinguishes a true no-result from a claimed-completion-
 *  without-delivery, and always folds in the agent's own `summary` and the transcript link when present
 *  (#863). Pure — the single canonical implementation `record-feature-escalation` uses so the reason
 *  can never drift. */
export function implementEscalationQuestion(input: ImplementEscalationReasonInput): string {
  const status = str(input.status);
  const summary = str(input.summary);
  const transcriptUrl = str(input.transcriptUrl);

  const lead = status !== undefined && isClaimedCompletion(status)
    ? completedWithoutDeliveryLead(status)
    : NO_RESULT_LEAD;

  const parts = [lead];
  if (summary) parts.push(`The agent's own summary: "${summary}".`);
  if (transcriptUrl) parts.push(`Transcript: ${transcriptUrl}`);
  parts.push(RECOVERY_TAIL);
  return parts.join(" ");
}

/** The generic no-result question (blank status, no summary, no transcript) — the stable default the
 *  escalation recorder emits when the agent left nothing to read. Exported so the recorder and its tests
 *  share one constant. */
export const NO_RESULT_QUESTION: string = implementEscalationQuestion({});
