// Single-run lookup (issue #1054): `GET /run?key=<key>` answers "what is THIS run doing?" for ANY stage
// — a feature before its PR opens, an epic fanning out, a PR converging/merging, a delivery-graph run,
// and every one of them after it went terminal (until an operator acknowledges it, and beyond: the row
// persists). `/status` only lists in-flight rows, so a caller driving nwf (d8ctl) had to filter the
// whole list client-side — and a feature run never appeared there before its PR existed.
//
// Derivation over duplication: the PR and delivery projections are the SAME `projectPrRows` /
// `projectDeliveryRows` `/status` uses (app/service.ts), fed one tracked row at any stage instead of
// the in-flight set; the feature stage is the canonical `deriveStage` (app/stage.ts); open escalations
// come from the ONE `user_tasks` read model. Nothing here re-derives a status rule.

import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { epicIsAcknowledgeable } from "./delivery.ts";
import { DELIVERY_GRAPH_TERMINAL_STATUSES, deliveryGraphRunsTracking } from "./deliveryGraphRun.ts";
import { blockedOnOf } from "./effectiveSettings.ts";
import { deriveFeatureDelivery, featureRunsTracking } from "./feature.ts";
import { isFeatureDismissableTerminal } from "./featureReadModel.ts";
import { PLAN_TERMINAL_STATUSES, plansTracking, planTasks } from "./plan.ts";
import { parsePr } from "./prParse.ts";
import { PR_TERMINAL_STATUSES } from "./pullRequestReadModel.ts";
import { effectiveTerminalStatus, RUN_TERMINAL_STATUS, readRunCancellation } from "./runTerminal.ts";
import {
  type ActiveDelivery,
  type ActivePr,
  derivePlanDelivery,
  ORPHANED_PR_STATUS,
  projectDeliveryRows,
  projectPrRows,
  prsTracking,
  type StatusIncident,
  type TrackedPullRequest,
} from "./service.ts";
import { deriveStage } from "./stage.ts";
import { type OpenEscalation, toOpenEscalation, type UserTaskRow, userTasks } from "./userTasks.ts";

export type RunKind = "feature" | "epic" | "pr" | "delivery";

/** The effective settings a run was submitted with. A field the run's kind does not carry is null. */
export interface RunSettings {
  converge: boolean | null;
  autoMerge: boolean | null;
  humanApproval: boolean | null;
  /** The feature's readiness gate (the desugared `blockedOn`/`readiness` probes), read best-effort
   *  from the run's root-scope `readinessProbes` variable; null when none/unreadable. */
  blockedOn: Array<string | { waitGate: string | null; label: string | null }> | null;
  /** The PR loop's round budget (`maxRounds` root variable), best-effort; null when unset/unreadable. */
  maxRounds: number | null;
  autoResolveEscalations: boolean;
  hasCustomInstructions: boolean;
}

export interface RunView {
  key: string;
  kind: RunKind;
  title: string | null;
  /** The run's workflow status (the effective, terminal-folded status; `incident` while parked on one). */
  status: string;
  /** True once the run has reached its kind's terminal outcome (feature: the dismissable-terminal set,
   *  excluding a mid-handoff `opened`; PR: `PR_TERMINAL_STATUSES` (incl. closed/failed); epic: acknowledgeable (done AND slices resolved); delivery: its terminal
   *  sets). Waiters MUST stop on this flag, never on `status` strings or stage order — a PR can move
   *  `waiting_merge` → `waiting_review`/`converging` during a merge-to-convergence handoff. */
  terminal: boolean;
  /** The pipeline stage/phase: a feature's derived pipeline stage, an epic's phase, a PR's status, a
   *  delivery run's phase. */
  stage: string | null;
  settings: RunSettings;
  processInstanceKey: string | null;
  /** Every engine instance this run spans (its own, then its children's). */
  processInstanceKeys: string[];
  activeWorker: string | null;
  leaseUntil: string | null;
  prUrl: string | null;
  openEscalation: OpenEscalation | null;
  incident: StatusIncident | null;
  acknowledgedAt: string | null;
  createdAt: string | null;
  updatedAt: string;
  /** How many child runs the run is PLANNED to have (epic: every planned slice, including slices whose
   *  PR does not exist yet and so are absent from `children`); null when the run has no plan (feature,
   *  PR, delivery). Whole-run predicates over `children` MUST check completeness against this. */
  plannedChildren: number | null;
  /** Child runs (feature → its convergence loop PR; epic → its slice PRs). Children carry no children. */
  children: RunView[];
}

