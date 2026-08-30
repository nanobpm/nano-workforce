// Read-model derivation test for the epic domain phase (issue #261). `deriveEpicPhase` /
// `implementingPhase` are the single source of truth for the write-time projection each spine
// worker stamps onto `plans.epic_phase`. The projection binds structurally to plan-fanout.bpmn's
// named activities via the job's BPMN element id (mirroring the urban #266 phase primitive), so the
// epic view can show WHICH phase an epic is in — not only the process-instance terminal status.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { deriveEpicPhase, deriveEpicPhaseLive, deriveTerminalEpicPhase, EPIC_PHASE, implementingPhase } from "./epicPhase.ts";

test("deriveEpicPhase maps each spine element to its domain phase", () => {
  // Planning genesis + hand-off into Reviewing when the plan is recorded.
  assertEquals(deriveEpicPhase("plan"), EPIC_PHASE.PLANNING);
  assertEquals(deriveEpicPhase("ensure-base-branch"), EPIC_PHASE.PLANNING);
  assertEquals(deriveEpicPhase("record-plan"), EPIC_PHASE.REVIEWING);
  assertEquals(deriveEpicPhase("review-plan"), EPIC_PHASE.REVIEWING);
  assertEquals(deriveEpicPhase("record-plan-review"), EPIC_PHASE.REVIEWING);
  assertEquals(deriveEpicPhase("plan-review-decision"), EPIC_PHASE.REVIEWING);
  // The empty-plan operator escalation (gw-plan-empty) is a planning-stage decision (Accept/Revise).
  assertEquals(deriveEpicPhase("empty-plan-escalation"), EPIC_PHASE.PLANNING);
  // Trial-merge band.
  assertEquals(deriveEpicPhase("trial-merge"), EPIC_PHASE.TRIAL_MERGING);
  assertEquals(deriveEpicPhase("record-trial-merge"), EPIC_PHASE.TRIAL_MERGING);
  assertEquals(deriveEpicPhase("trial-merge-decision"), EPIC_PHASE.TRIAL_MERGING);
  assertEquals(deriveEpicPhase("resolve-trial-attention"), EPIC_PHASE.TRIAL_MERGING);
  // Finalize step ("Finalize plan") reads Finalizing while its token is ACTIVE; the terminal
  // "Fleet dispatched" phase is derived from the terminal status, not this element (see
  // deriveTerminalEpicPhase), so Finalizing is reachable and Dispatched is not raced off a live token.
  assertEquals(deriveEpicPhase("record-results"), EPIC_PHASE.FINALIZING);
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
  // A NULL `current_wave` (unknown wave) with a known `wave_count` is ABSENT, not wave 0 — it must
  // NOT mislabel as "wave 1/t" (`Number(null)` is 0). Missing wave data stays missing.
  assertEquals(implementingPhase(null, 3), "Implementing");
  assertEquals(implementingPhase(null, null), "Implementing");
});

test("deriveEpicPhaseLive reads Finalizing from an ACTIVE finalizer token", () => {
  // The finalize step is Finalizing while its token is ACTIVE — the phase is reachable in the live
  // model (it is the furthest spine element short of the terminal Dispatched marker).
  assertEquals(
    deriveEpicPhaseLive([{ elementId: "record-results", state: "ACTIVE" }]),
    EPIC_PHASE.FINALIZING,
  );
  // Finalizing (ordinal) outranks a still-live trial-merge token.
  assertEquals(
    deriveEpicPhaseLive([
      { elementId: "trial-merge", state: "ACTIVE" },
      { elementId: "record-results", state: "ACTIVE" },
    ]),
    EPIC_PHASE.FINALIZING,
  );
});

test("deriveTerminalEpicPhase reads Dispatched only from a done epic that dispatched a fleet", () => {
  // A done epic that opened ≥1 slice reaches the terminal "Fleet dispatched" phase.
  assertEquals(deriveTerminalEpicPhase("done", 3), EPIC_PHASE.DISPATCHED);
  assertEquals(deriveTerminalEpicPhase("done", 1), EPIC_PHASE.DISPATCHED);
  // A taskless done (planner emitted no tasks — nothing dispatched) and non-done terminals are NOT
  // Dispatched, so the caller leaves the last live phase untouched.
  assertEquals(deriveTerminalEpicPhase("done", 0), null);
  assertEquals(deriveTerminalEpicPhase("failed", 3), null);
  assertEquals(deriveTerminalEpicPhase("abandoned", 3), null);
  assertEquals(deriveTerminalEpicPhase("dispatched", 3), null);
});

// ── deriveEpicPhaseLive: the S8 live element-instance derivation (#542) ────────────────────────────
test("deriveEpicPhaseLive projects the FURTHEST active spine element onto its phase", () => {
  // A pre-PR Reviewing epic: the plan is recorded (COMPLETED) and the review-plan agent is running.
  assertEquals(
    deriveEpicPhaseLive([
      { elementId: "record-plan", state: "COMPLETED" },
      { elementId: "review-plan", state: "ACTIVE" },
    ]),
    EPIC_PHASE.REVIEWING,
  );
  // The implement multi-instance keeps select-wave/record-wave AND per-child implement-task tokens
  // live at once; a later trial-merge token, once reached, is the epic's true furthest position.
  assertEquals(
    deriveEpicPhaseLive([
      { elementId: "implement-task", state: "ACTIVE" },
      { elementId: "record-wave", state: "ACTIVE" },
      { elementId: "trial-merge", state: "ACTIVE" },
    ]),
    EPIC_PHASE.TRIAL_MERGING,
  );
});

test("deriveEpicPhaseLive wave-labels a live Implementing token from the wave context", () => {
  assertEquals(
    deriveEpicPhaseLive([{ elementId: "implement-task", state: "ACTIVE" }], { current: 1, total: 3 }),
    "Implementing (wave 2/3)",
  );
  // Mid-cell fidelity (S8): an active implement job with no wave numbers yet still reads Implementing.
  assertEquals(
    deriveEpicPhaseLive([{ elementId: "implement-task", state: "ACTIVE" }]),
    EPIC_PHASE.IMPLEMENTING,
  );
});

test("deriveEpicPhaseLive ignores non-ACTIVE tokens and non-spine plumbing, returning null when nothing marks a phase", () => {
  // COMPLETED/TERMINATED tokens are past, not the live position — an all-completed set marks nothing.
  assertEquals(
    deriveEpicPhaseLive([
      { elementId: "plan", state: "COMPLETED" },
      { elementId: "review-plan", state: "TERMINATED" },
    ]),
    null,
  );
  // A token parked only on non-spine plumbing (no ELEMENT_PHASE entry) leaves the phase untouched.
  assertEquals(deriveEpicPhaseLive([{ elementId: "some-gateway", state: "ACTIVE" }]), null);
  assertEquals(deriveEpicPhaseLive([]), null);
});
