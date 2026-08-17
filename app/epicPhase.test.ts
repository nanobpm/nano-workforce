// Read-model derivation test for the epic domain phase (issue #261). `deriveEpicPhase` /
// `implementingPhase` are the single source of truth for the write-time projection each spine
// worker stamps onto `plans.epic_phase`. The projection binds structurally to plan-fanout.bpmn's
// named activities via the job's BPMN element id (mirroring the urban #266 phase primitive), so the
// epic view can show WHICH phase an epic is in — not only the process-instance terminal status.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { deriveEpicPhase, EPIC_PHASE, implementingPhase } from "./epicPhase.ts";

test("deriveEpicPhase maps each spine element to its domain phase", () => {
  // Planning genesis + hand-off into Reviewing when the plan is recorded.
  assertEquals(deriveEpicPhase("plan"), EPIC_PHASE.PLANNING);
  assertEquals(deriveEpicPhase("ensure-base-branch"), EPIC_PHASE.PLANNING);
  assertEquals(deriveEpicPhase("record-plan"), EPIC_PHASE.REVIEWING);
  assertEquals(deriveEpicPhase("review-plan"), EPIC_PHASE.REVIEWING);
  assertEquals(deriveEpicPhase("record-plan-review"), EPIC_PHASE.REVIEWING);
  assertEquals(deriveEpicPhase("plan-review-decision"), EPIC_PHASE.REVIEWING);
  // Trial-merge band.
  assertEquals(deriveEpicPhase("trial-merge"), EPIC_PHASE.TRIAL_MERGING);
  assertEquals(deriveEpicPhase("record-trial-merge"), EPIC_PHASE.TRIAL_MERGING);
  assertEquals(deriveEpicPhase("trial-merge-decision"), EPIC_PHASE.TRIAL_MERGING);
  assertEquals(deriveEpicPhase("resolve-trial-attention"), EPIC_PHASE.TRIAL_MERGING);
  // Finalize step's lasting result is the "Fleet dispatched" terminal.
  assertEquals(deriveEpicPhase("record-results"), EPIC_PHASE.DISPATCHED);
});

test("deriveEpicPhase wave-labels the Implementing band from the levelize records", () => {
  // select-wave / record-wave / the implement MI + wait-wave-merged all read as Implementing,
  // labelled with the 1-based wave from the wave/levelize records (0-based `current`).
  assertEquals(
    deriveEpicPhase("select-wave", { current: 0, total: 3 }),
    "Implementing (wave 1/3)",
  );
  assertEquals(
    deriveEpicPhase("record-wave", { current: 2, total: 3 }),
    "Implementing (wave 3/3)",
  );
  assertEquals(
    deriveEpicPhase("wait-wave-merged", { current: 1, total: 3 }),
    "Implementing (wave 2/3)",
  );
  assertEquals(deriveEpicPhase("implement-task", { current: 0, total: 1 }), "Implementing (wave 1/1)");
});

test("deriveEpicPhase returns null for a non-spine element so a stray write never clobbers", () => {
  assertEquals(deriveEpicPhase(undefined), null);
  assertEquals(deriveEpicPhase(null), null);
  assertEquals(deriveEpicPhase(""), null);
  assertEquals(deriveEpicPhase("some-unrelated-element"), null);
});

test("implementingPhase clamps the 1-based label to the total and degrades gracefully", () => {
  assertEquals(implementingPhase(0, 2), "Implementing (wave 1/2)");
  // A `current` at/over the last index (record-wave pins current_wave to waveCount-1 on the final
  // wave) never reads past n/n.
  assertEquals(implementingPhase(5, 3), "Implementing (wave 3/3)");
  // Unusable wave numbers (taskless plan / NaN counter) degrade to a bare Implementing — never
  // "wave NaN/…".
  assertEquals(implementingPhase(0, 0), "Implementing");
  assertEquals(implementingPhase(undefined, undefined), "Implementing");
  assertEquals(implementingPhase("x", "y"), "Implementing");
});
