// Escalation taxonomy — the single canonical source of truth for classifying an
// escalation raise site into a tier (nano-workforce ADR 0002 §1).
//
// The app used to page a human from several independent raise sites, each with its own
// ad-hoc "should this become an escalation?" logic, and — worst of all — a blank/absent
// question could FABRICATE an answerable escalation (or, on the plan-fanout arm, wedge an
// un-remediable incident). This module replaces that scattered logic with ONE classifier so
// every raise site, and every downstream escalation-conversion slice (U2–U7), asks the same
// question in the same place.
//
// ADR 0002 §1 defines three tiers:
//   • transient        — handled in-process (retry / re-enter a durable wait / re-request a
//                        review). Never becomes a task. The empty-status backstop and the
//                        re-request-review nudge are transient.
//   • advisory         — recorded on the coordination blackboard for humans/siblings to read.
//                        Never becomes a task and never blocks a token.
//   • decision-required — a human (or, per ADR 0046, an agent assignee) must make a call.
//                        ONLY this tier proceeds toward a user task.
//
// A fourth disposition, `none`, means "not an escalation at all": the signal was raised but,
// on inspection, there is nothing to escalate — most importantly a decision-required kind
// whose question is blank. A blank question can no longer fabricate an answerable escalation:
// it is a NON-escalation (no task, no wait).

/** The three escalation tiers of ADR 0002 §1. */
export type EscalationTier = "transient" | "advisory" | "decision-required";

/** A raise site's disposition: either it is not an escalation at all (`none`), or it falls
 * into one of the three tiers. Only `decision-required` proceeds toward a user task. */
export type EscalationDisposition = "none" | EscalationTier;

/** Every escalation raise site in the codebase, tagged by origin so the classifier can apply
 * that site's policy. */
export type EscalationKind =
  // convergence-loop `gw-status` gateway — the review-round "safe default" routing that
  // `roundResultDefault` mirrors.
  | "review-round"
  // `baseGuard` (app/baseGuard.ts) — a PR that targets a dead-end (already-landed) base.
  | "dead-end-base"
  // `mergeProtocol` (app/mergeProtocol.ts) — the repo's declared land method.
  | "merge-protocol"
  // plan-fanout `w_gw` "escalated?" gateway — an implementation agent reported
  // `status = "escalated"` with a question.
  | "task";

/** Everything the classifier may need from any raise site. Each field is consumed only by the
 * kind(s) it applies to; the rest are ignored. */
export interface EscalationSignal {
  kind: EscalationKind;
  /** The human-facing question / reason. Blank (absent, empty, or whitespace-only) means the
   * signal can never become a task — see {@link hasAnswerableQuestion}. */
  question?: string | null;
  /** `review-round` only: the machine-readable status the review agent reported. */
  status?: string | null;
  /** `dead-end-base` only: whether the base is a CONFIRMED dead end (ambiguity is never a
   * dead end — see {@link import("./baseGuard.ts").isDeadEndBase}). */
  deadEnd?: boolean;
  /** `merge-protocol` only: the repo's declared land method (`ui` needs a human). */
  landMethod?: string | null;
}

/** True iff `question` is a concrete, human-answerable string — a non-blank value after
 * trimming. This is the canonical blank-question rule the whole taxonomy shares: an
 * empty / whitespace-only / absent question is NOT answerable, so it can never fabricate an
 * escalation. */
export function hasAnswerableQuestion(question: string | null | undefined): boolean {
  return typeof question === "string" && question.trim() !== "";
}

/** The review-round statuses that DEMAND a human decision. Any other status (converged,
 * addressed, waiting, or an unknown/empty one — the empty-status backstop) is transient: it
 * re-enters the durable review wait rather than paging a human. */
const DECISION_STATUSES: ReadonlySet<string> = new Set(["needs_input", "blocked"]);

/** Classify an escalation signal into its disposition. The one place the tiered taxonomy of
 * ADR 0002 §1 is decided — every raise site and every escalation-conversion slice routes
 * through here rather than re-deriving tier logic per kind. */
export function classifyEscalation(signal: EscalationSignal): EscalationDisposition {
  switch (signal.kind) {
    case "review-round": {
      // Exact-token match, mirroring the convergence-loop `gw-status` gateway (whose
      // status conditions do NOT trim) so this canonical router can never drift from the
      // deployed model. `status` is a machine-produced enum, not free-form prose, so it is
      // compared exactly — unlike `question`, whose blank-detection trims (hasAnswerableQuestion).
      const status = signal.status ?? "";
      // Only an explicit human-blocking status is even a candidate; everything else is
      // transient (re-enter the review wait — this is the empty-status backstop).
      if (!DECISION_STATUSES.has(status)) return "transient";
      // A human-blocking status with no answerable question is a NON-escalation: a blank
      // question can no longer fabricate an answerable escalation.
      return hasAnswerableQuestion(signal.question) ? "decision-required" : "none";
    }
    case "dead-end-base":
      // A confirmed dead-end base needs a human retarget; ambiguity is never raised, so a
      // non-dead-end signal is simply not an escalation.
      return signal.deadEnd ? "decision-required" : "none";
    case "merge-protocol":
      // Only a `ui` land method needs a human (to click Merge). Every machine-landable method
      // (gh-merge / admin / mergify-queue) stays in-process — transient.
      return signal.landMethod === "ui" ? "decision-required" : "transient";
    case "task":
      // The agent declared `status = "escalated"`; a blank question is a NON-escalation. This
      // retires the blank-question fabrication failure mode — no task, no wait.
      return hasAnswerableQuestion(signal.question) ? "decision-required" : "none";
    default:
      return "none";
  }
}

/** The guard every raise site and escalation-conversion slice shares: does this signal proceed
 * toward a user task? Only the `decision-required` tier does — transient and advisory signals,
 * and non-escalations (`none`, including blank-question signals), never raise a task. */
export function shouldRaiseTask(signal: EscalationSignal): boolean {
  return classifyEscalation(signal) === "decision-required";
}
