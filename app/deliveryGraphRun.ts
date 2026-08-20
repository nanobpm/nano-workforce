// app/deliveryGraphRun.ts — the `startDeliveryGraph` run AGGREGATE (ADR 0005 Decision 7, slice S5).
//
// The dispatch door (`operations/startDeliveryGraph.ts`) turns an agent-authored `DeliveryGraph` into
// a RUNNING engine-native process (via the S4 runner) — but because these graphs merge PRs and publish
// packages, dispatch is GATED on an approval of the rendered preview and must be idempotent. This
// module is the durable aggregate that makes both properties true and gives the cockpit a row to show
// WHERE a run is parked:
//
//   • the idempotency fence — a run is keyed by `run_key` (a caller `idempotencyKey`, else the graph's
//     content digest). A re-POST collapses onto the same row, so an in-flight run short-circuits
//     instead of double-launching (mirrors `plans`' `alreadyRunning`).
//   • the approval token — `digest` is the content-address a side-effecting graph must present as its
//     `approvalToken` to dispatch. Persisted so a second POST re-derives + re-checks it.
//   • the derived parked-node phase — `phase`/`phase_node_id` is the display-only "where is it parked"
//     projection `pollDeliveryGraphPhase` recomputes from engine truth (the running instance's open
//     user tasks), generalising the `epic_phase` derived-phase machinery to a DYNAMIC compiled process.
//
// The pure helpers here (`computeRunKey`, `isDeliveryGraphApproved`, `buildHumanLabels`,
// `deriveDeliveryPhase`) are engine/DB-free so they unit-test in isolation; the door and the poller
// supply the I/O.

import type { DataLayer, ProcessInstanceState } from "@nanobpm/urban";
import type { CompileDeliveryGraphResult } from "../nano-generated/api-io.d.ts";
import { isUniqueConstraintFence } from "./dbFence.ts";
import { DELIVERY_HUMAN_ELEMENT, isDeliveryHumanElement } from "./deliveryHuman.ts";

const now = () => new Date().toISOString();

/** One `startDeliveryGraph` run — the durable row. `side_effecting` is a SQLite boolean (0/1). */
export interface DeliveryGraphRun {
  run_key: string;
  process_key: string | null;
  process_definition_id: string | null;
  digest: string;
  status: DeliveryGraphRunStatus;
  side_effecting: number;
  node_count: number;
  human_node_count: number;
  side_effect_count: number;
  title: string | null;
  phase: string | null;
  phase_node_id: string | null;
  human_labels: string | null;
  created_at: string;
  updated_at: string;
}

/** The run lifecycle. `awaiting-approval` = a side-effecting graph parked at the approval gate (no
 * instance started); `running` = dispatched to the engine; `done`/`failed`/`abandoned` = terminal. */
export const DELIVERY_GRAPH_RUN_STATUSES = [
  "awaiting-approval",
  "running",
  "done",
  "failed",
  "abandoned",
] as const;
export type DeliveryGraphRunStatus = typeof DELIVERY_GRAPH_RUN_STATUSES[number];

/** The ACTIVE statuses — a run in one of these is still in flight and shows in the cockpit's active
 * grid (`pages/overview.page.json`'s "Active Delivery Graphs" filter). Note this is the DISPLAY set,
 * broader than the instanceTracking binding: only `running` is backed by a live engine instance
 * (non-null `process_key`), so ONLY `running` is instance-tracked (nano.app.json). A parked
 * `awaiting-approval` run has no instance (`process_key` NULL) — it is shown here but not reconciled
 * by the `process_key`-keyed reconciler. */
export const DELIVERY_GRAPH_ACTIVE_STATUSES: readonly DeliveryGraphRunStatus[] = [
  "awaiting-approval",
  "running",
];

/** The terminal statuses — a run in one of these is done and drops out of the active grid. Mirrors
 * `PLAN_TERMINAL_STATUSES`; the idempotency short-circuit only fires for a NON-terminal run. */
export const DELIVERY_GRAPH_TERMINAL_STATUSES: readonly DeliveryGraphRunStatus[] = [
  "done",
  "failed",
  "abandoned",
];

