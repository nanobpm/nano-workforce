// The ONE resolver for a feature run's merge-intent flags (issue #1041), shared by the API door
// (operations/startFeature.ts) and the MCP door (app/mcpStart.ts).
//
// The flags form an implication chain: `humanApproval` gates the merge, `autoMerge` follows
// convergence. So a flag the caller set to `true` IMPLIES its prerequisites
// (`humanApproval ⇒ autoMerge ⇒ converge`) rather than being silently pinned off. A prerequisite
// the caller EXPLICITLY set to `false` contradicts that intent and is rejected — never resolved by
// dropping a `true`. Invariant: no flag the caller set to `true` ends up `false`.

export type FeatureFlagInput = {
  converge?: boolean | undefined;
  autoMerge?: boolean | undefined;
  humanApproval?: boolean | undefined;
};

export type FeatureFlags = { converge: boolean; autoMerge: boolean; humanApproval: boolean };

export class ContradictoryFeatureFlagsError extends Error {}

export function resolveFeatureFlags(input: FeatureFlagInput): FeatureFlags {
  const humanApproval = input.humanApproval === true;
  if (humanApproval && input.autoMerge === false) {
    throw new ContradictoryFeatureFlagsError("humanApproval requires autoMerge: true (it gates the merge)");
  }
  const autoMerge = input.autoMerge === true || humanApproval;
  if (autoMerge && input.converge === false) {
    throw new ContradictoryFeatureFlagsError(
      `${input.autoMerge === true ? "autoMerge" : "humanApproval"} requires converge: true (a merge requires convergence)`,
    );
  }
  const converge = input.converge === true || autoMerge;
  return { converge, autoMerge, humanApproval };
}
