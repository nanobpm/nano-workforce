// The `pull_requests_read_model` derived read model — DECLARED ONCE and compiled to BOTH backends via
// Urban's ADR-0065 reconciling-read-model primitive (`defineReadModel`, `@nanobpm/urban`). The
// exemplars are app/featureReadModel.ts / app/deliveryGraphReadModel.ts; this is the Convergence-PR
// twin (issue #641).
//
// WHY IT EXISTS. Before #641 the Convergence (PRs) surfaces — Overview's "Active PR convergences" and
// home's "Pull requests" — filtered the RAW `pull_requests` table on a hand-synced base-`status`
// allowlist (the 7 in-flight convergence states), so a PR dropped out of Active the instant its
// `status` reached a terminal state, with NO operator dismiss. That is the last-but-one base-`status`
// allowlist #637 set out to retire. This model gives PRs the SAME acknowledge-to-dismiss behaviour as
// Features/Epics/Delivery-Graphs: a terminal PR STAYS in Active until an operator dismisses it
// (`acknowledgePr` stamps `acknowledged_at`), then drops to History — the derived `list_bucket`
// (app/listBucket.ts, the ONE shared oracle) is the single activeness predicate every "Active …" grid
// now filters.
//
// BASE TABLE. Reads the auto-provisioned `pull_requests__tracking` derived VIEW (ADR-0065), NOT the raw
// `pull_requests` table: it re-exports `pull_requests.*` plus a terminal-folded `derived_status` (the
// `instanceTracking` reconciler's `onTerminated → abandoned` edge, recomputed on read), so a
// terminated PR classifies on ENGINE TRUTH — exactly as `feature_read_model` reads
// `feature_runs__tracking`.

import { defineReadModel, type Expr, type ReadModel } from "@nanobpm/urban";
import { deriveAckOpenExpr, deriveListBucketExpr } from "./listBucket.ts";

/** The read model's VIEW name — the single source of truth for the table an operation queries when it
 * must gate on the folded/effective status (e.g. `acknowledgePr`, issue #652) rather than re-derive
 * terminality off the frozen base `pull_requests.status` column. */
export const PULL_REQUEST_READ_MODEL_NAME = "pull_requests_read_model";

/** The base table the read model reads: the auto-provisioned `pull_requests__tracking` derived VIEW
 * (ADR-0065), NOT the raw `pull_requests` table — so the status-classifying derivations read the
 * terminal-folded `derived_status` and a terminated PR drops to History with no worker write. */
export const PULL_REQUEST_READ_MODEL_BASE_TABLE = "pull_requests__tracking";

/** The base alias the managed VIEW gives `pull_requests__tracking` — pinned so the emitted derived-
 * column SQL (`pr."col"`) matches the migration exactly (the drift guard compares against this alias). */
export const PULL_REQUEST_READ_MODEL_BASE_ALIAS = "pr";

/** The effective (terminal-folded) status column the bucket/ack derivations classify on — the tracking
 * VIEW's `derived_status`. Single source of truth for the name so the derivations can't drift from it. */
export const EFFECTIVE_STATUS_COLUMN = "derived_status";

/** The PR statuses that are TERMINAL for the Active/History partition (issue #641). A PR in any of
 * these has finished its convergence/merge lifecycle: `merged` (landed), `converged` (review-only
 * consensus, no auto-merge), `abandoned` (cancelled / out-of-band terminated — the reconciler's
 * `onTerminated` edge), `closed` (the PR was closed on GitHub without merging), `failed` (a terminal
 * merge/convergence failure). Distinct from `deliveryStatuses.ts`'s `TERMINAL_STATUSES` (the epic-
 * delivery in-flight fold, which counts `converged`/`merged`/`abandoned` only): this is the FULL PR
 * terminal tier the acknowledge-to-dismiss rule folds to History. */
export const PR_TERMINAL_STATUSES: readonly string[] = ["merged", "converged", "abandoned", "closed", "failed"];

/** The Active/History partition — `history` IFF the PR is terminal AND acknowledged, else `active`
 * (live PRs + terminal-but-UNACKNOWLEDGED PRs that stay actionable until dismissed). The ONE shared
 * oracle (app/listBucket.ts) parameterised by {@link PR_TERMINAL_STATUSES}. */
const listBucket: Expr = deriveListBucketExpr(EFFECTIVE_STATUS_COLUMN, PR_TERMINAL_STATUSES);

/** The operator "Dismiss" affordance flag — `1` IFF the PR is terminal AND not yet acknowledged (so the
 * page's `showWhenField` Dismiss button renders only for a terminal-but-unacknowledged PR), else `0`. */
const ackOpen: Expr = deriveAckOpenExpr(EFFECTIVE_STATUS_COLUMN, PR_TERMINAL_STATUSES);

/** The keys of {@link pullRequestReadModel}'s DERIVED columns, in the order the migration emits them.
 * Base columns are identity pass-throughs (not derivations) and are listed in the migration directly. */
export const PULL_REQUEST_READ_MODEL_DERIVED = ["list_bucket", "ack_open"] as const;
export type PullRequestReadModelDerivedColumn = (typeof PULL_REQUEST_READ_MODEL_DERIVED)[number];

/**
 * The declare-once `pull_requests_read_model` derived columns. `selectBaseColumns: false` because the
 * base columns are plain identity pass-throughs enumerated in the migration (so the static
 * pages↔schema contract guard, which reads a VIEW's columns off an aliased select-list, sees them).
 * Both the migration VIEW (`sqlSelectFor`, drift-guarded) and the runtime TS oracle (`fnFor`) are
 * generated from THIS single declaration.
 */
export const pullRequestReadModel: ReadModel = defineReadModel({
  name: PULL_REQUEST_READ_MODEL_NAME,
  baseTable: PULL_REQUEST_READ_MODEL_BASE_TABLE,
  selectBaseColumns: false,
  derive: {
    list_bucket: listBucket,
    ack_open: ackOpen,
  },
});
