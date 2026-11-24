// Tests for the long-poll run wait (issue #1057): app/runWait.ts with a FAKE clock (no wall-clock sleep).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { RunView } from "./runLookup.ts";
import { parseWaitUntil, runFingerprint, WAIT_MAX_MS, type WaitClock, waitForRun, waitReason, waitTimeoutMs } from "./runWait.ts";

function view(over: Partial<RunView> = {}): RunView {
  return {
    key: "o/r#5",
    kind: "feature",
    title: null,
    status: "running",
    terminal: false,
    stage: "implementing",
    settings: {
      converge: true,
      autoMerge: true,
      humanApproval: false,
      blockedOn: null,
      maxRounds: null,
      autoResolveEscalations: false,
      hasCustomInstructions: false,
    },
    processInstanceKey: "1",
    processInstanceKeys: ["1"],
    activeWorker: null,
    leaseUntil: null,
    prUrl: null,
    openEscalation: null,
    incident: null,
    acknowledgedAt: null,
    createdAt: null,
    updatedAt: "t0",
    plannedChildren: null,
    children: [],
    ...over,
  };
}

function fakeClock(): WaitClock & { sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    async sleep(ms) {
      sleeps.push(ms);
      t += ms;
    },
  };
}

/** A lookup that returns successive views (the last one repeats). */
function seq(...views: Array<RunView | null>) {
  let i = 0;
  return async () => views[Math.min(i++, views.length - 1)] ?? null;
}

test("parseWaitUntil: defaults to any-change, rejects unknown", () => {
  assertEquals(parseWaitUntil(undefined), "any-change");
  assertEquals(parseWaitUntil("merged"), "merged");
  assertEquals(parseWaitUntil("bogus"), null);
});

test("waitTimeoutMs clamps to the server bound and defaults to it", () => {
  assertEquals(waitTimeoutMs("PT2H"), WAIT_MAX_MS);
  assertEquals(waitTimeoutMs("PT30S"), 30_000);
  assertEquals(waitTimeoutMs("garbage"), WAIT_MAX_MS);
  assertEquals(waitTimeoutMs(undefined), WAIT_MAX_MS);
});

test("waitReason: each condition, and escalation/terminal always end the wait", () => {
  const fp = runFingerprint(view());
  assertEquals(waitReason("pr-opened", view(), fp), null);
  assertEquals(waitReason("pr-opened", view({ prUrl: "https://x/pull/9" }), fp), "pr-opened");
  const child = view({ key: "o/r#9", kind: "pr", status: "converged" });
  assertEquals(waitReason("converged", view({ children: [child] }), fp), "converged");
  assertEquals(waitReason("merged", view({ children: [child] }), fp), null);
  assertEquals(waitReason("merged", view({ status: "merged", terminal: true }), fp), "merged");
  assertEquals(waitReason("any-change", view(), fp), null);
  assertEquals(waitReason("any-change", view({ stage: "pr-open" }), fp), "any-change");
  const esc = { userTaskKey: "7", kind: "feature", summary: null };
  assertEquals(waitReason("merged", view({ openEscalation: esc }), fp), "escalated");
  assertEquals(waitReason("merged", view({ children: [view({ kind: "pr", openEscalation: esc })] }), fp), "escalated");
  assertEquals(waitReason("merged", view({ status: "closed", terminal: true }), fp), "terminal");
});

test("waitForRun returns as soon as the condition holds", async () => {
  const clock = fakeClock();
  const res = await waitForRun(seq(view(), view(), view({ prUrl: "u" })), "pr-opened", 60_000, clock, 1_000);
  assertEquals(res.found && res.reason, "pr-opened");
  assertEquals(res.found && res.timedOut, false);
  assertEquals(clock.sleeps, [1_000, 1_000]);
});

