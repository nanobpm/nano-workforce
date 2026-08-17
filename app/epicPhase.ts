// app/epicPhase.ts — reify the epic's own domain lifecycle as a derived `epic_phase` (issue #261).
//
// `plans.status` only distinguishes `planning` / `dispatched` / `done` / `failed` / `abandoned` —
// and `dispatched` is the `plan-fanout.bpmn` PROCESS-INSTANCE terminal ("fan-out job done"), not the
// epic's domain phase. `plan-fanout.bpmn` already models the rich lifecycle as named activities
// (Ensure base branch → Plan → Review plan → Select wave → Implement task → Trial merge → Finalize
// → "Fleet dispatched"); this module reifies that lifecycle as a stored, display-only projection so
// the epic view can show which phase the epic is in.
//
// Convention over declaration: the phases ARE the activities plan-fanout.bpmn already names. Each
// spine worker derives its projection from its OWN BPMN element id (`job.elementId`) — no annotation
// map on the model, no second reconciliation pass — mirroring the urban structural phase-projection
// primitive (nano-ide#266), which derives the phase from the furthest element reached in
// write-provenance. This module is the single binding (nwf is #266's first consumer).
//
// Write-time projection: because the phase only advances when a worker writes, each spine worker
// stamps the phase the epic is ENTERING as a result of its write — the write points ARE the phase
// boundaries. Two structural defaults are coarsened where the raw activity label would mislead
// (documented on `ELEMENT_PHASE` below): `select-wave` reads as `Implementing (wave n/t)` because it
// dispatches and durably marks the (write-silent) `implement` multi-instance subProcess, and
// `record-results` reads as the `Dispatched` terminal ("Fleet dispatched").
//
// Cross-instance rollup (later): post-dispatch, the epic's effective phase extends into the
// convergence/merge loops carried on separate top-level instances correlated by lineage
// (`rootRequestKey`, nwf#245 / nano-ide#254). Once #266's Tier-2 rollup lands, `epic_phase` can
// advance past `Dispatched` into Converging/Merging with no new wiring here — the seam is this
// module's derivation staying the single source.

/** The epic's domain phases — the vocabulary the derivation projects onto `plans.epic_phase`.
 *  Shared with the feature-view stage vocabulary (nwf#254), which uses the same stored-projection
 *  pattern. `Implementing` is wave-labelled at derivation time (see {@link implementingPhase}). */
export const EPIC_PHASE = {
  PLANNING: "Planning",
  REVIEWING: "Reviewing",
  IMPLEMENTING: "Implementing",
  TRIAL_MERGING: "Trial merging",
  FINALIZING: "Finalizing",
  DISPATCHED: "Dispatched",
} as const;

/** Coerce a wave index/count to a non-negative integer, or null when it isn't one. Mirrors the
 *  `toWave` coercion the wave workers already apply, so a NaN/absent counter degrades to an
 *  unlabelled `Implementing` rather than emitting `wave NaN/…`. */
const toWave = (v: unknown): number | null => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * `Implementing (wave n/t)` — special-cased from the wave/levelize records (`plan_tasks` waves),
 * NOT the raw multi-instance counter. `current` is the 0-based wave index carried on the process
 * (`currentWave` / the projected `current_wave`); the label is 1-based and clamped to `total` so a
 * final wave reads `n/n`. Falls back to a bare `Implementing` when the wave numbers aren't usable
 * (e.g. a taskless plan with `total` 0), so the phase never renders `wave NaN`.
 */
export function implementingPhase(current: unknown, total: unknown): string {
  const t = toWave(total);
  const c = toWave(current);
  if (t !== null && t > 0 && c !== null) {
    const n = Math.min(c + 1, t);
    return `${EPIC_PHASE.IMPLEMENTING} (wave ${n}/${t})`;
  }
  return EPIC_PHASE.IMPLEMENTING;
}

/**
 * Structural binding: `plan-fanout.bpmn` element id → the domain phase the epic is IN while that
 * element (or the write-silent agent step it hands off to) runs. Complete over the epic's spine, so
 * the projection is derivable from provenance alone (the urban #266 semantics). Two entries are
 * deliberately COARSENED from their raw activity label because the structural default misleads:
 *   • `record-plan` ("Record plan & levelize") → Reviewing: recording the plan hands the epic to the
 *     `review-plan` agent, so the review phase should already read while that (write-silent) agent
 *     runs. `record-plan-review` re-affirms Reviewing on each round/escalation.
 *   • `select-wave` ("Select wave") → Implementing: it dispatches the wave and is the last host write
 *     before the write-silent `implement` MI, so it durably marks the implementation phase for the
 *     wave it launches (wave-labelled via {@link implementingPhase} at the call site).
 *   • `record-results` ("Finalize plan") → Dispatched: the finalize step's lasting result is the
 *     "Fleet dispatched" terminal end event.
 * `record-wave`'s next phase is data-dependent (trial-merge vs. next wave vs. finalize), so it is
 * resolved at its call site rather than from the element id alone; its structural fallback here is
 * the wave it just landed.
 */
const ELEMENT_PHASE: Readonly<Record<string, string>> = {
  "ensure-base-branch": EPIC_PHASE.PLANNING,
  "plan": EPIC_PHASE.PLANNING,
  "record-plan": EPIC_PHASE.REVIEWING,
  "review-plan": EPIC_PHASE.REVIEWING,
  "record-plan-review": EPIC_PHASE.REVIEWING,
  "plan-review-decision": EPIC_PHASE.REVIEWING,
  "select-wave": EPIC_PHASE.IMPLEMENTING,
  "implement": EPIC_PHASE.IMPLEMENTING,
  "implement-task": EPIC_PHASE.IMPLEMENTING,
  "feature-escalation": EPIC_PHASE.IMPLEMENTING,
  "record-wave": EPIC_PHASE.IMPLEMENTING,
  "wait-wave-merged": EPIC_PHASE.IMPLEMENTING,
  "trial-merge": EPIC_PHASE.TRIAL_MERGING,
  "record-trial-merge": EPIC_PHASE.TRIAL_MERGING,
  "trial-merge-decision": EPIC_PHASE.TRIAL_MERGING,
  "resolve-trial-attention": EPIC_PHASE.TRIAL_MERGING,
  "record-results": EPIC_PHASE.DISPATCHED,
};

/** Optional wave context for a wave-bearing phase, sourced from the wave/levelize records. */
export interface WaveContext {
  current?: unknown;
  total?: unknown;
}

/**
 * Derive the epic phase for a spine element from its BPMN element id, or `null` when the element
 * doesn't mark a phase — so a non-spine write (e.g. a poller reconcile pass) never clobbers
 * `epic_phase`. A wave-bearing phase (`Implementing`) is wave-labelled from {@link WaveContext} when
 * supplied. This is the single structural deriver; workers pass `job.elementId` so the phase name is
 * never hardcoded at the call site.
 */
export function deriveEpicPhase(
  elementId: string | undefined | null,
  wave?: WaveContext,
): string | null {
  if (!elementId) return null;
  const base = ELEMENT_PHASE[elementId];
  if (base === undefined) return null;
  if (base === EPIC_PHASE.IMPLEMENTING) return implementingPhase(wave?.current, wave?.total);
  return base;
}
