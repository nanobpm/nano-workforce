// app/stepAxis.ts — the ONE canonical progress step axis for the derived stepper (ADR 0006 §4b, S7).
//
// §4b collapses the unit's three progress projections (feature `deriveStage`, epic write-time
// `epic_phase`, delivery-graph `pollDeliveryGraphPhase`) onto ONE derivation over a single step axis,
// rendered by the ONE `pipeline` renderer kind. This module owns the canonical definition of that
// axis: the ordered steps, the explicit cell→step mapping, the terminal-tier normalization, and the
// deterministic parallel-frontier reduction. Feature (`app/stage.ts` / `app/featureReadModel.ts`) and
// delivery-graph (`app/deliveryGraphReadModel.ts`) both project onto it; there is no per-surface
// re-declaration of the step vocabulary.
//
// SEEDED FROM `STAGE_KEYS`, OWNS THE MAPPING (§4b §217-232). `STAGE_KEYS` (app/stage.ts) is the closest
// EXISTING projection of the axis but it is NOT literally a clean cell sequence — it mixes lifecycle
// states (`Requested` / `PR open` / `Done`) with process cells (`implement` / `converge` / `merge`),
// and hosts interstitial `wait` / `human` / `escalation` cells. So this module SEEDS `STEP_KEYS` from
// `STAGE_KEYS` (the single source of truth for the six brackets) but adds the thing `STAGE_KEYS` lacks:
// an explicit map of which cell entry/exit each step corresponds to, and how the interstitial cells
// collapse into an existing bracket. v1 leaves the two existing axis consumers physically in place (the
// exported `STAGE_KEYS` and the static `stages` array in `pages/feature.page.json`) and only SEEDS this
// mapping from them — deriving/retiring those duplicates is a flagged follow-up, not S7.
//
// LIFECYCLE-STAGE FIDELITY ONLY (S7). Per §4b, S7 renders the coarse LIFECYCLE stage, not a per-cell
// position: even feature is not per-cell today (`deriveStage` collapses a readiness-probe/timer park or
// an active `implement-task` all to `Implementing`). True mid-cell / per-node resolution is the S8
// element-instance source (#542, #473). The interstitial-cell mapping below therefore documents the
// bracket each cell COLLAPSES into; it does not add per-cell steps.

import { STAGE_DONE_STATUSES, STAGE_KEYS, type StageKey, type StageState } from "./stage.ts";

/** The canonical ordered step axis — SEEDED from `STAGE_KEYS` (app/stage.ts), the single source of
 * truth for the six pipeline brackets: Requested → Implementing → PR open → Converging → Merging →
 * Done. This module owns the cell→step MAPPING onto these keys; the keys themselves stay sourced from
 * `STAGE_KEYS` so the axis cannot fork across surfaces. */
export const STEP_KEYS: readonly StageKey[] = STAGE_KEYS;
export type StepKey = StageKey;

/** The deterministic INITIAL step for a pre-run / dispatch-pending / first-observation unit — the head
 * of the axis (`Requested`, `STAGE_KEYS[0]`). Pins the scalar `activeField` so it is never undefined on
 * a first observation with no prior lifecycle key (§4b §431-449). */
export const INITIAL_STEP: StepKey = STEP_KEYS[0];

/** The TERMINAL step — the tail of the axis (`Done`). A terminal unit pins its `activeField` here
 * outright (with an `ok`/`failed` render state) so it can never render an undefined/invalid active
 * stage (§4b §436-438). */
export const TERMINAL_STEP: StepKey = STEP_KEYS[STEP_KEYS.length - 1];

/** The process-cell vocabulary of the composed unit (§2/S4): the three executable pipeline cells
 * (`implement` / `converge` / `merge`) plus the interstitial `wait` / `human` / `escalation` cells that
 * can be inserted around them. */
export type ProcessCell = "implement" | "converge" | "merge" | "wait" | "human" | "escalation";

/**
 * The explicit **cell → step** mapping (§4b's first deliverable). Each executable cell ENTERS its
 * bracket when the token arrives and EXITS it when the token advances to the next cell's bracket; the
 * three lifecycle markers bracket the cell run — a token before `implement` reads `Requested`, raising
 * the PR on `implement` exit enters `PR open`, and a merged/terminal token reads `Done`.
 *
 * The interstitial `wait` / `human` / `escalation` cells do **not** own a distinct step — they HOLD the
 * frontier at the bracket of the cell they interrupt (a human gate mid-convergence reads `Converging`,
 * a wait-gate before implementation reads `Implementing`), collapsing into an existing `STAGE_KEYS`
 * bracket rather than extending the axis. This is why the `pipeline` renderer needs no new stages for
 * v1: every cell maps onto one of the six existing keys.
 */
export const CELL_STEP: Readonly<Record<ProcessCell, StepKey>> = {
  implement: "Implementing",
  converge: "Converging",
  merge: "Merging",
  // Interstitial cells collapse into the host bracket (hold, do not advance).
  wait: "Implementing",
  human: "Converging",
  escalation: "Converging",
};

/** The zero-based ordinal of a step on the axis — the total order the frontier reduction compares
 * "advancement" by. `-1` for an unknown key (defensive; every derived step is a `STEP_KEYS` member). */
export function stepOrdinal(step: StepKey): number {
  return STEP_KEYS.indexOf(step);
}

