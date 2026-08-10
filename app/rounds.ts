// The per-submit round-cap coercion, kept as a pure module (no env, no I/O) so it is trivially
// testable — mirrors app/waves.ts. `service.ts` builds the fleet default MAX_ROUNDS on top of it,
// and the submit form / webhook / start action each pass a caller-supplied override through it.

/** Upper bound on the review-round cap. A cap of 0 would escalate before the first round; an
 * unbounded cap could run the agent (and its cost) indefinitely, so overrides are clamped here. */
export const MAX_ROUNDS_CEILING = 100;

/** Coerce an arbitrary caller-supplied round cap into a sane positive integer, falling back to
 * `fallback` when the value is absent, blank, non-numeric, zero/negative, or NaN. The submit form
 * sends strings (the runtime renders every field as text), so this accepts `string | number |
 * unknown`. Values above MAX_ROUNDS_CEILING are clamped down rather than rejected — and the same
 * clamp is applied to `fallback`, so an oversized fallback can never bypass the safety ceiling. */
export function clampRounds(value: unknown, fallback: number): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(Math.max(Math.trunc(fallback), 1), MAX_ROUNDS_CEILING)
    : 1;
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return safeFallback;
  const i = Math.trunc(n);
  if (i < 1) return safeFallback;
  return Math.min(i, MAX_ROUNDS_CEILING);
}

/** Ceiling on CI-fix attempts, mirroring MAX_ROUNDS_CEILING — an unbounded budget could dispatch
 * the `senior:fix-ci` agent (and its cost) indefinitely against a stubbornly-red PR. */
export const MAX_CI_FIX_CEILING = 20;

/** Coerce the operator-supplied CI-fix budget (env `NANO_PR_MAX_CI_FIX_ROUNDS`) into a sane
 * non-negative integer. Unlike {@link clampRounds} this ALLOWS 0 — a budget of 0 disables
 * auto-fix so a blocked PR escalates to a human immediately. Absent / blank / non-numeric /
 * negative / NaN fall back to `fallback`; values above the ceiling are clamped down (and so is an
 * oversized `fallback`, so it can never bypass the ceiling). */
export function clampCiFixBudget(value: unknown, fallback: number): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(Math.max(Math.trunc(fallback), 0), MAX_CI_FIX_CEILING)
    : 0;
  // Blank / absent → fallback. This guard is essential BEFORE coercion: Number("") is 0, so a
  // blank env var must not be mistaken for an explicit 0 (which legitimately disables auto-fix).
  if (value === null || value === undefined) return safeFallback;
  const trimmed = typeof value === "number" ? value : String(value).trim();
  if (trimmed === "") return safeFallback;
  const n = typeof trimmed === "number" ? trimmed : Number(trimmed);
  if (!Number.isFinite(n)) return safeFallback;
  const i = Math.trunc(n);
  if (i < 0) return safeFallback;
  return Math.min(i, MAX_CI_FIX_CEILING);
}
