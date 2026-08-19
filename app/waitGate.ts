// app/waitGate.ts — operator visibility for the inter-epic gate (issue #292, slice S4).
//
// S1 landed the durable inter-epic edge (`plan_deps`): one row per "dependent epic B waits on
// producer epic A's published {package, capabilityRef}". S3 lowers each dependent behind a LEADING
// `capability` readiness PREFLIGHT (resources/processes/plan-fanout.bpmn): the dependent fans out NO
// wave until every producer publishes the awaited `pkg@version`, and a never-publishing producer
// ESCALATES (bounded) rather than wedging the set. Until S4, a parked dependent was a SILENT stall —
// the epic views showed no wave, no delivery, no reason it hadn't started.
//
// This module is the pure derivation half of S4: given a dependent's inbound `plan_deps` edges plus
// its own lifecycle signals, it projects the epic's GATE STATE — is it waiting on a producer, has it
// gone green (bound to a concrete version), or has its bounded timeout elapsed (escalated)? — as the
// two flat, display-only `plans` columns (`wait_gate` / `wait_gate_label`) the declarative epic
// index/detail dataGrids read. `pollWaitGate` (app/service.ts) is the idempotent projection pass that
// joins each plan against its edges and stamps the result; this file holds NO data/engine access so
// it stays unit-testable, mirroring `deriveDelivery` (app/delivery.ts) / `deriveEpicPhase`
// (app/epicPhase.ts). It NEVER changes admission or scheduling — read-only over the state S1–S3
// produce.
//
// The gate's poll cadence and bounded timeout are NOT re-invented here: the probe is derived from the
// edge by the SAME `capabilityProbeForEdge` (app/planLowering.ts) S3 lowers with, and its cadence /
// budget come from the SAME `normalizePoll` / `readinessTimeoutMs` (app/readiness.ts) the worker and
// gate timers use — so the projected "re-checks every N / escalates by T" can never drift from the
// real gate.

import type { PlanDep } from "./plan.ts";
import { capabilityProbeForEdge } from "./planLowering.ts";
import { normalizePoll, readinessTimeoutMs } from "./readiness.ts";

/** The dependent epic's derived gate state. A ROOT epic (no inbound edge) has NO gate → `null`.
 *   • waiting   — parked at the preflight, blocked on ≥1 producer's capability, timeout not yet spent.
 *   • ready     — the preflight went green: the epic has fanned out, bound to a concrete version.
 *   • escalated — the gate's bounded timeout elapsed with the capability still unpublished. */
export type WaitGateState = "waiting" | "ready" | "escalated";

/** The lifecycle signals `deriveWaitGate` reads off the dependent's own `plans` row to tell whether
 * its preflight has already passed (green) or failed. All are the ordinary projections S1–S3 already
 * maintain — this derivation only READS them. */
export interface WaitGateLifecycle {
  /** The plan lifecycle status (`planning` | `dispatched` | `done` | `failed` | `abandoned`). */
  status: string;
  /** The 0-based wave the fleet is implementing, stamped by `select-wave` once fan-out begins — so a
   *  non-null value proves the leading preflight already went green. NULL while still gated. */
  current_wave: number | null;
  /** JSON array (`["@scope/pkg@1.4.0", …]`) of the versions the preflight bound, stamped by
   *  `select-wave` from the `resolvedArtifacts` process variable. NULL until green / for roots. */
  bound_artifacts: string | null;
  /** When the dependent's plan instance was created — the reference point the bounded gate timeout is
   *  measured from (the preflight is the epic's very first step). */
  created_at: string;
}

/** The flat projection `pollWaitGate` stamps onto the `plans` row. Both NULL for a root epic. */
export interface WaitGateProjection {
  wait_gate: WaitGateState | null;
  wait_gate_label: string | null;
}

export interface WaitGateOptions {
  /** Injectable clock (ms epoch) for deterministic tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** Injectable env for the readiness timeout/poll defaults (mirrors `readinessTimeoutMs`). */
  env?: Record<string, string | undefined>;
}

/** Terminal plan states in which a dependent that never went green has effectively given up on its
 * gate — surfaced as `escalated` so the operator sees a blocked epic, never a silent dead end. */
const FAILED_STATES = new Set(["failed", "abandoned"]);

/** Parse the stored `bound_artifacts` JSON into a clean list of `pkg@version` strings. Defensive: a
 * malformed / non-array / non-string-element value degrades to an empty list rather than throwing, so
 * a bad row can never break the whole projection pass. */
