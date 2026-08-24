// Lineage projection (issue #245): thread user intent → progress as one arc.
//
// The stages of a request (feature/epic issue → implementation → PR → convergence → merge → outcome)
// already exist in the data layer as separate rows, keyed by the origin identity that `submitPr`
// threads onto every descendant (`pull_requests.root_request_key`, mirrored from `feature_runs` /
// `plans`). This module STITCHES them into one ordered narrative per `root_request_key`, exposing
// the active frontier (the stage currently in motion) plus settled history — the read model behind
// the "one narrative per intent, not a card-swap" UI.
//
// Two halves:
//   • `deriveLineage` — a PURE function: origin (feature run / epic plan / self-rooted PR) + its PR
//     rows → a `LineageThread` (stage, human label, active flag, member PRs). No I/O, fully tested.
//   • `getLineage` / `pollLineage` — the gateway glue: read the live rows for a root (or every root)
//     and project them. `pollLineage` denormalises the result onto the `lineage_threads` read table
//     the schema-driven pages consume (Urban's datasource cannot read a SQL VIEW), mirroring the
//     `pollDelivery` / `pollFeatureDelivery` convention.
//
// Human-opened / webhook PRs with no originating request are their OWN root: `submitPr` self-roots
// them by persisting `root_request_key = pr_key`. The projection self-roots the thread on the
// `pr_key` (kind `pr`), and also tolerates a legacy NULL `root_request_key` the same way.
import type { DataLayer } from "@nanobpm/urban";
import { deriveDelivery, TERMINAL_STATUSES } from "./delivery.ts";
import { type DeliveryGraphRun, deliveryGraphRuns } from "./deliveryGraphRun.ts";
import { type FeatureRun, featureRuns } from "./feature.ts";
import { derivedTrackingTable } from "./instanceTracking.ts";
import { type Plan, type PlanTask, plans, planTasks } from "./plan.ts";

const now = () => new Date().toISOString();

/** The origin shapes a lineage arc can spring from. */
export type LineageKind = "feature" | "epic" | "pr" | "delivery";

/** A member PR of a lineage thread — the subset of `pull_requests` the projection reads. */
export interface LineagePr {
  prKey: string;
  title: string | null;
  url: string;
  status: string;
  round: number;
  processKey: string | null;
  outcome: string | null;
}

/** The origin (request) a thread is rooted on. Discriminated by `kind`. */
export type LineageOrigin =
  | {
      kind: "feature";
      key: string;
      title: string | null;
      issueUrl: string | null;
      status: string;
      processKey: string | null;
    }
  | {
      kind: "epic";
      key: string;
      title: string | null;
      issueUrl: string | null;
      status: string;
      processKey: string | null;
      // The epic's derived domain phase (`plans.epic_phase`, 038_plan_epic_phase.sql) — e.g.
      // "Implementing (wave 3/5)". NULL for pre-#261 epics that never stamped a phase; the thread
      // then falls back to its delivery-rollup `stageLabel` for the projected `epicPhaseLabel`.
      epicPhase: string | null;
    }
  | {
      // A human/webhook PR with no originating request: its own root.
      kind: "pr";
      key: string;
    }
  | {
      // A delivery-graph run (issue #498): a FAN-IN parent thread. The run is the thread root, and
      // the heterogeneous downstream tasks it spawns — PR convergences across different repos/issue
      // numbers, package publishes, human gates — nest under it (they thread `root_request_key =
      // run_key`, mirroring how `submitPr` threads feature/epic roots). Closer to an epic than a
      // single-PR arc.
      kind: "delivery";
      key: string;
      title: string | null;
      status: string;
      // The run's already-derived display phase (`delivery_graph_runs.phase`, recomputed by
      // `pollDeliveryGraphPhase` from engine truth — generalised from `epic_phase`), e.g. "Running",
      // "Parked on human node: manual OTP publish", "Completed". NULL until the poller stamps one; the
      // thread then falls back to a status-derived frontier label.
      phase: string | null;
      processKey: string | null;
    };