/** The display phases for a run's derived projection. `Parked on human node: <label>` is built at
 * derivation time from the parked user task's label, so it is not a member here. */
export const DELIVERY_PHASE = {
  AWAITING_APPROVAL: "Awaiting approval",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
} as const;

/** The `delivery_graph_runs` aggregate accessor — the durable run store keyed by `run_key`. */
export const deliveryGraphRuns = (data: DataLayer) =>
  data.table<DeliveryGraphRun>("delivery_graph_runs", "run_key");

/** Atomically claim a run for LAUNCH — the at-most-once dispatch fence. Returns `true` iff THIS caller
 * won the claim and must proceed to `runDeliveryGraph`; `false` iff a concurrent submit already claimed
 * it (the caller must short-circuit as `alreadyRunning` instead of double-launching). Two fences, one
 * per starting state, so dispatch is at-most-once from EITHER — the `run_key` PK guards a first launch
 * and a compare-and-swap on `status` guards a relaunch off a persisted row:
 *   • no row yet (`existing` null) → INSERT the claim, fenced by the `run_key` PRIMARY KEY: a racing
 *     loser hits `UNIQUE constraint failed` and returns `false`.
 *   • a persisted NON-running row (a parked `awaiting-approval` row now being approved, or a terminal
 *     row being re-run) → a single guarded UPDATE (`SET status='running' … WHERE status <> 'running'`).
 *     It is ONE statement, so the check-and-flip is atomic even across the delegate's `await` points:
 *     of two concurrent approved re-submits that both read the same parked row, exactly one flips it
 *     (`changed === 1`) and the other matches zero rows (`changed === 0`). This closes the double-launch
 *     hole the PK fence alone left open — an `update`-on-existing path has no unique collision to lose,
 *     so without this guard both racers would `update` then both launch. The winner writes the run's
 *     full metadata afterwards (safe: it is now the sole caller past the fence). */
export async function claimRunForLaunch(
  data: DataLayer,
  existing: boolean,
  claim: DeliveryGraphRun,
): Promise<boolean> {
  if (!existing) {
    try {
      await deliveryGraphRuns(data).insert(claim);
      return true;
    } catch (err) {
      if (!isUniqueConstraintFence(err)) throw err;
      return false;
    }
  }
  const res = await data
    .open()
    .exec(
      `UPDATE "delivery_graph_runs" SET "status" = ?, "updated_at" = ? WHERE "run_key" = ? AND "status" <> 'running'`,
      [claim.status, claim.updated_at, claim.run_key],
    );
  return res.changed === 1;
}

/** The idempotency key for a submitted graph: a caller-supplied `idempotencyKey` (trimmed) when
 * present and non-blank, else the graph's content `digest`. So two POSTs of the SAME graph (no
 * explicit key) collapse onto one run, and a caller can force a fresh run with an explicit key. */
export function computeRunKey(idempotencyKey: string | undefined | null, digest: string): string {
  const trimmed = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  return trimmed || digest;
}

/** The approval decision (Decision 7). A graph with NO side-effecting nodes (only `wait`/`human`)
 * needs no approval and dispatches straight away. A SIDE-EFFECTING graph dispatches only when the
 * caller presents `approvalToken == digest` — an approval OF the rendered preview, content-addressed
 * so it cannot be replayed against a different graph. */
export function isDeliveryGraphApproved(
  sideEffecting: boolean,
  approvalToken: string | undefined | null,
  digest: string,
): boolean {
  if (!sideEffecting) return true;
  return typeof approvalToken === "string" && approvalToken.trim() === digest;
}

/** The compiled human-task element id for a node's compiled BPMN element (`delivery-human-task__n3`) —
 * the exact id the S4 compiler inlines and the engine reports as a user task's `elementId`. */
export function humanTaskElementId(element: string): string {
  return `${DELIVERY_HUMAN_ELEMENT}__${element}`;
}

