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
import { hasAnswerableQuestion } from "./escalationTaxonomy.ts";

/** The agent result vocabulary the implement-cell recognises (resources/prompts/feature.md). Any other
 *  reported status is OFF-vocabulary: the agent reported an outcome the cell cannot route on.
 *  `opened`/`blocked`/`skipped` are clean terminals the `ic_gw` "clean terminal?" gate converges before
 *  the escalation arm; `escalated` is the agent's own answerable escalation. */
export const RECOGNIZED_IMPLEMENT_STATUSES: ReadonlySet<string> = new Set([
  "opened",
  "blocked",
  "skipped",
  "escalated",
]);

/** The AFFIRMATIVE-completion aliases an agent reports off-vocabulary when it believes it SUCCEEDED
 *  (feature.md names `completed`/`done`/`success` as the canonical examples of this mistake). ONLY these
 *  off-vocabulary words claim completion. A non-affirmative off-vocabulary status — `failed`,
 *  `needs_input`, `error`, or any unknown word — reports a FAILURE / INPUT-REQUIRED / UNKNOWN outcome,
 *  NOT a completion: treating it as one would adopt a failure as success or auto-retry it with a false
 *  "claimed completion" diagnosis (issue #865 review). This is the shared source of truth for "did the
 *  agent CLAIM COMPLETION?" — `implementReconcile` reads it to decide whether to look for / retry a
 *  delivered PR, and this module reads it to word the escalation accurately. Matched case-insensitively
 *  so `Completed`/`DONE` are caught too. */