/** One stitched arc: `request → implementation → PR(s) → convergence → merge → outcome`. */
export interface LineageThread {
  rootRequestKey: string;
  kind: LineageKind;
  title: string | null;
  issueUrl: string | null;
  /** Active-frontier machine label — the stage currently in motion (or the settled terminal). */
  stage: LineageStage;
  /** Human narrative rollup for the timeline (e.g. "Converging (round 2)", "3/5 slices merged, …"). */
  stageLabel: string;
  /** The epic-phase/stage label projected onto each member PR's `pull_requests.epic_phase_label`, so
   *  the Convergence PR-row detail can show an epic slice its parent epic's phase (issue #304). For an
   *  epic thread it is the epic's `epic_phase` (e.g. "Implementing (wave 3/5)"), falling back to the
   *  delivery-rollup `stageLabel` when the epic never stamped a phase. NULL for feature/self-rooted
   *  threads — their member PRs are not epic slices, so the epic panel stays empty for them. */
  epicPhaseLabel: string | null;
  /** The active-frontier process instance (for the processExplorer link), best-effort. */
  processKey: string | null;
  prKeys: string[];
  prCount: number;
  /** True while the arc has an active frontier; false once every stage has settled. */
  active: boolean;
  prs: LineagePr[];
}

/** The controlled vocabulary of frontier stages, ordered request → outcome. */
export const LINEAGE_STAGES = [
  "planning", // epic: planner decomposing the issue
  "implementing", // feature/epic: agent(s) building, no PR handed off yet
  "escalated", // parked on a human answer (implementation- or review-phase)
  "blocked", // awaiting operator acknowledgement (blocked run)
  "opened", // a PR was opened but not yet enrolled into convergence
  "converging", // enrolled: review rounds in flight
  "reviewing", // waiting on an external review
  "merging", // converged: the merge-loop is landing it
  "merged", // terminal: landed
  "converged", // terminal: review consensus reached, not merged (converge-only)
  "abandoned", // terminal: gave up
  "resolved", // terminal: settled without a clean merged/converged (mixed epic outcome)
] as const;
export type LineageStage = (typeof LINEAGE_STAGES)[number];

const TERMINAL_STAGES: readonly LineageStage[] = ["merged", "converged", "abandoned", "resolved"];

/** Map a single PR's `pull_requests.status` onto a frontier stage. */
function prStage(status: string): LineageStage {
  switch (status) {
    case "converging":
      return "converging";
    case "waiting_review":
      return "reviewing";
    case "escalated":
      return "escalated";
    case "waiting_deps":
    case "waiting_merge":
    case "waiting_lane":
    case "queued":
    case "merging":
      return "merging";
    case "converged":
      return "converged";
    case "merged":
      return "merged";
    case "abandoned":
      return "abandoned";
    default:
      // Unknown/legacy status: treat as in-flight convergence rather than silently terminal.
      return "converging";
  }
}

/** Map a feature run's own (pre-hand-off) status onto a frontier stage. */
function featureOriginStage(status: string): LineageStage {
  switch (status) {
    case "running":
      return "implementing";
    case "escalated":
      return "escalated";
    case "awaiting_operator":
      return "blocked";
    case "opened":
      return "opened";
    case "blocked":
    case "failed":
      return "abandoned";
    case "skipped":
    case "abandoned":
      return "abandoned";
    default:
      return "implementing";
  }
}

/** Pick the PR that best represents a single-PR arc's frontier: the sole active one, else the last
 * one in the caller-supplied order. `deriveLineage` supplies a `prKey`-sorted list, so among several
 * terminal PRs this is the deterministic last-by-key — NOT a timestamp-based "most recent". */
function representativePr(prs: readonly LineagePr[]): LineagePr | null {
  if (prs.length === 0) return null;
  const active = prs.find((p) => !TERMINAL_STATUSES.includes(p.status));
  return active ?? prs[prs.length - 1];
}