/** The first non-blank line of a multi-line instruction, clamped, for a compact parked-node label. */
function firstLine(text: string | undefined | null): string {
  if (typeof text !== "string") return "";
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** Map each human node's compiled user-task element id → a display label (its instruction's first
 * line, else its author node id), from the S1 compile result. Stamped on the run row at dispatch so
 * the poller renders the parked-node phase without recompiling the graph. */
export function buildHumanLabels(compiled: CompileDeliveryGraphResult): Record<string, string> {
  const elementByNodeId = new Map(compiled.resolved.nodes.map((n) => [n.id, n.element]));
  const labels: Record<string, string> = {};
  for (const stop of compiled.humanNodes) {
    const element = elementByNodeId.get(stop.nodeId);
    if (element === undefined) continue;
    labels[humanTaskElementId(element)] = firstLine(stop.prompt) || stop.nodeId;
  }
  return labels;
}

/** Parse a run row's stored `human_labels` JSON back into a map, tolerating a null/blank/corrupt
 * value (→ empty map) so a bad column can never crash the poller. */
export function parseHumanLabels(raw: string | null | undefined): Record<string, string> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The derived (status, phase, parked-node) projection for a RUNNING run, from engine truth. PURE —
 * the poller supplies the instance state + open user tasks, this maps them to the stored projection:
 *   • COMPLETED  → `done`   (instanceTracking does NOT reconcile COMPLETED — this poller owns it).
 *   • TERMINATED → `failed` (a safety net; the instanceTracking `onTerminated` edge also flips it).
 *   • ACTIVE parked on a human node → `running`, phase `Parked on human node: <label>`.
 *   • ACTIVE otherwise (watching a wait/agent node) → `running`, phase `Running`. */
export interface DeliveryPhaseProjection {
  status: DeliveryGraphRunStatus;
  phase: string;
  phase_node_id: string | null;
}

export function deriveDeliveryPhase(
  state: ProcessInstanceState | null | undefined,
  openUserTasks: readonly { elementId?: string }[],
  humanLabels: Record<string, string>,
): DeliveryPhaseProjection {
  if (state === "COMPLETED") return { status: "done", phase: DELIVERY_PHASE.COMPLETED, phase_node_id: null };
  if (state === "TERMINATED") return { status: "failed", phase: DELIVERY_PHASE.FAILED, phase_node_id: null };
  const parkedOn = openUserTasks
    .map((t) => t.elementId)
    .filter((id): id is string => typeof id === "string" && isDeliveryHumanElement(id))
    .sort()[0];
  if (parkedOn !== undefined) {
    const label = humanLabels[parkedOn] ?? parkedOn;
    return { status: "running", phase: `Parked on human node: ${label}`, phase_node_id: parkedOn };
  }
  return { status: "running", phase: DELIVERY_PHASE.RUNNING, phase_node_id: null };
}

/** Build the durable row for a run at a given lifecycle point — the SINGLE row-shape builder both the
 * approval-park and the dispatch write go through, so the two can't drift on which columns a run
 * carries. `createdAt` is preserved across an update (the door passes the existing row's value). */
export function buildDeliveryGraphRunRow(input: {
  runKey: string;
  digest: string;
  status: DeliveryGraphRunStatus;
  sideEffecting: boolean;
  nodeCount: number;
  humanNodeCount: number;
  sideEffectCount: number;
  title: string | null;
  phase: string;
  processKey?: string | null;
  processDefinitionId?: string | null;
  humanLabels?: Record<string, string>;
  createdAt?: string;
}): DeliveryGraphRun {
  const at = now();
  return {
    run_key: input.runKey,
    process_key: input.processKey ?? null,
    process_definition_id: input.processDefinitionId ?? null,
    digest: input.digest,
    status: input.status,
    side_effecting: input.sideEffecting ? 1 : 0,
    node_count: input.nodeCount,
    human_node_count: input.humanNodeCount,
    side_effect_count: input.sideEffectCount,
    title: input.title,
    phase: input.phase,
    phase_node_id: null,
    human_labels: input.humanLabels ? JSON.stringify(input.humanLabels) : null,
    created_at: input.createdAt ?? at,
    updated_at: at,
  };
}