type Engine = Pick<EngineClient, "searchVariables">;

/** Best-effort root-scope variable read (JSON-decoded); undefined when absent or unreadable. */
async function readRootVar(engine: Engine | undefined, processKey: string | null, name: string): Promise<unknown> {
  if (!engine || !processKey) return undefined;
  try {
    const rows = await engine.searchVariables({ processInstanceKey: processKey, scopeKey: processKey, name });
    const row = rows.find((r) => r.name === name && String(r.scopeKey) === processKey);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return undefined;
  }
}

/** The run's open user tasks, scoped to its OWN subject type: a feature and an epic may share an issue
 *  key, so an unscoped `subject_key` read would leak the sibling's completable task into this run. */
async function subjectTasks(data: DataLayer, subjectType: "feature" | "plan", subjectKey: string): Promise<UserTaskRow[]> {
  return await userTasks(data).find({ subject_type: subjectType, subject_key: subjectKey }).catch(() => []);
}

function newestEscalation(rows: readonly UserTaskRow[]): OpenEscalation | null {
  const newest = [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))[0];
  return newest ? toOpenEscalation(newest) : null;
}

/** The run's effective status: the tracking VIEW's terminal-folded `derived_status`, with an
 *  out-of-band-terminate edge promoted to `cancelled` by a COMMITTED operator cancel — the one rule
 *  (`effectiveTerminalStatus`) the read models share, so a lookup never reports an operator cancel as
 *  `abandoned`. */
async function effectiveStatus(data: DataLayer, derivedStatus: string, processKey: string | null | undefined): Promise<string> {
  if (derivedStatus !== RUN_TERMINAL_STATUS.outOfBandTerminate || !processKey) return derivedStatus;
  const cx = await readRunCancellation(data, processKey).catch(() => undefined);
  return effectiveTerminalStatus(derivedStatus, cx?.cancelled_at, cx?.committed === 1);
}

function emptySettings(): RunSettings {
  return {
    converge: null,
    autoMerge: null,
    humanApproval: null,
    blockedOn: null,
    maxRounds: null,
    autoResolveEscalations: false,
    hasCustomInstructions: false,
  };
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The human-approval setting the PR run was SUBMITTED with — never the merge-gate outcome. Both the
 *  loop's `humanApproval` variable and `merge_human_approval` are the OUTSTANDING-approval state (an
 *  approve and `startMerge` clear them), so only the write-once `human_approval_submitted` column
 *  (148, stamped by `submitPr`) answers it. Null for a row written before that column existed. */
function prHumanApproval(row: TrackedPullRequest): boolean | null {
  const v = row.human_approval_submitted;
  return v === null || v === undefined ? null : v === 1;
}

/** Project PR rows into run views with ONE `projectPrRows` call (one user-task read for the whole
 *  set) and the per-run `maxRounds` engine reads issued concurrently, so an epic's lookup does not
 *  pay N sequential projections. */