function prStageLabel(stage: LineageStage, round: number): string {
  switch (stage) {
    case "converging":
      return round > 0 ? `Converging (round ${round})` : "Converging";
    case "reviewing":
      return round > 0 ? `Awaiting review (round ${round})` : "Awaiting review";
    case "escalated":
      return "Escalated — awaiting answer";
    case "merging":
      return "Merging";
    case "merged":
      return "Merged";
    case "converged":
      return "Converged (not merged)";
    case "abandoned":
      return "Abandoned";
    default:
      return "Opened";
  }
}

/** Derive the stitched thread for one root from its origin and PR rows. Pure + total. */
export function deriveLineage(origin: LineageOrigin, prsIn: readonly LineagePr[]): LineageThread {
  // Sort deterministically by PR key so the projection is stable across passes: the upstream
  // collection order is not guaranteed (DataLayer `.all()` has no `ORDER BY`, plus Map iteration),
  // so an ordering-only difference would otherwise rewrite `lineage_threads.pr_keys` (and could
  // flip the representative-PR pick among terminal PRs) on steady-state polls, defeating the
  // idempotence check in `pollLineage`.
  const prs = [...prsIn].sort((a, b) => a.prKey.localeCompare(b.prKey));
  const prKeys = prs.map((p) => p.prKey);
  const rep = representativePr(prs);

  let stage: LineageStage;
  let stageLabel: string;
  let processKey: string | null;

  if (origin.kind === "epic") {
    // Fan-out: roll the slice PRs up via the shared delivery derivation, then translate to a stage.
    // Pass the epic's real status (not a hard-coded "done"): we only consume the rollup's PR counts,
    // which `deriveDelivery` computes independently of `planStatus`, but threading the true status
    // keeps this correct if the derivation ever gates those counts on it.
    const rollup = deriveDelivery(origin.status, prs.map((p) => p.status));
    const anyActive = prs.some((p) => !TERMINAL_STATUSES.includes(p.status));
    if (prs.length === 0) {
      stage = origin.status === "planning" ? "planning" : "implementing";
      stageLabel = origin.status === "planning" ? "Planning" : "Implementing";
    } else if (anyActive) {
      stage = "converging";
      stageLabel = `${rollup.prsMerged}/${rollup.prsOpened} slices merged, ${rollup.prsInFlight} converging`;
    } else if (rollup.prsMerged === rollup.prsOpened) {
      stage = "merged";
      stageLabel = `${rollup.prsOpened}/${rollup.prsOpened} slices merged`;
    } else {
      stage = "resolved";
      stageLabel = `${rollup.prsMerged}/${rollup.prsOpened} slices merged (rest resolved)`;
    }
    // Active-frontier instance: an in-flight slice PR's process, else the plan's own.
    const activePr = prs.find((p) => !TERMINAL_STATUSES.includes(p.status));
    processKey = activePr?.processKey ?? origin.processKey ?? rep?.processKey ?? null;
  } else if (origin.kind === "feature") {
    if (rep && !isPreHandoff(origin.status)) {
      // Handed off (converging, or a reconciled terminal): the PR frontier drives the narrative.
      stage = prStage(rep.status);
      stageLabel = prStageLabel(stage, rep.round);
      processKey = rep.processKey ?? origin.processKey ?? null;
    } else {
      // Still in the request/implementation phase — no hand-off yet (or the PR row is missing).
      stage = featureOriginStage(origin.status);
      stageLabel = featureStageLabel(stage);
      processKey = origin.processKey ?? rep?.processKey ?? null;
    }
  } else if (origin.kind === "delivery") {
    // Fan-in parent (issue #498): the delivery-graph RUN is the thread root; its heterogeneous
    // downstream PR convergences (across different repos/issues) nest under it. Unlike an epic's
    // slice rollup, a run's narrative is "where is the run" — so the frontier reflects the run's OWN
    // derived phase (`delivery_graph_runs.phase`), with member PRs shown as nested children. The
    // machine `stage` is derived from the run status (tempered to `converging` while a member PR is
    // still in flight); the human `stageLabel` prefers the run's stamped phase, else a status label.
    stage = deliveryOriginStage(origin.status, prs);
    stageLabel = origin.phase ?? deliveryStageLabel(stage);
    // Active-frontier instance: an in-flight member PR's process, else the run's own.
    const activePr = prs.find((p) => !TERMINAL_STATUSES.includes(p.status));
    processKey = activePr?.processKey ?? origin.processKey ?? rep?.processKey ?? null;
  } else {
    // Self-rooted PR (human/webhook): the PR IS the whole arc.
    stage = rep ? prStage(rep.status) : "converging";
    stageLabel = rep ? prStageLabel(stage, rep.round) : "Converging";
    processKey = rep?.processKey ?? null;
  }

  const active = !TERMINAL_STAGES.includes(stage);
  // Epic slices carry their parent epic's phase down to the PR-row detail (issue #304): prefer the
  // epic's own stamped `epic_phase`, falling back to the delivery-rollup `stageLabel` for a
  // grandfathered epic that never stamped one. Feature/self-rooted threads are not epics, so their
  // member PRs get no epic label.
  const epicPhaseLabel =
    origin.kind === "epic" ? (origin.epicPhase ?? stageLabel) : null;
  return {
    rootRequestKey: origin.key,
    kind: origin.kind,
    title: origin.kind === "pr" ? (rep?.title ?? null) : origin.title,
    // Only feature/epic threads root on a GitHub issue; a self-rooted PR and a delivery-graph run
    // (issue #498, keyed by `run_key`) have none.
    issueUrl: origin.kind === "feature" || origin.kind === "epic" ? origin.issueUrl : null,
    stage,
    stageLabel,
    epicPhaseLabel,
    processKey,
    prKeys,
    prCount: prKeys.length,
    active,
    prs,
  };
}