/** The renderer's terminal render-state tiers, reusing the SHIPPED `featureReadModel` `stage_state`
 * basis (`STAGE_DONE_STATUSES` + the `stage_state` CASE, app/featureReadModel.ts) rather than inventing
 * a second mapping (derivation-over-duplication, §4b §296-308):
 *   - `ok`      — a SUCCESS terminal: `merged` / `converged` / the new canonical `done`.
 *   - `blocked` — the renderer's DISTINCT operator-actionable `blocked` terminal (never folded away).
 *   - `failed`  — a FAILED terminal: `failed` / `skipped` / `abandoned`.
 *   - `null`    — not terminal (in progress).
 * Note this is the PER-CELL / per-PR tier: `converged` is a success terminal here. The EPIC rollup's
 * shape-aware predicate (`converged` is resolved-not-landed) is applied by the caller, not here. */
export type TerminalTier = "ok" | "failed" | "blocked";

const SUCCESS_TERMINALS: readonly string[] = ["merged", "converged", "done"];
const FAILED_TERMINALS: readonly string[] = ["failed", "skipped", "abandoned"];

export function terminalTier(status: string): TerminalTier | null {
  if (SUCCESS_TERMINALS.includes(status)) return "ok";
  if (status === "blocked") return "blocked";
  if (FAILED_TERMINALS.includes(status)) return "failed";
  return null;
}

/** A `TerminalTier` is a NON-SUCCESS terminal (`failed` / `blocked`) iff it is operator-actionable —
 * the thing an in-flight sibling must not mask. `ok` (success) is the only success terminal. */
export function isNonSuccessTerminal(tier: TerminalTier): boolean {
  return tier === "failed" || tier === "blocked";
}

/** Map a terminal tier onto the `pipeline` column's `stateField` vocabulary (`ok`/`failed`/`blocked`).
 * The raw canonical `done` never reaches the renderer verbatim (any other string silently degrades to
 * in-progress), so a success terminal renders as `ok`. Total over the three tiers. */
export function tierRenderState(tier: TerminalTier): StageState {
  return tier;
}

/** One branch of an aggregate's active frontier, projected onto the canonical axis. `terminal` is the
 * branch's canonical terminal status when it has settled (`merged`/`converged`/`done`/`blocked`/
 * `failed`/`skipped`/`abandoned`), or `null` while the branch is still active at `step`. `nodeId` is
 * the stable identity used as the deterministic tie-break. */
export interface FrontierBranch {
  nodeId: string;
  step: StepKey;
  terminal: string | null;
}

/** The reduced scalar the `pipeline` column binds: one `STAGE_KEYS` step plus its render state. */
export interface ReducedFrontier {
  step: StepKey;
  state: StageState;
}

/** Deterministic tie-break: earliest step ordinal, then stable `nodeId`. */
function earliest(a: FrontierBranch, b: FrontierBranch): FrontierBranch {
  const da = stepOrdinal(a.step);
  const db = stepOrdinal(b.step);
  if (da !== db) return da < db ? a : b;
  return a.nodeId <= b.nodeId ? a : b;
}

/**
 * Reduce a parallel active frontier to ONE deterministic step for the scalar `pipeline` `activeField`
 * (§4b §280-332). The `pipeline` column binds a single scalar, but an N-node/parallel DAG (epic waves,
 * delivery graphs) can occupy incomparable cells at once, so the frontier is reduced deterministically:
 *
 *   - A **non-success terminal** (`failed` / `blocked`) takes PRECEDENCE in every case — it is an
 *     operator-actionable signal an in-flight sibling must not mask. Among multiple non-success
 *     terminals the tie-break is earliest terminal step, then stable node id; the aggregate renders at
 *     that branch's step with that terminal's render state (`failed` / `blocked`).
 *   - Otherwise, if any branch is still ACTIVE, reduce to the **least-advanced active branch** (the
 *     "still blocked on" read) with an in-progress state — the aggregate never renders further along
 *     than its slowest in-flight branch. Terminal (success) branches are past, not "still blocked on".
 *   - Otherwise every branch is a SUCCESS terminal → `done` (the axis tail, `ok`).
 *
 * The shape-aware epic success predicate (`converged` is resolved-not-landed for an epic rollup, not a
 * success terminal) is applied by the CALLER when it classifies each branch's `terminal`; this reducer
 * treats whatever terminal it is handed per the per-cell tier. A single-branch unit (feature, and a
 * delivery-graph at S7's coarse run-level fidelity) reduces trivially to that branch.
 *
 * Throws on an empty frontier — a unit always has at least its own (initial) branch; an empty input is
 * a caller bug, not a renderable state.
 */
export function reduceFrontier(branches: readonly FrontierBranch[]): ReducedFrontier {
  if (branches.length === 0) {
    throw new Error("reduceFrontier: empty frontier — a unit always has at least one branch");
  }

  const nonSuccess: FrontierBranch[] = [];
  const active: FrontierBranch[] = [];
  for (const b of branches) {
    if (b.terminal === null) {
      active.push(b);
      continue;
    }
    const tier = terminalTier(b.terminal);
    // An unrecognised terminal degrades to a failed-tier signal (defensive; the caller passes canonical
    // union terminals) so it is never silently masked by an in-flight sibling.
    if (tier === null || isNonSuccessTerminal(tier)) nonSuccess.push(b);
  }

  if (nonSuccess.length > 0) {
    const pick = nonSuccess.reduce(earliest);
    const tier = terminalTier(pick.terminal ?? "") ?? "failed";
    return { step: pick.step, state: tierRenderState(tier) };
  }

  if (active.length > 0) {
    const pick = active.reduce(earliest);
    return { step: pick.step, state: null };
  }

  // All branches are success terminals → the shared success bucket (`done`).
  return { step: TERMINAL_STEP, state: "ok" };
}

/** Re-export the shipped terminal-status set the tier basis draws on, so a consumer can reference the
 * single source without a second import of app/featureReadModel.ts. */
export { STAGE_DONE_STATUSES };
