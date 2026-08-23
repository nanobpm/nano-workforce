import { test } from "node:test";
import assert from "node:assert/strict";
import { advancePastTimer } from "./time.ts";

// Guards the defect class behind issue #474: a long BPMN business-wait must be crossed by advancing
// the ENGINE clock (fire the boundary timer) + one reconcile settle — NOT by `app.advanceTime`,
// which steps the scheduler in lockstep and replays every 5s runtime-cadence poll across the window
// (~18,000× for a 25h jump; ~123s of no-op churn). This pins the mechanism so a regression back to
// the lockstep path — or an added `scheduler.advance` — fails here instead of silently re-slowing CI.
test("advancePastTimer advances the engine clock then settles once, never replaying scheduler cadence", async () => {
  const PAST_SLA_MS = 25 * 60 * 60 * 1000;
  const calls: string[] = [];
  let engineMs: number | undefined;

  const app = {
    engine: {
      advanceTime: async (ms: number) => {
        engineMs = ms;
        calls.push("engine.advanceTime");
      },
    },
    settle: async () => {
      calls.push("settle");
    },
    // Present only to catch a regression: touching the scheduler's own `advance` is the slow
    // lockstep replay path the helper exists to avoid, so it must never be called.
    scheduler: {
      advance: async () => {
        calls.push("scheduler.advance");
      },
    },
  } as unknown as Parameters<typeof advancePastTimer>[0];

  await advancePastTimer(app, PAST_SLA_MS);

  assert.deepEqual(
    calls,
    ["engine.advanceTime", "settle"],
    "the engine boundary fires, then exactly one reconcile settle — the scheduler cadence is never replayed",
  );
  assert.equal(engineMs, PAST_SLA_MS, "the full business-wait window is applied to the engine clock");
});