function isPreHandoff(status: string): boolean {
  return status === "running" || status === "escalated" || status === "awaiting_operator" ||
    status === "opened";
}

function featureStageLabel(stage: LineageStage): string {
  switch (stage) {
    case "implementing":
      return "Implementing";
    case "escalated":
      return "Escalated — awaiting answer";
    case "blocked":
      return "Blocked — awaiting operator";
    case "opened":
      return "PR opened";
    case "abandoned":
      return "Abandoned";
    default:
      return prStageLabel(stage, 0);
  }
}

/** Map a delivery-graph run's lifecycle status onto a frontier stage (issue #498). A `running` run
 * with a member PR still in flight reads as `converging` (the fan-in is landing PRs); otherwise it is
 * `implementing`. Terminal run statuses settle: `done` → `resolved` (the run completed), `failed` /
 * `abandoned` → `abandoned`. `awaiting-approval` (reserved, no longer produced) parks at `planning`. */
function deliveryOriginStage(status: string, prs: readonly LineagePr[]): LineageStage {
  switch (status) {
    case "awaiting-approval":
      return "planning";
    case "running":
      return prs.some((p) => !TERMINAL_STATUSES.includes(p.status)) ? "converging" : "implementing";
    case "done":
      return "resolved";
    case "failed":
    case "abandoned":
      return "abandoned";
    default:
      return "implementing";
  }
}

/** The fallback frontier label for a delivery thread when the run has not stamped a `phase` yet. */
function deliveryStageLabel(stage: LineageStage): string {
  switch (stage) {
    case "planning":
      return "Awaiting approval";
    case "converging":
      return "Converging";
    case "resolved":
      return "Completed";
    case "abandoned":
      return "Failed";
    default:
      return "Running";
  }
}

// ── gateway glue ───────────────────────────────────────────────────────────────────────────────