async function prViews(
  data: DataLayer,
  engine: Engine | undefined,
  rows: readonly TrackedPullRequest[],
): Promise<RunView[]> {
  if (rows.length === 0) return [];
  const projected: ActivePr[] = await projectPrRows(data, engine, [...rows]);
  const byKey = new Map(projected.map((p) => [p.prKey, p]));
  return Promise.all(
    rows.map(async (row) => {
      const p = byKey.get(row.pr_key);
      if (!p) throw new Error(`projectPrRows dropped ${row.pr_key}`);
      // `projectPrRows` reports the in-flight workflow status; past the terminal edge the folded
      // `derived_status` (merged/converged/abandoned) is the truth for a lookup at any stage.
      // Past the terminal edge the folded status is the truth: compute it FIRST, and apply the
      // `/status` incident/orphaned overlay only to a non-terminal row — a cancelled run with a stale
      // `incident_key` must never read `incident`. `orphaned` survives only for an `abandoned` run
      // without a committed operator cancel.
      const terminal = PR_TERMINAL_STATUSES.includes(row.derived_status)
        ? await terminalPrStatus(data, row, p.status)
        : p.status;
      return {
        key: p.prKey,
        kind: "pr" as const,
        title: p.title,
        status: terminal,
        terminal: PR_TERMINAL_STATUSES.includes(row.derived_status),
        stage: terminal,
        settings: {
          ...emptySettings(),
          converge: true,
          autoMerge: p.merge.requested,
          humanApproval: prHumanApproval(row),
          // The persisted budget (154, issue #1088) — survives handoffs, and is readable while the merge
          // process owns the run; a pre-154 (NULL) row falls back to the loop's root variable.
          maxRounds: asNumber(row.max_rounds) ?? asNumber(await readRootVar(engine, p.processKey, "maxRounds")),
          autoResolveEscalations: p.autoResolveEscalations,
          hasCustomInstructions: p.hasCustomInstructions,
        },
        processInstanceKey: p.processKey,
        processInstanceKeys: p.processKey ? [p.processKey] : [],
        activeWorker: p.activeWorker,
        leaseUntil: p.leaseUntil,
        prUrl: p.url,
        openEscalation: p.openEscalation,
        incident: PR_TERMINAL_STATUSES.includes(row.derived_status) ? null : p.incident,
        acknowledgedAt: row.acknowledged_at ?? null,
        createdAt: row.created_at ?? null,
        updatedAt: p.updatedAt,
        plannedChildren: null,
        children: [],
      };
    }),
  );
}

async function childPrViews(data: DataLayer, engine: Engine | undefined, prKeys: readonly string[]): Promise<RunView[]> {
  const table = prsTracking(data);
  const rows = await Promise.all([...new Set(prKeys)].map((k) => table.get(k)));
  return prViews(data, engine, rows.filter((r): r is TrackedPullRequest => r != null));
}

async function terminalPrStatus(data: DataLayer, row: TrackedPullRequest, overlaid: string): Promise<string> {
  const eff = await effectiveStatus(data, row.derived_status, row.process_key);
  return eff === RUN_TERMINAL_STATUS.outOfBandTerminate && overlaid === ORPHANED_PR_STATUS ? ORPHANED_PR_STATUS : eff;
}

type FeatureRow = NonNullable<Awaited<ReturnType<ReturnType<typeof featureRunsTracking>["get"]>>>;

/** The ONE rolled-up feature terminal, shared by key resolution and the returned view. The feature
 *  row's `derived_status` is synced from its PR only once per poll cycle, and reads `opened`
 *  mid-handoff: while the feature delegates to its child PR, the (already cancel/terminal-folded)
 *  child status is the truth, mapped through the ONE `deriveFeatureDelivery` rollup. */
async function featureRollup(data: DataLayer, engine: Engine | undefined, feature: FeatureRow) {
  const children = feature.pr_key ? await childPrViews(data, engine, [feature.pr_key]) : [];
  const child: RunView | undefined = children[0];
  const delegating =
    child !== undefined &&
    (feature.derived_status === "converging" || (feature.derived_status === "opened" && feature.converge === 1 && feature.pr_key != null));
  let rolledStatus: string | null = null;
  let terminalBasis = feature.derived_status;
  if (delegating && child) {
    if (child.terminal && (child.status === "cancelled" || child.status === ORPHANED_PR_STATUS)) {
      rolledStatus = child.status;
      terminalBasis = "abandoned";
    } else {
      terminalBasis = deriveFeatureDelivery(child.status).status;
      // The child's live `incident` overlay is surfaced on the feature's status, but the stage /
      // terminal derivation stays on the underlying rollup basis.
      rolledStatus = !child.terminal && child.incident ? child.status : terminalBasis;
    }
  }
  const terminal = isFeatureDismissableTerminal({ derived_status: terminalBasis, converge: feature.converge, pr_key: feature.pr_key });
  return { children, child, delegating, terminalBasis, rolledStatus, terminal };
}

function planLive(p: { derived_status: string }): boolean {
  return !PLAN_TERMINAL_STATUSES.some((s) => s === p.derived_status);
}

type PlanRow = NonNullable<Awaited<ReturnType<ReturnType<typeof plansTracking>["get"]>>>;

/** The ONE delivery-aware epic terminal predicate, shared by key resolution and the returned view: a
 *  `failed`/`abandoned` epic is terminal outright; a `done` epic only once every slice PR is resolved
 *  (merged or closed) — a `done` epic with converging or missing slices is still live. */
