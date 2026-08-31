// The ONE Active/History `list_bucket` derivation, shared byte-for-byte by every "Active …" grid's
// read model (issue #641). All four dispatch surfaces — Features, Epics, Convergence (PRs) and
// Delivery Graphs — partition their rows into Active/History with the SAME acknowledge-to-dismiss rule:
// a row STAYS in Active until an operator dismisses it (stamps `acknowledged_at`), then drops to
// History. This module is that rule expressed ONCE in Urban's closed expression DSL, parameterised by
// each model's own terminal-status set, so the four read models cannot drift from one another (the
// last two base-`status` allowlists — Convergence + Delivery Graphs — are retired by consuming it).
//
// THE RULE (uniform across the four surfaces):
//   terminal & acknowledged NULL -> active   (stay until dismissed)
//   terminal                     -> history  (dismissed)
//   else (still live)            -> active
//
// which is exactly `history` IFF the row is in a truly-terminal status AND has been acknowledged; else
// `active`. Feature runs (app/featureReadModel.ts, migration 081) already encode this shape; this is
// its extraction so PRs / Delivery Graphs / Epics share the identical AST rather than re-authoring it.
//
// `acknowledged_at IS NOT NULL` is expressed via {@link isAckStamped} as a SELF-equality (`eq(col,
// col)`), NOT a bare `col(...)` boolean or a dedicated null-test: `eq` collapses a nullish operand to
// false in BOTH lowerings (`COALESCE(x = x, 0)` in SQL, the nullish guard in `compareValues` for TS),
// and any non-null value equals itself, so it is true IFF the column is non-NULL — free of the SQLite
// string→number truthiness coercion a bare column predicate would rely on, and byte-equivalent to the
// feature model's own `isNotNull` (app/featureReadModel.ts) so the shared oracle stays identical to
// migration 081's already-merged VIEW body.

import { and, caseWhen, col, type Expr, eq, lit, not, or, when } from "@nanobpm/urban";

/** `<effectiveStatusCol> IN (…terminal)` as a closed-DSL predicate: an OR of equalities over the
 * tracking VIEW's terminal-folded effective status. The single "is this row terminal?" test the
 * bucket/ack derivations share. */
export const terminalStatusIn = (effectiveStatusCol: string, terminalStatuses: readonly string[]): Expr =>
  or(...terminalStatuses.map((s) => eq(col(effectiveStatusCol), lit(s))));

/** `<ackCol> IS NOT NULL` in the closed DSL (which has no dedicated null-test operator): a SELF-equality
 * that collapses a nullish operand to false in both lowerings, so it is true IFF the column is
 * non-NULL. See the module header for why this exact form (not a bare `col`) is used. */
export const isAckStamped = (ackCol: string): Expr => eq(col(ackCol), col(ackCol));

/**
 * The Active/History partition over an arbitrary "dismissable-terminal" PREDICATE: `history` IFF the
 * predicate holds AND the row has been acknowledged; otherwise `active`. The predicate captures each
 * model's notion of a row that is BOTH terminal AND actually tick-off-able — for PRs/Delivery-Graphs/
 * features that is simply "terminal" ({@link deriveListBucketExpr}); for EPICS it additionally excludes
 * a still-`converging` done epic (which is terminal by `status` but must NOT be dismissable mid-flight),
 * so a stray/premature ack never drags it to History. Shared by all four surfaces so they cannot drift.
 */
export const deriveListBucketFromTerminal = (terminalPredicate: Expr, ackCol = "acknowledged_at"): Expr =>
  caseWhen([when(and(terminalPredicate, isAckStamped(ackCol)), lit("history"))], lit("active"));

/**
 * The operator "Dismiss" affordance flag over an arbitrary "dismissable-terminal" PREDICATE: `1` IFF
 * the predicate holds AND the row is not yet acknowledged, else `0`. The twin of {@link
 * deriveListBucketFromTerminal} (same predicate) — a row is dismissable exactly while it would still be
 * `active` on the terminal branch, i.e. terminal-and-unacknowledged (and, for epics, non-`converging`).
 */
export const deriveAckOpenFromTerminal = (terminalPredicate: Expr, ackCol = "acknowledged_at"): Expr =>
  caseWhen([when(and(terminalPredicate, not(isAckStamped(ackCol))), lit(1))], lit(0));

/**
 * The Active/History partition, parameterised by the model's terminal-status set: `history` IFF the
 * row's terminal-folded effective status is terminal AND it has been acknowledged; otherwise `active`
 * (live rows + terminal-but-UNACKNOWLEDGED rows that stay actionable until dismissed).
 *
 * @param effectiveStatusCol the terminal-folded status column the model classifies on (`derived_status`).
 * @param terminalStatuses   the model's terminal set (features' Done statuses, the PR terminal set, …).
 * @param ackCol             the acknowledgement column (defaults to `acknowledged_at`).
 */
export const deriveListBucketExpr = (
  effectiveStatusCol: string,
  terminalStatuses: readonly string[],
  ackCol = "acknowledged_at",
): Expr => deriveListBucketFromTerminal(terminalStatusIn(effectiveStatusCol, terminalStatuses), ackCol);

/**
 * The operator "Dismiss" (acknowledge) affordance flag: `1` IFF the row is terminal AND not yet
 * acknowledged (so the page's `showWhenField` Dismiss button renders only for a terminal-but-
 * unacknowledged row — never a still-live one, and never a re-dismiss of an already-filed row), else
 * `0`. The PR / Delivery-Graph twin of the epic's `ack_open` (app/planReadModel.ts), which additionally
 * gates on its `converging` sub-state; PRs and Delivery Graphs have no such mid-flight terminal, so
 * "terminal ∧ unacknowledged" is the whole predicate.
 */
export const deriveAckOpenExpr = (
  effectiveStatusCol: string,
  terminalStatuses: readonly string[],
  ackCol = "acknowledged_at",
): Expr => deriveAckOpenFromTerminal(terminalStatusIn(effectiveStatusCol, terminalStatuses), ackCol);