/** The subset of `pull_requests` the lineage projection reads. */
interface PrRow {
  pr_key: string;
  title: string | null;
  url: string;
  status: string;
  current_round: number;
  process_key: string | null;
  outcome: string | null;
  root_request_key: string | null;
  // Epic-phase projection this module maintains (issue #304, migration 043): the parent epic's phase
  // label for an epic slice PR, NULL otherwise. Read here only to keep the write idempotent.
  epic_phase_label: string | null;
  // The ADR-0065 derived tracking edge (`pull_requests__tracking.derived_status`). Present ONLY on
  // rows read through the derived VIEW (`prRowsRead`); undefined on base-table reads/writes. The
  // frontier stage is derived from THIS, not the base transient `status`, so an out-of-band-
  // terminated slice reads `abandoned` rather than a stale `converging`.
  derived_status?: string;
}

const prRows = (data: DataLayer) => data.table<PrRow>("pull_requests", "pr_key");
/** Read-only accessor over the PR derived tracking VIEW (`pull_requests__tracking`). The lineage
 * frontier classifies on the reconciler-derived edge, so `collectThreads` reads through this and
 * `toLineagePr` folds `derived_status` onto `LineagePr.status`. Writes stay on `prRows`. */
const prRowsRead = (data: DataLayer) =>
  derivedTrackingTable<PrRow & { derived_status: string }>(data, "pull_requests", "pr_key");

/** The `lineage_thread_view` VIEW row (migration 064) — the read shape the Lineage page binds. The
 *  view PASSES THROUGH the procedural frontier columns from `lineage_threads` and DERIVES the
 *  view-expressible identity columns (`kind`, `issue_url`, and an epic/feature thread's `title`) from
 *  the `plans`/`feature_runs` origin joins. */
export interface LineageThreadRow {
  root_request_key: string;
  kind: string;
  title: string | null;
  issue_url: string | null;
  stage: string;
  stage_label: string | null;
  process_key: string | null;
  pr_keys: string | null;
  pr_count: number;
  active: number;
  created_at: string;
  updated_at: string;
}

/** The denormalised BASE `lineage_threads` row `pollLineage` writes. The `kind` / `issue_url` columns
 *  were RETIRED (epic #412): the `lineage_thread_view` VIEW (064) DERIVES both from the
 *  `plans`/`feature_runs` origin joins, so the poller no longer denormalises them — this write shape
 *  is `LineageThreadRow` minus those two view-derived columns. `title` stays: it is a procedural
 *  representative-PR pick for a self-rooted PR thread (the view falls back to `lt.title` for `kind`
 *  = 'pr'). */
interface LineageThreadWriteRow {
  root_request_key: string;
  title: string | null;
  stage: string;
  stage_label: string | null;
  process_key: string | null;
  pr_keys: string | null;
  pr_count: number;
  active: number;
  created_at: string;
  updated_at: string;
}

const lineageThreads = (data: DataLayer) =>
  data.table<LineageThreadWriteRow>("lineage_threads", "root_request_key");

/** Read-only handle on the `lineage_thread_view` VIEW (migration 064) the Lineage page now binds.
 *  Same shape as `LineageThreadRow`: the view PASSES THROUGH the procedural frontier columns from
 *  `lineage_threads` (`stage`/`stage_label`/`process_key`/`pr_keys`/`pr_count`/`active`/timestamps)
 *  and DERIVES the view-expressible identity columns (`kind`, `issue_url`, and an epic/feature
 *  thread's `title`) from the `plans`/`feature_runs` origin joins — the single source of truth,
 *  eliminating those columns' drift surface (epic #412). A self-rooted PR's `title` falls back to
 *  the poller-written value, since it is a procedural representative-PR pick. */
const lineageThreadView = (data: DataLayer) =>
  data.table<LineageThreadRow>("lineage_thread_view", "root_request_key");