test("waitForRun times out with the current view", async () => {
  const clock = fakeClock();
  const res = await waitForRun(seq(view()), "merged", 2_500, clock, 1_000);
  assertEquals(res.found && res.timedOut, true);
  assertEquals(res.found && res.reason, null);
  assertEquals(clock.sleeps, [1_000, 1_000, 500]);
  assertEquals(clock.now(), 2_500);
});

test("waitForRun: an escalation ends a merged-wait immediately", async () => {
  const esc = { userTaskKey: "7", kind: "feature", summary: "q" };
  const res = await waitForRun(seq(view(), view({ openEscalation: esc })), "merged", 60_000, fakeClock(), 1_000);
  assertEquals(res.found && res.reason, "escalated");
  assertEquals(res.found && res.view.openEscalation?.userTaskKey, "7");
});

test("waitForRun: unknown key is not found", async () => {
  assertEquals(await waitForRun(seq(null), "terminal", 1_000, fakeClock()), { found: false });
});

test("any-change ignores volatile lease/heartbeat fields", () => {
  const fp = runFingerprint(view());
  assertEquals(waitReason("any-change", view({ leaseUntil: "t9", activeWorker: "w", updatedAt: "t9" }), fp), null);
  const fpc = runFingerprint(view({ children: [view({ key: "c" })] }));
  assertEquals(waitReason("any-change", view({ children: [view({ key: "c", leaseUntil: "t9", updatedAt: "t9" })] }), fpc), null);
  assertEquals(waitReason("any-change", view({ children: [view({ key: "c", status: "merged" })] }), fpc), "any-change");
});

test("epic: merged/converged require every slice, not the first", () => {
  const fp = runFingerprint(view());
  const merged = view({ key: "a", kind: "pr", status: "merged" });
  const open = view({ key: "b", kind: "pr", status: "waiting_review" });
  const conv = view({ key: "b", kind: "pr", status: "converged" });
  const epic = (children: RunView[], planned = children.length) => view({ kind: "epic", children, plannedChildren: planned });
  assertEquals(waitReason("merged", epic([merged, open]), fp), null);
  assertEquals(waitReason("converged", epic([merged, open]), fp), null);
  assertEquals(waitReason("converged", epic([merged, conv]), fp), "converged");
  assertEquals(waitReason("merged", epic([merged, view({ key: "b", kind: "pr", status: "merged" })]), fp), "merged");
});

test("epic: a planned slice with no PR yet blocks merged/converged", () => {
  const fp = runFingerprint(view());
  const merged = view({ key: "a", kind: "pr", status: "merged" });
  const epic = view({ kind: "epic", children: [merged], plannedChildren: 2 });
  assertEquals(waitReason("merged", epic, fp), null);
  assertEquals(waitReason("converged", epic, fp), null);
});

test("any-change sees nonvolatile fields: settings, engine instance, acknowledgment (self and child)", () => {
  const fp = runFingerprint(view());
  assertEquals(waitReason("any-change", view({ processInstanceKey: "2", processInstanceKeys: ["2"] }), fp), "any-change");
  assertEquals(waitReason("any-change", view({ settings: { ...view().settings, autoMerge: false } }), fp), "any-change");
  assertEquals(waitReason("any-change", view({ acknowledgedAt: "t5" }), fp), "any-change");
  const fpc = runFingerprint(view({ children: [view({ key: "c" })] }));
  assertEquals(waitReason("any-change", view({ children: [view({ key: "c", processInstanceKey: "9" })] }), fpc), "any-change");
});

test("converged: an auto-merge handoff into the merge stage counts as converged", () => {
  const fp = runFingerprint(view());
  for (const status of ["waiting_deps", "waiting_merge", "waiting_lane", "queued", "merging"]) {
    const child = view({ key: "o/r#9", kind: "pr", status });
    assertEquals(waitReason("converged", view({ children: [child] }), fp), "converged");
    assertEquals(waitReason("merged", view({ children: [child] }), fp), null);
  }
  assertEquals(waitReason("converged", view({ children: [view({ key: "o/r#9", kind: "pr", status: "waiting_review" })] }), fp), null);
});
