import assert from "node:assert/strict";
import { test } from "node:test";
import { ContradictoryFeatureFlagsError, resolveFeatureFlags } from "./featureFlags.ts";

// Issue #1041 guard: every presence/value combination of the three flags. No combination where a
// flag the caller set to `true` ends up `false` may be accepted — it must imply or be rejected.
const values = [undefined, false, true] as const;

for (const converge of values) {
  for (const autoMerge of values) {
    for (const humanApproval of values) {
      const input = { converge, autoMerge, humanApproval };
      test(`resolveFeatureFlags ${JSON.stringify(input)}`, () => {
        const contradictory =
          (humanApproval === true && autoMerge === false) ||
          ((autoMerge === true || humanApproval === true) && converge === false);
        if (contradictory) {
          assert.throws(() => resolveFeatureFlags(input), ContradictoryFeatureFlagsError);
          return;
        }
        const out = resolveFeatureFlags(input);
        for (const k of ["converge", "autoMerge", "humanApproval"] as const) {
          if (input[k] === true) assert.equal(out[k], true, `${k} set true but resolved false`);
          if (input[k] === false) assert.equal(out[k], false, `${k} set false but resolved true`);
        }
        // Implication chain holds on every accepted output.
        if (out.humanApproval) assert.equal(out.autoMerge, true);
        if (out.autoMerge) assert.equal(out.converge, true);
      });
    }
  }
}

test("autoMerge without converge implies converge (the #1041 merlin case)", () => {
  assert.deepEqual(resolveFeatureFlags({ autoMerge: true }), { converge: true, autoMerge: true, humanApproval: false });
});
