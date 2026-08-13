// Review-round "safe default" routing — the canonical, testable mirror of the convergence-loop
// `gw-status` exclusive gateway (see resources/processes/convergence-loop.bpmn and the structural
// guard in roundResultDefault.test.ts).
//
// A review round that exits without a machine-readable result (empty/unknown status) must NOT
// escalate: the round-cap gate and the review-wait timeout already provide the human-escalation
// safety nets, and `persist-round` defaults an absent status to `addressed`. Escalation is an
// EXPLICIT decision, delegated here to the single canonical taxonomy so this routing can never
// drift from the tier logic every other raise site uses.
//
// Crucially, a human-blocking status (`needs_input` / `blocked`) with a BLANK question is a
// NON-escalation — it re-enters the durable review wait rather than fabricating an answerable
// escalation. The gateway enforces the same rule via its `f_escalate` condition.

import { classifyEscalation } from "./escalationTaxonomy.ts";

/** Where a review-round result routes:
 *  • `converged` — the PR is done (success path).
 *  • `escalate`  — a decision-required escalation (human-blocking status + answerable question).
 *  • `reenter`   — everything else re-enters the durable review wait / round-cap guard: an
 *                  addressed/waiting/unknown/empty status, OR a human-blocking status whose
 *                  question is blank (the retired blank-question fabrication path). */
export type RoundRouting = "converged" | "escalate" | "reenter";

/** Route a review-round result exactly as `gw-status` does, delegating the escalation decision
 * to {@link classifyEscalation}. A round only escalates when the taxonomy classifies it as
 * `decision-required`; otherwise it converges or re-enters the loop. */
export function routeRoundResult(
  status: string | null | undefined,
  question?: string | null,
): RoundRouting {
  if ((status ?? "").trim() === "converged") return "converged";
  const disposition = classifyEscalation({ kind: "review-round", status, question });
  return disposition === "decision-required" ? "escalate" : "reenter";
}