/** All lineage threads off the same `lineage_thread_view` VIEW the Lineage page binds, in this
 *  module's own active-frontier-first, then-by-key stable order (matching {@link listLineage}) —
 *  NOT the page datasource's `orderBy: updated_at desc` + tab-specific `active` filter, which the
 *  page applies on top of this table. Additive: this reads the derived view rather than recomputing
 *  via {@link collectThreads}, so it reflects the identity columns' single source of truth (origin
 *  joins) while the frontier columns come through from the still-poller-written `lineage_threads`. */
export async function listLineageView(data: DataLayer): Promise<LineageThreadRow[]> {
  const rows = await lineageThreadView(data).all();
  return rows.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      a.root_request_key.localeCompare(b.root_request_key),
  );
}

function toLineagePr(row: PrRow): LineagePr {
  return {
    prKey: row.pr_key,
    title: row.title,
    url: row.url,
    // Classify the frontier on the ADR-0065 derived edge when the row came through the tracking VIEW
    // (`prRowsRead`); fall back to the base transient for any base-table row.
    status: row.derived_status ?? row.status,
    round: row.current_round,
    processKey: row.process_key,
    outcome: row.outcome,
  };
}

/** Assemble the origin + PR set for every root from the live gateway rows, then derive each thread.
 * Reused by both `getLineage` (single root, on demand) and `pollLineage` (all roots, projected). */
async function collectThreads(
  data: DataLayer,
): Promise<{ threads: Map<string, LineageThread>; allPrs: PrRow[] }> {
  const allPrs = await prRowsRead(data).all();
  const prByKey = new Map<string, PrRow>();
  for (const pr of allPrs) prByKey.set(pr.pr_key, pr);

  // Group PRs by their threaded root; a NULL root defers to self-rooting below.
  const prsByRoot = new Map<string, PrRow[]>();
  for (const pr of allPrs) {
    if (!pr.root_request_key) continue;
    const bucket = prsByRoot.get(pr.root_request_key) ?? [];
    bucket.push(pr);
    prsByRoot.set(pr.root_request_key, bucket);
  }

  const claimed = new Set<string>(); // pr_keys already attached to a feature/epic root
  const threads = new Map<string, LineageThread>();

  const featureRows = await featureRuns(data).all();
  for (const run of featureRows) {
    const prs = collectRootPrs(run.feature_key, run.pr_key, prsByRoot, prByKey, claimed);
    threads.set(
      run.feature_key,
      deriveLineage(featureOrigin(run), prs.map(toLineagePr)),
    );
  }

  const planRows = await plans(data).all();
  // Prefetch every plan_task once and group by plan_key rather than issuing one query per plan: this
  // runs on the poller path AND the GET /lineage derivation, so an N+1 over plans would scale poorly
  // (mirrors the single-prefetch convention in pollDelivery/pollFeatureDelivery in app/service.ts).
  const tasksByPlan = new Map<string, PlanTask[]>();
  for (const task of await planTasks(data).all()) {
    const bucket = tasksByPlan.get(task.plan_key) ?? [];
    bucket.push(task);
    tasksByPlan.set(task.plan_key, bucket);
  }
  for (const plan of planRows) {
    const taskPrKeys = (tasksByPlan.get(plan.plan_key) ?? [])
      .map((t) => t.pr_key)
      .filter((k): k is string => !!k);
    const prs = collectEpicPrs(plan.plan_key, taskPrKeys, prsByRoot, prByKey, claimed);
    threads.set(plan.plan_key, deriveLineage(epicOrigin(plan), prs.map(toLineagePr)));
  }

  // Delivery-graph runs (issue #498): each run is a fan-in parent thread keyed on its `run_key`,
  // attaching the downstream PRs threaded to it (`pull_requests.root_request_key = run_key`). Mirrors
  // the feature/epic loops — a run with no PR landed yet still projects a thread (its derived phase).
  const deliveryRows = await deliveryGraphRuns(data).all();
  for (const run of deliveryRows) {
    const prs = collectRootPrs(run.run_key, null, prsByRoot, prByKey, claimed);
    threads.set(run.run_key, deriveLineage(deliveryGraphOrigin(run), prs.map(toLineagePr)));
  }

  // Any PR not claimed by a feature/epic root is its own root: a human/webhook PR, a legacy row
  // predating migration 037's backfill, or a `root_request_key` whose origin row no longer survives.
  // Key each such thread by the root STORED on the PR row (`root_request_key`, falling back to
  // `pr_key` only for a legacy NULL) so the thread key equals `pull_requests.root_request_key` and
  // the Lineage page's `lineage_threads.root_request_key → pull_requests.root_request_key`
  // drill-down join resolves — keying on `pr_key` when the row carries a non-null orphaned root would
  // render an empty PR list. Group PRs that share one orphaned root into a single thread (they came
  // from the same request) rather than clobbering each other in the map.
  const selfRooted = new Map<string, PrRow[]>();
  for (const pr of allPrs) {
    if (claimed.has(pr.pr_key)) continue;
    const rootKey = pr.root_request_key ?? pr.pr_key;
    const bucket = selfRooted.get(rootKey) ?? [];
    bucket.push(pr);
    selfRooted.set(rootKey, bucket);
  }
  for (const [rootKey, prs] of selfRooted) {
    threads.set(rootKey, deriveLineage({ kind: "pr", key: rootKey }, prs.map(toLineagePr)));
  }

  return { threads, allPrs };
}