async function epicTerminal(data: DataLayer, plan: PlanRow): Promise<boolean> {
  if (planLive(plan)) return false;
  if (plan.derived_status !== "done") return true;
  return epicIsAcknowledgeable(plan.derived_status, await derivePlanDelivery(data, plan));
}

/** Pick between a feature and an epic sharing one key: the LIVE (non-terminal) run wins; only when
 *  both or neither are live does the newest launch (engine process key, else `created_at`) decides. Never `updated_at` — acknowledge and
 *  phase polling bump it, so a dismissed finished run could shadow a live one and the choice flip. */
async function preferPlan(data: DataLayer, engine: Engine | undefined, feature: FeatureRow, plan: PlanRow): Promise<boolean> {
  const fl = !(await featureRollup(data, engine, feature)).terminal;
  const pl = !(await epicTerminal(data, plan));
  if (fl !== pl) return pl;
  // A restart re-seeds a fresh engine instance but keeps the row's original `created_at`, so the
  // engine's monotonic process-instance key is the per-launch generation (advances on restart, never
  // on polling/acknowledgment). Fall back to `created_at` only when either key is absent/non-numeric.
  const fk = launchGeneration(feature.process_key);
  const pk = launchGeneration(plan.process_key);
  if (fk !== null && pk !== null && fk !== pk) return pk > fk;
  return (plan.created_at ?? "") > (feature.created_at ?? "");
}

function launchGeneration(processKey: string | null | undefined): bigint | null {
  return typeof processKey === "string" && /^[0-9]+$/.test(processKey) ? BigInt(processKey) : null;
}

function withChildKeys(view: RunView): RunView {
  const keys = [...view.processInstanceKeys];
  for (const c of view.children) for (const k of c.processInstanceKeys) if (!keys.includes(k)) keys.push(k);
  return { ...view, processInstanceKeys: keys };
}

/** Look one run up by key — `owner/repo#N` (feature, epic, or PR) or a delivery-graph runKey — at any
 *  stage. Resolution order for an `owner/repo#N` key: the CURRENT issue run (feature or epic), then
 *  PR (an issue and a PR never share a number in one repo). A feature and an epic for the same issue
 *  can coexist (admission checks separate tables): the live one wins, else the newest launch
 *  (see `preferPlan`). Null only when nwf has never tracked the key. */
