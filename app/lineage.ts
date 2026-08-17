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
import { type FeatureRun, featureRuns } from "./feature.ts";
import { type Plan, type PlanTask, plans, planTasks } from "./plan.ts";

const now = () => new Date().toISOString();

/** The three origin shapes a lineage arc can spring from. */
export type LineageKind = "feature" | "epic" | "pr";

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
    }
  | {
      // A human/webhook PR with no originating request: its own root.
      kind: "pr";
      key: string;
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
  } else {
    // Self-rooted PR (human/webhook): the PR IS the whole arc.
    stage = rep ? prStage(rep.status) : "converging";
    stageLabel = rep ? prStageLabel(stage, rep.round) : "Converging";
    processKey = rep?.processKey ?? null;
  }

  const active = !TERMINAL_STAGES.includes(stage);
  return {
    rootRequestKey: origin.key,
    kind: origin.kind,
    title: origin.kind === "pr" ? (rep?.title ?? null) : origin.title,
    issueUrl: origin.kind === "pr" ? null : origin.issueUrl,
    stage,
    stageLabel,
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
}

const prRows = (data: DataLayer) => data.table<PrRow>("pull_requests", "pr_key");

/** The denormalised read-table row `pollLineage` projects, one per root. */
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

const lineageThreads = (data: DataLayer) =>
  data.table<LineageThreadRow>("lineage_threads", "root_request_key");

function toLineagePr(row: PrRow): LineagePr {
  return {
    prKey: row.pr_key,
    title: row.title,
    url: row.url,
    status: row.status,
    round: row.current_round,
    processKey: row.process_key,
    outcome: row.outcome,
  };
}

/** Assemble the origin + PR set for every root from the live gateway rows, then derive each thread.
 * Reused by both `getLineage` (single root, on demand) and `pollLineage` (all roots, projected). */
async function collectThreads(data: DataLayer): Promise<Map<string, LineageThread>> {
  const allPrs = await prRows(data).all();
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

  return threads;
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
  };
}

/** On-demand: the stitched thread for one origin issue (or self-rooted PR), computed from the live
 * rows. Returns null when the root is unknown. */
export async function getLineage(
  data: DataLayer,
  rootRequestKey: string,
): Promise<LineageThread | null> {
  const threads = await collectThreads(data);
  return threads.get(rootRequestKey) ?? null;
}

/** All stitched threads, active frontier first, then by `rootRequestKey` for a stable,
 * deterministic order (the projection has no per-thread timestamp to sort on, and equal-`active`
 * ties would otherwise be nondeterministic across passes). */
export async function listLineage(data: DataLayer): Promise<LineageThread[]> {
  const threads = await collectThreads(data);
  return [...threads.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.rootRequestKey.localeCompare(b.rootRequestKey),
  );
}

/** Poller pass: recompute every thread and denormalise it onto `lineage_threads` so the
 * schema-driven pages can read the single-narrative view as flat rows. Idempotent — writes only
 * when the projection actually changes. Best-effort; per-root failures are isolated. */
export async function pollLineage(data: DataLayer): Promise<void> {
  let threads: Map<string, LineageThread>;
  try {
    threads = await collectThreads(data);
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
        existing.kind === thread.kind &&
        existing.title === thread.title &&
        existing.issue_url === thread.issueUrl &&
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
          kind: thread.kind,
          title: thread.title,
          issue_url: thread.issueUrl,
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
          kind: thread.kind,
          title: thread.title,
          issue_url: thread.issueUrl,
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
}