/** Union the PRs a feature root owns: those threaded to it + its own denormalised `pr_key`. */
function collectRootPrs(
  root: string,
  ownPrKey: string | null,
  prsByRoot: Map<string, PrRow[]>,
  prByKey: Map<string, PrRow>,
  claimed: Set<string>,
): PrRow[] {
  const out = new Map<string, PrRow>();
  for (const pr of prsByRoot.get(root) ?? []) out.set(pr.pr_key, pr);
  if (ownPrKey) {
    const row = prByKey.get(ownPrKey);
    if (row) out.set(row.pr_key, row);
  }
  for (const key of out.keys()) claimed.add(key);
  return [...out.values()];
}

/** Union the slice PRs an epic root owns: those threaded to it + every `plan_tasks.pr_key`. */
function collectEpicPrs(
  root: string,
  taskPrKeys: readonly string[],
  prsByRoot: Map<string, PrRow[]>,
  prByKey: Map<string, PrRow>,
  claimed: Set<string>,
): PrRow[] {
  const out = new Map<string, PrRow>();
  for (const pr of prsByRoot.get(root) ?? []) out.set(pr.pr_key, pr);
  for (const key of taskPrKeys) {
    const row = prByKey.get(key);
    if (row) out.set(row.pr_key, row);
  }
  for (const key of out.keys()) claimed.add(key);
  return [...out.values()];
}

function featureOrigin(run: FeatureRun): LineageOrigin {
  return {
    kind: "feature",
    key: run.feature_key,
    title: run.title,
    issueUrl: run.issue_url,
    status: run.status,
    processKey: run.process_key,
  };
}

function epicOrigin(plan: Plan): LineageOrigin {
  return {
    kind: "epic",
    key: plan.plan_key,
    title: plan.title,
    issueUrl: plan.issue_url,
    status: plan.status,
    processKey: plan.process_key,
    epicPhase: plan.epic_phase,
  };
}

function deliveryGraphOrigin(run: DeliveryGraphRun): LineageOrigin {
  return {
    kind: "delivery",
    key: run.run_key,
    title: run.title,
    status: run.status,
    phase: run.phase,
    processKey: run.process_key,
  };
}

/** On-demand: the stitched thread for one origin issue (or self-rooted PR), computed from the live
 * rows. Returns null when the root is unknown. */
export async function getLineage(
  data: DataLayer,
  rootRequestKey: string,
): Promise<LineageThread | null> {
  const { threads } = await collectThreads(data);
  return threads.get(rootRequestKey) ?? null;
}

/** All stitched threads, active frontier first, then by `rootRequestKey` for a stable,
 * deterministic order (the projection has no per-thread timestamp to sort on, and equal-`active`
 * ties would otherwise be nondeterministic across passes). */