export async function lookupRun(data: DataLayer, engine: Engine | undefined, key: string): Promise<RunView | null> {
  const feature = await featureRunsTracking(data).get(key);
  const plan = await plansTracking(data).get(key);
  if (feature && !(plan && (await preferPlan(data, engine, feature, plan)))) {
    const tasks = await subjectTasks(data, "feature", key);
    const openEsc = newestEscalation(tasks);
    const status = await effectiveStatus(data, feature.derived_status, feature.process_key);
    const probes = await readRootVar(engine, feature.process_key, "readinessProbes");
    const { children, child, delegating, terminalBasis, rolledStatus, terminal } = await featureRollup(data, engine, feature);
    const topStatus = rolledStatus ?? status;
    // Stage derives from the SAME rolled-up basis as `terminal` (a lagging feature row must not read
    // `Converging` beside a merged child), keeping the tracking VIEW's raw `abandoned` (∈ Done) rather
    // than the presentational `cancelled` promotion, so an operator cancel lands on the `Done` stage.
    const derived = deriveStage({
      status: terminalBasis,
      pr_key: feature.pr_key,
      converge: feature.converge,
      auto_merge: feature.auto_merge,
      hasOpenBlockedTask: tasks.some((t) => t.element_id === "feature-blocked"),
      hasOpenEscalationTask: tasks.some((t) => t.element_id === "feature-escalation"),
    });
    return withChildKeys({
      key,
      kind: "feature",
      title: feature.title ?? null,
      status: topStatus,
      terminal,
      stage: derived.stage,
      settings: {
        ...emptySettings(),
        converge: feature.converge === 1,
        autoMerge: feature.auto_merge === 1,
        humanApproval: feature.human_approval === 1,
        // Redacted display strings only (never the raw probe: a target can carry credentials).
        blockedOn: blockedOnOf(probes),
        maxRounds: child?.settings.maxRounds ?? null,
        autoResolveEscalations: feature.auto_resolve_escalations === 1,
        hasCustomInstructions: typeof feature.custom_instructions === "string" && feature.custom_instructions !== "",
      },
      processInstanceKey: feature.process_key ?? null,
      processInstanceKeys: feature.process_key ? [feature.process_key] : [],
      // While implementing, the lease lives on the agent job, not a tracked row; once the PR is in
      // its loop, the loop's worker/lease is the active one.
      activeWorker: child?.activeWorker ?? null,
      leaseUntil: child?.leaseUntil ?? null,
      prUrl: child?.prUrl ?? (parsePr(feature.pr_key)?.url ?? null),
      openEscalation: openEsc ?? child?.openEscalation ?? null,
      // A delegating feature's blocking incident lives on its child PR's loop: propagate it (the
      // child view already nulls it once terminal).
      incident: delegating ? (child?.incident ?? null) : null,
      acknowledgedAt: feature.acknowledged_at ?? null,
      createdAt: feature.created_at,
      updatedAt: feature.updated_at,
      plannedChildren: null,
      children,
    });
  }

  if (plan) {
    const slices = await planTasks(data).find({ plan_key: key });
    const prKeys = slices.map((t) => t.pr_key).filter((k): k is string => typeof k === "string" && k !== "");
    const children = await childPrViews(data, engine, prKeys);
    const planStatus = await effectiveStatus(data, plan.derived_status, plan.process_key);
    // The inter-epic readiness wait (`wait_gate`, #292) is the epic's analogue of a feature's
    // `blockedOn` gate: surface it while the epic is live and parked on it.
    const gated = planLive(plan) && (plan.wait_gate === "waiting" || plan.wait_gate === "escalated");
    const gateLabel = plan.wait_gate_label ?? plan.wait_gate;
    return withChildKeys({
      key,
      kind: "epic",
      title: plan.title ?? null,
      status: planStatus,
      // Delivery-aware: a `done` epic whose slice PRs are still converging (or missing) is NOT
      // terminal — the ONE canonical acknowledgeable predicate over the read-time delivery signal.
      // A `failed`/`abandoned` epic is terminal outright — only `done` waits on delivery.
      terminal: await epicTerminal(data, plan),
      stage: gated ? gateLabel : (plan.epic_phase ?? planStatus),
      settings: {
        ...emptySettings(),
        converge: true,
        autoMerge: plan.auto_merge === 1,
        blockedOn: gated ? [{ waitGate: plan.wait_gate, label: gateLabel }] : null,
        autoResolveEscalations: plan.auto_resolve_escalations === 1,
      },
      processInstanceKey: plan.process_key ?? null,
      processInstanceKeys: plan.process_key ? [plan.process_key] : [],
      activeWorker: null,
      leaseUntil: null,
      prUrl: null,
      openEscalation: newestEscalation(await subjectTasks(data, "plan", key)),
      incident: null,
      acknowledgedAt: plan.acknowledged_at ?? null,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      plannedChildren: slices.length,
      children,
    });
  }

  const pr = await prsTracking(data).get(key);
  if (pr) return (await prViews(data, engine, [pr]))[0];

  const run = await deliveryGraphRunsTracking(data).get(key);
  if (run) {
    const [d]: ActiveDelivery[] = await projectDeliveryRows(data, [run]);
    const terminal = DELIVERY_GRAPH_TERMINAL_STATUSES.some((s) => s === run.derived_status);
    const status = d.incident && !terminal ? d.status : await effectiveStatus(data, run.derived_status, run.process_key);
    return {
      key,
      kind: "delivery",
      title: d.title,
      status,
      terminal,
      stage: d.phase ?? status,
      settings: { ...emptySettings(), autoResolveEscalations: d.autoResolveEscalations },
      processInstanceKey: d.processKey,
      processInstanceKeys: d.processKey ? [d.processKey] : [],
      activeWorker: null,
      leaseUntil: null,
      prUrl: null,
      openEscalation: d.openEscalation,
      incident: terminal ? null : d.incident,
      acknowledgedAt: run.acknowledged_at ?? null,
      createdAt: run.created_at,
      updatedAt: d.updatedAt,
      plannedChildren: null,
      children: [],
    };
  }
  return null;
}