export function parseBoundArtifacts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/** Human-readable duration for a millisecond span, e.g. `90000 → "1m 30s"`, `1800000 → "30m"`. Used
 * only for the display label; keeps the projection readable without pulling in a date library. */
export function humanizeMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/** Format one producer/package the dependent is blocked on: the producer plan key already carries its
 * issue handle (`owner/repo#N`), so `owner/repo#12 @ @scope/pkg` reads as "waiting on #12 @ pkg". */
function waitingOnTarget(edge: PlanDep): string {
  return `${edge.depends_on_plan_key} @ ${edge.package}`;
}

/** Join the producers a dependent still waits on into a compact clause, capping the visible list so a
 * fan-in of many producers stays a one-line label ("…, +3 more"). */
function waitingOnClause(edges: readonly PlanDep[]): string {
  const MAX = 3;
  const shown = edges.slice(0, MAX).map(waitingOnTarget);
  const rest = edges.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", ");
}

/**
 * Derive a dependent epic's gate projection from its inbound inter-epic edges and its own lifecycle.
 *
 *   • No inbound edge → ROOT → `{ null, null }`: the epic shows no wait-gate and starts immediately.
 *   • Green (the preflight passed — the epic fanned out (`current_wave` set) / dispatched, or already
 *     carries `bound_artifacts`) → `ready`, labelled with the bound `pkg@version`s.
 *   • Still gated and the bounded timeout has elapsed (`now ≥ created_at + gate timeout`), or the
 *     epic reached a terminal FAILED state without going green → `escalated`.
 *   • Otherwise → `waiting`, labelled with which producer/package it is blocked on plus the gate's
 *     own poll cadence and escalation deadline, so a parked dependent is never a silent stall.
 *
 * Pure: the cadence/timeout come from the SAME readiness helpers the gate itself uses (derived off the
 * edge via `capabilityProbeForEdge`), so the projection can never drift from the real schedule.
 */
export function deriveWaitGate(
  edges: readonly PlanDep[],
  plan: WaitGateLifecycle,
  opts: WaitGateOptions = {},
): WaitGateProjection {
  // A root epic has no inbound edge — nothing to wait on, so no gate projection at all.
  if (edges.length === 0) return { wait_gate: null, wait_gate_label: null };

  const bound = parseBoundArtifacts(plan.bound_artifacts);
  // The leading preflight is the epic's FIRST step, so ANY downstream progress proves it went green:
  // `select-wave` stamped a wave, the fan-out dispatched, or a bound version was already captured.
  const green = bound.length > 0 ||
    plan.current_wave != null ||
    plan.status === "dispatched" ||
    plan.status === "done";

  if (green) {
    const detail = bound.length > 0 ? ` · bound ${bound.join(", ")}` : "";
    return { wait_gate: "ready", wait_gate_label: `ready${detail}` };
  }

  // Not green. Derive the gate's own bounded timeout from the edge (the same probe S3 lowers) so the
  // projected deadline matches the engine timer. Every edge yields the same default budget; take the
  // max defensively in case a future edge overrides it.
  const env = opts.env;
  const nowMs = opts.nowMs ?? Date.now();
  const probes = edges.map(capabilityProbeForEdge);
  const timeoutMs = Math.max(...probes.map((p) => readinessTimeoutMs(p, env)));
  const everyMs = Math.min(...probes.map((p) => normalizePoll(p.poll).everyMs));
  const startMs = Date.parse(plan.created_at);
  const deadlineMs = Number.isFinite(startMs) ? startMs + timeoutMs : NaN;

  const clause = waitingOnClause(edges);

  // A terminal FAILED epic that never went green, or one whose bounded timeout has elapsed, has
  // effectively escalated — surface it so the operator sees a blocked epic rather than a silent stall.
  const timedOut = Number.isFinite(deadlineMs) && nowMs >= deadlineMs;
  if (timedOut || FAILED_STATES.has(plan.status)) {
    return {
      wait_gate: "escalated",
      wait_gate_label: `escalated · still waiting on ${clause} after ${humanizeMs(timeoutMs)}`,
    };
  }

  const deadline = Number.isFinite(deadlineMs)
    ? ` · escalates by ${new Date(deadlineMs).toISOString()}`
    : "";
  return {
    wait_gate: "waiting",
    wait_gate_label: `waiting on ${clause} · re-checks every ${humanizeMs(everyMs)}${deadline}`,
  };
}