export const AFFIRMATIVE_COMPLETION_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "complete",
  "done",
  "success",
  "succeeded",
  "finished",
  "finish",
]);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** True iff `status` is a non-blank AFFIRMATIVE-completion alias (e.g. `completed`/`done`/`success`) —
 *  the "claimed-completion-without-delivery" signal. A blank/absent status is NOT a claimed completion
 *  (it is a no-result); a recognised status (`opened`/`escalated`/…) is the agent's own routed outcome;
 *  and a non-affirmative off-vocabulary status (`failed`/`needs_input`/unknown) is a reported
 *  failure/input-required/unknown outcome, NOT a completion claim (issue #865 review). */
export function isClaimedCompletion(status: unknown): boolean {
  const s = str(status);
  return s !== undefined && AFFIRMATIVE_COMPLETION_STATUSES.has(s.toLowerCase());
}

/** The outcome the escalation reason distinguishes:
 *  - `no-result` = blank/absent status — the agent returned nothing we can read;
 *  - `completed-without-delivery` = an affirmative-completion alias was reported (the agent CLAIMED
 *    completion) but no PR/branch was delivered;
 *  - `reported-status` = some OTHER non-blank status reached the escalation arm with no answerable
 *    question — a recognised status such as `escalated` whose question was blank, or a non-affirmative
 *    off-vocabulary failure/input-required/unknown. It names the reported status accurately rather than
 *    falsely claiming "no status was reported" (#865 review) or "claimed completion". */
export type ImplementEscalationKind = "no-result" | "completed-without-delivery" | "reported-status";

export function classifyImplementEscalation(status: unknown): ImplementEscalationKind {
  const s = str(status);
  if (s === undefined) return "no-result";
  return isClaimedCompletion(s) ? "completed-without-delivery" : "reported-status";
}

/** What the escalation builder needs from the implement-step outcome. `question` is the agent's OWN
 *  answerable question (when it raised a genuine escalation) — used as the lead when present; `summary`
 *  is the agent's own one-line result (always surfaced when present); `transcriptUrl` is the run's
 *  transcript link (cf. #863).
 *
 *  Delivery EVIDENCE (issue #865 review — never assert an UNVERIFIED delivery claim):
 *  - `pr` is any PR key still in scope. An `escalated`/`failed` result with a blank question RETAINS its
 *    PR (the reconcile step carries it through without a GitHub lookup), so when `pr` is set the reason
 *    must NAME it — never the false "opened no pull request".
 *  - `deliveryVerified` is whether a GitHub lookup actually CONFIRMED the delivery state. It is `true`
 *    only when the reconcile step's lookup SUCCEEDED and found no adoptable PR — the one case where the
 *    reason may say "no adoptable PR was found". It is `false`/absent when no lookup ran, the lookup
 *    threw, or the transport was unavailable (a `null` listing): there the delivery state is UNVERIFIED,
 *    so the reason says the delivery "could not be confirmed" rather than asserting an absence it never
 *    checked. Note `deliveryVerified === true` verifies only the absence of an ADOPTABLE PR (an open PR
 *    on the required base) — it does NOT check branch existence, so a wrong-base PR means the branch may
 *    still be pushed; the reason never claims "pushed no branch" (#865 review). */
export interface ImplementEscalationReasonInput {
  status?: unknown;
  question?: unknown;
  summary?: unknown;
  transcriptUrl?: unknown;
  pr?: unknown;
  deliveryVerified?: unknown;
}

// The lead sentence for a genuine no-result (blank status) — the agent returned nothing we can read.
const NO_RESULT_LEAD =
  "The implementation agent finished without a machine-readable result (no status was reported), so we cannot tell whether the slice succeeded.";

// The delivery clause qualifies the lead with what is actually KNOWN about delivery (issue #865 review):
//  - a preserved PR (`pr`) is NAMED — the agent may have delivered, so we never claim it opened none;
//  - a VERIFIED absence (`deliveryVerified === true`: the reconcile lookup succeeded and found no
//    adoptable PR) is the one case that may assert "no adoptable pull request was found". The lookup
//    checks only for an ADOPTABLE PR (an open PR on the required base) — it does NOT check branch
//    existence, so a wrong-base PR leaves the branch pushed; the clause never claims "pushed no branch";
//  - anything else (no lookup ran, the lookup threw, or the transport was unavailable) is UNVERIFIED —
//    the clause says delivery "could not be confirmed" rather than asserting an absence never checked.
function deliveryClause(pr: string | undefined, deliveryVerified: boolean): string {
  if (pr) return `it may already have a pull request open as ${pr} (preserved from the run, not re-verified)`;
  if (deliveryVerified) return "a GitHub lookup confirmed no adoptable pull request was found for this slice on its base branch";
  return "its delivery could not be confirmed (no GitHub lookup verified whether it opened a pull request or pushed a branch)";
}

// The lead sentence when the agent reported an affirmative-completion alias (e.g. `completed`) — it
// claimed completion. The delivery clause states only what is verified about delivery (never an
// unverified "opened no pull request"). Names the exact status so the human sees this is distinct from
// a true no-result.
const completedWithoutDeliveryLead = (status: string, delivery: string): string =>
  `The implementation agent reported status "${status}" — it claimed completion — but ${delivery}.`;

// The lead sentence when the agent reported SOME other status (a recognised `escalated` with a blank
// question, or a non-affirmative off-vocabulary failure/input-required/unknown) and left no answerable
// question. Names the exact reported status — never the false "no status was reported" diagnosis
// (#865 review) — and does not claim completion. The delivery clause states only what is verified.
const reportedStatusLead = (status: string, delivery: string): string =>
  `The implementation agent reported status "${status}" and gave no answerable question, but ${delivery}, so we cannot tell whether the slice succeeded.`;

// The shared tail: how recovery works, the workspace-confinement hint (#865 ask 3 — edits outside the
// run workspace are discarded on teardown), and the two answers the cell's `ic_gw_answer` gateway routes
// on. The delivery-absence clause is EVIDENCE-BASED (issue #865 review): only a verified lookup says
// "no adoptable PR was found on the base branch" (it does NOT verify branch existence — a wrong-base PR
// leaves the branch pushed, so it never claims "no branch"); an unverified delivery says so instead of
// asserting an absence never checked.
function recoveryTail(pr: string | undefined, deliveryVerified: boolean): string {
  const absence = pr
    ? `A pull request may already be open as ${pr} — check and retarget or adopt it before re-running`
    : deliveryVerified
      ? "A delivered PR on the slice's `feat/<task.id>` branch targeting this run's base would have been adopted automatically; no adoptable PR was found on the base branch (the branch may still be pushed — e.g. a PR targeting a different base — so check and retarget it before re-running)"
      : "A delivered PR on the slice's `feat/<task.id>` branch would have been adopted automatically, but no lookup confirmed whether one exists";
  return `${absence} (if the agent worked OUTSIDE its run workspace — e.g. \`cd /tmp/<repo>\` — those edits were discarded on teardown). Choose "Answer" and give guidance to re-run the slice — or choose "Abandon" to skip it and continue.`;
}

/** Build the accurate, self-contained escalation reason for an implement-cell slice that reached the
 *  escalation arm. When the agent raised a GENUINE escalation (an answerable `question`), its own
 *  question is the lead and its `summary`/transcript are folded in as the supporting decision context
 *  (`pollUserTasks` surfaces this — #865 review). Otherwise it synthesises an accurate reason —
 *  distinguishing a true no-result from a claimed-completion-without-delivery and from a reported
 *  non-completion status — folds in the agent's own `summary` and the transcript link when present
 *  (#863), and appends the recovery tail. Pure — the single canonical implementation
 *  `record-feature-escalation` uses so the reason can never drift. */
export function implementEscalationQuestion(input: ImplementEscalationReasonInput): string {
  const question = str(input.question);
  const summary = str(input.summary);
  const transcriptUrl = str(input.transcriptUrl);

  // The agent declared a genuine, answerable escalation: lead with its own question, then preserve its
  // summary and transcript so the human has the full supporting context (#865 review — otherwise an
  // `escalated` result's summary/transcript were dropped and only the bare question survived). No
  // recovery tail here — this is the agent's own decision, not a missing-delivery recovery.
  if (question && hasAnswerableQuestion(question)) {
    return withContext([question], summary, transcriptUrl).join(" ");
  }

  // No answerable question — synthesise an accurate reason by outcome, fold in the context, then append
  // the recovery tail (how a human recovers the slice). The delivery evidence (`pr` still in scope, and
  // whether a lookup VERIFIED the delivery state) qualifies every delivery claim so the reason never
  // asserts an UNVERIFIED absence (#865 review).
  const status = str(input.status);
  const pr = str(input.pr);
  const deliveryVerified = input.deliveryVerified === true;
  const delivery = deliveryClause(pr, deliveryVerified);
  const parts = withContext([leadForKind(classifyImplementEscalation(status), status, delivery)], summary, transcriptUrl);
  parts.push(recoveryTail(pr, deliveryVerified));
  return parts.join(" ");
}

/** The lead sentence for a synthesised (no-answerable-question) escalation, by classified kind. The
 *  `delivery` clause (built from the preserved PR + the verified-lookup flag) states only what is
 *  actually known about delivery — never an unverified "opened no pull request" (#865 review). */
function leadForKind(kind: ImplementEscalationKind, status: string | undefined, delivery: string): string {
  switch (kind) {
    case "no-result":
      return NO_RESULT_LEAD;
    case "completed-without-delivery":
      return completedWithoutDeliveryLead(status ?? "", delivery);
    case "reported-status":
      return reportedStatusLead(status ?? "", delivery);
  }
}

/** Append the agent's own summary and transcript link to an escalation reason when present (#863). */
function withContext(parts: string[], summary: string | undefined, transcriptUrl: string | undefined): string[] {
  if (summary) parts.push(`The agent's own summary: "${summary}".`);
  if (transcriptUrl) parts.push(`Transcript: ${transcriptUrl}`);
  return parts;
}

/** The generic no-result question (blank status, no summary, no transcript) — the stable default the
 *  escalation recorder emits when the agent left nothing to read. Exported so the recorder and its tests
 *  share one constant. */
export const NO_RESULT_QUESTION: string = implementEscalationQuestion({});
