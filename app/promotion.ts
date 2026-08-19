// Epic promotion derivation (issue #299): the pure, I/O-free core of the "promote a landed epic's
// integration branch to the default branch" automation. Extracted from `service.ts` (mirroring how
// `deriveDelivery` lives in `delivery.ts`) so the promotion predicate + state derivation + PR
// title/body rendering are unit-testable without a data layer or GitHub transport.
//
// The gap this closes: when an epic targets a custom `epic/*` integration branch, its slices PR
// *into* that branch. Once every slice merges (`plans.delivery = landed`, projected by
// `pollDelivery`), the epic is delivered ON the integration branch — but nothing opens the final
// `epic/* → <default>` promotion PR. `pollPromotion` (app/service.ts) uses these helpers to open
// exactly one such PR per landed epic and drive it through the same convergence + merge protocol.

/** The epic-card promotion progression for a landed epic (issue #299 point 3), denormalised onto
 * `plans.promotion_state`:
 *   • `ready`    — landed on an `epic/*` base; the promotion PR has not been opened yet.
 *   • `open`     — the promotion PR is open and converging toward merge.
 *   • `promoted` — the promotion PR merged; the epic is delivered on the default branch. */
export type PromotionState = "ready" | "open" | "promoted";

/** The subset of a plan the promotion derivation reads. */
export interface PromotablePlan {
  /** The derived delivery signal (`deriveDelivery`): only a `landed` epic is ever promotable. */
  delivery: string | null;
  /** The epic's target integration branch, e.g. `epic/test-dsl`. NULL / non-`epic/*` ⇒ nothing to
   * promote (a `main`-based epic's slices already landed on the default branch). */
  base_branch: string | null;
}

/** Whether `branch` is an auto-created `epic/*` integration branch (mirrors github.ts's
 * `isEpicBranch` — kept local so this module stays pure/dependency-free). */
export function isEpicIntegrationBranch(branch: string | null): branch is string {
  return !!branch && branch.startsWith("epic/");
}

/** Whether an epic is eligible for auto-promotion: its fan-out has LANDED (every slice PR merged —
 * the `deriveDelivery` `landed` predicate, which already encodes `prsInFlight == 0 && prsMerged ==
 * prsOpened && prsOpened > 0`, so a still-converging epic is never promoted) AND it targets a custom
 * `epic/*` integration branch. A `main`-based epic (slices went straight to the default branch) has
 * nothing to promote. */
export function isPromotable(plan: PromotablePlan): boolean {
  return plan.delivery === "landed" && isEpicIntegrationBranch(plan.base_branch);
}

/** Derive the promotion-state projection for a promotable epic from whether its promotion PR exists
 * yet and whether that PR has merged. Pure; the poller writes the result onto `plans.promotion_state`.
 *   • no PR yet            → `ready`
 *   • PR exists, unmerged  → `open`
 *   • PR merged            → `promoted` */
export function derivePromotionState(hasPr: boolean, prMerged: boolean): PromotionState {
  if (prMerged) return "promoted";
  if (hasPr) return "open";
  return "ready";
}

/** The title for an epic's promotion PR: names the integration branch, the target it promotes into,
 * and the epic's human identity. */
export function promotionPrTitle(base: string, target: string, epicTitle: string): string {
  return `Promote ${base} → ${target}: ${epicTitle}`;
}

/** Render the promotion PR body: a short explanation, the parent epic issue (as `Closes` so the
 * epic closes when the promotion lands — the epic is only truly delivered once its integration
 * branch reaches the default branch), and the list of merged slice PRs it carries. `slicePrKeys`
 * are `owner/repo#N` keys; a `Depends-on:` is deliberately NOT emitted — the slices have already
 * merged into the integration branch, so the promotion PR has no live dependency. */
export function promotionPrBody(
  base: string,
  target: string,
  issueRef: string,
  slicePrKeys: readonly string[],
): string {
  const lines = [
    `Automated promotion of the landed epic integration branch \`${base}\` into \`${target}\`.`,
    "",
    `Every slice of this epic has merged into \`${base}\`; this PR delivers the whole epic to ` +
      `\`${target}\`. It converges and merges through the standard review + merge protocol.`,
    "",
    `Closes ${issueRef}`,
  ];
  if (slicePrKeys.length > 0) {
    lines.push("", "Merged slices:");
    for (const key of slicePrKeys) lines.push(`- ${key}`);
  }
  return `${lines.join("\n")}\n`;
}