export async function listLineage(data: DataLayer): Promise<LineageThread[]> {
  const { threads } = await collectThreads(data);
  return [...threads.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.rootRequestKey.localeCompare(b.rootRequestKey),
  );
}

/** Poller pass: recompute every thread and denormalise it onto `lineage_threads` so the
 * schema-driven pages can read the single-narrative view as flat rows. Idempotent — writes only
 * when the projection actually changes. Best-effort; per-root failures are isolated. */
export async function pollLineage(data: DataLayer): Promise<void> {
  let threads: Map<string, LineageThread>;
  let allPrs: PrRow[];
  try {
    ({ threads, allPrs } = await collectThreads(data));
  } catch (err) {
    console.error(`[poller] lineage collect: ${err}`);
    return;
  }
  const table = lineageThreads(data);
  for (const thread of threads.values()) {
    try {
      const prKeysJson = JSON.stringify(thread.prKeys);
      const active = thread.active ? 1 : 0;
      const existing = await table.get(thread.rootRequestKey);
      if (
        existing &&
        existing.title === thread.title &&
        existing.stage === thread.stage &&
        existing.stage_label === thread.stageLabel &&
        existing.process_key === thread.processKey &&
        existing.pr_keys === prKeysJson &&
        existing.pr_count === thread.prCount &&
        existing.active === active
      ) {
        continue; // steady state — no write
      }
      const ts = now();
      if (existing) {
        await table.update(thread.rootRequestKey, {
          title: thread.title,
          stage: thread.stage,
          stage_label: thread.stageLabel,
          process_key: thread.processKey,
          pr_keys: prKeysJson,
          pr_count: thread.prCount,
          active,
          updated_at: ts,
        });
      } else {
        await table.insert({
          root_request_key: thread.rootRequestKey,
          title: thread.title,
          stage: thread.stage,
          stage_label: thread.stageLabel,
          process_key: thread.processKey,
          pr_keys: prKeysJson,
          pr_count: thread.prCount,
          active,
          created_at: ts,
          updated_at: ts,
        });
      }
    } catch (err) {
      console.error(`[poller] lineage ${thread.rootRequestKey}: ${err}`);
    }
  }
  await projectEpicPhaseLabels(data, threads, allPrs);
}

/** Denormalise each epic thread's phase label down onto its member PRs' `pull_requests.epic_phase_label`
 * (issue #304), so the Convergence PR-row detail can show an escalated slice its parent epic's phase
 * without a cross-join to `plans` / `lineage_threads`. Every PR belongs to exactly one thread, so a
 * PR whose thread is a feature/self-root is cleared to NULL — no stale epic label survives if a PR is
 * re-rooted. Idempotent: writes only the rows whose label actually changed. Mirrors the write-time
 * projection convention (`delivery_label`, `epic_phase`). Best-effort; failures are isolated. */
async function projectEpicPhaseLabels(
  data: DataLayer,
  threads: Map<string, LineageThread>,
  allPrs: PrRow[],
): Promise<void> {
  // Desired label per member PR: an epic thread stamps its `epicPhaseLabel`, every other thread NULL.
  const desired = new Map<string, string | null>();
  for (const thread of threads.values()) {
    for (const key of thread.prKeys) desired.set(key, thread.epicPhaseLabel);
  }
  // Reuse the PR rows `collectThreads` already read this pass rather than re-scanning the whole
  // `pull_requests` table — the projection only writes the rows whose label actually changed.
  const table = prRows(data);
  for (const pr of allPrs) {
    const want = desired.get(pr.pr_key) ?? null;
    if ((pr.epic_phase_label ?? null) === want) continue; // steady state — no write
    try {
      await table.update(pr.pr_key, { epic_phase_label: want });
    } catch (err) {
      console.error(`[poller] lineage epic-phase ${pr.pr_key}: ${err}`);
    }
  }
}
