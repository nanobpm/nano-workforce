// nano-workforce — the ONE canonical "what is this PR's effective status" derivation (issue #959).
//
// THE DEFECT. `derived_status` came from the `instanceTracking` `onTerminated.set` edge, which maps
// **any** terminated run to `abandoned` without consulting the PR's merge state. But a run is
// terminated AFTER its PR merged in several legitimate ways — an operator cancels a loop that is
// redundant after a merge, an out-of-band merge (Mergify / a manual click) is reconciled, a restart
// or upgrade cleans up. Every one of those was recorded "abandoned", which made the status
// untrustworthy (an operator can't tell dropped work from shipped work) and skewed retro/conformance
// stats (`LANDED_PR_STATUSES` excludes `abandoned`, so merged PRs didn't count as landed).
//
// THE FIX (the defect class, not the instance). `abandoned` must mean "terminated AND the PR did not
// merge". When the PR landed — recorded on the base row's `merged_at` (set by `pr.mark-merged` or the
// out-of-band `retireTerminalReviewWait`) — the effective status is `merged` REGARDLESS of how the
// instance ended. This module owns that derivation ONCE, as a `defineReadModel` over the SAME
// canonical `urban_instance_state` projection the framework's tracking view uses, plus the base row's
// own `merged_at` column.
//
// HOW IT SHIPS. The model is named `pull_requests__tracking` — the EXACT managed-VIEW name urban's
// `instanceTracking` provisioner would otherwise create for the `pull_requests` binding
// (`instanceTrackingReadModelTarget`). Registering it into the process-wide `readModelRegistry` makes
// the framework's mount DEFER to this app-owned derivation: `provisionInstanceTrackingViews` refuses
// to clobber a registered read model of the same name (it logs and skips), and `mountWorkers`
// (`readModelRegistry.ensureViews`) — which runs BEFORE `mountInstanceTracking` — applies this VIEW.
// So every reader that already routes through `pull_requests__tracking.derived_status` (the abandon
// check, conformance, retro, the PR list, the read model) picks up the merge-aware edge with NO
// per-reader change — the "one canonical derivation, no per-reader logic" the issue asks for.
//
// PRECEDENCE (merged > terminated > waiting-human > base). The merged `WHEN` is emitted FIRST so a
// landed PR reads `merged` even when its instance was terminated; a terminated-unmerged run still
// reads `abandoned`; a waiting-on-human edge (none for pull_requests today, but kept for parity with
// the framework's derivation) still applies to a live, unmerged run; otherwise the worker-owned base
// `status` passes through.

import {
  and,
  caseWhen,
  col,
  defineReadModel,
  type Expr,
  eq,
  exists,
  isNotNull,
  lit,
  not,
  or,
  pcol,
  type ReadModel,
  readModelRegistry,
  when,
} from "@nanobpm/urban";
import { trackingBindingFor, trackingTargetFor } from "./instanceTracking.ts";

const TABLE = "pull_requests";

/** The engine-truth terminal lifecycle state the terminal edge keys on (mirrors urban's
 *  `TERMINATED_STATE`). Duplicated as a literal so this module derives from the public DSL primitives
 *  (`exists`/`pcol`) without reaching into urban's internals. */
const TERMINATED = "TERMINATED";

/** `EXISTS(urban_instance_state WHERE process_instance_key = base.<keyField> AND state='TERMINATED')`
 *  — the SAME terminal edge the framework's tracking derivation uses, keyed off the binding's
 *  `keyField` (`process_key`) so it can never drift from the reconciler's notion of "which column
 *  holds the engine instance key". */
function terminatedEdge(keyField: string): Expr {
  return exists(
    "urban_instance_state",
    and(eq(pcol("process_instance_key"), col(keyField)), eq(pcol("state"), lit(TERMINATED))),
  );
}

/** `EXISTS(urban_open_user_tasks WHERE process_instance_key = base.<keyField>)` — the wait-on-human
 *  edge, kept for parity with the framework's derivation (a binding that adds `onWaitingHuman` later
 *  still derives it correctly). */
function waitingHumanEdge(keyField: string): Expr {
  return exists("urban_open_user_tasks", eq(pcol("process_instance_key"), col(keyField)));
}

/** The landed signal: the base row's `merged_at` stamp OR a durable `merges.outcome='merged'` audit
 *  row. `pr.merge` writes the audit BEFORE the separate `pr.mark-merged` task stamps `merged_at`, so a
 *  run terminated between the two still landed — the audit alone must be sufficient. Neither signal
 *  depends on a retained instance-state row (a pruned/null `process_key` still reads `merged`). */
function landedEdge(): Expr {
  return or(
    isNotNull(col("merged_at")),
    exists("merges", and(eq(pcol("pr_key"), col("pr_key")), eq(pcol("outcome"), lit("merged")))),
  );
}

/** The merge-aware effective-status derivation for the `pull_requests` binding:
 *
 *   CASE
 *     WHEN <merged_at set OR merged audit row>         THEN 'merged'      -- landed wins, however the run ended
 *     WHEN <terminated>                                THEN <onTerminated> -- terminated-unmerged = abandoned
 *     WHEN <waiting-on-human> AND NOT <terminated>     THEN <onWaitingHuman>
 *     ELSE base.<statusField>                          -- the worker-owned transient
 *   END
 *
 * The merged `WHEN` precedes the terminated one so a landed PR is `merged` no matter how its run
 * ended; the terminated-unmerged branch preserves the manifest's `onTerminated.set.status` value
 * (`abandoned`) rather than hard-coding it, so the manifest stays the source of truth for the
 * not-landed terminal. */
export function derivePrEffectiveStatusExpr(): Expr {
  const binding = trackingBindingFor(TABLE);
  const statusField = binding.statusField ?? "status";
  const keyField = binding.keyField;
  const terminated = terminatedEdge(keyField);

  const whens = [
    // Landed beats terminated: a merged PR is `merged` even when its loop was terminated afterwards.
    when(landedEdge(), lit("merged")),
  ];
  const terminalStatus = binding.onTerminated?.set?.[statusField];
  if (typeof terminalStatus === "string") {
    whens.push(when(terminated, lit(terminalStatus)));
  }
  const waitingStatus = binding.onWaitingHuman?.set?.[statusField];
  if (typeof waitingStatus === "string") {
    whens.push(when(and(waitingHumanEdge(keyField), not(terminated)), lit(waitingStatus)));
  }
  return caseWhen(whens, col(statusField));
}

/** The app-owned `pull_requests__tracking` read model. `selectBaseColumns: true` (the default) so the
 *  VIEW re-exports `pull_requests.*` plus the derived `derived_status` — byte-compatible with the
 *  framework's own tracking VIEW shape, so every existing reader keeps working unchanged. */
export const pullRequestTrackingReadModel: ReadModel = defineReadModel({
  name: trackingTargetFor(TABLE).view,
  baseTable: TABLE,
  derive: { [trackingTargetFor(TABLE).statusColumn]: derivePrEffectiveStatusExpr() },
});

/** Register the merge-aware tracking VIEW into the process-wide `readModelRegistry` so the framework
 *  provisions THIS derivation (and defers its own). Call ONCE at boot, BEFORE `runFromEnv` mounts
 *  workers/instance-tracking. Idempotent: re-registering the identical definition is a no-op. */
export function registerPullRequestTrackingReadModel(): void {
  readModelRegistry.register(pullRequestTrackingReadModel);
}
