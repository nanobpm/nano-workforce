// Tests for scripts/release-gate.ts — the Release gate reads only main's own `push` runs (#1085).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { decideGate, type GateRun, renderSummary } from "./release-gate.ts";

const SHA = "a".repeat(40);
const ok = (id: number, name: string) => ({ id, name, status: "completed", conclusion: "success" });
const pending = (id: number, name: string) => ({ id, name, status: "in_progress", conclusion: null });

const mergeGroupGreen: GateRun = {
  id: 1,
  event: "merge_group",
  head_sha: SHA,
  jobs: [ok(10, "typecheck + test (Node)"), ok(11, "whole-repo invariants")],
};

test("(a) merge_group success with the push CI run pending → no release", () => {
  const runs: GateRun[] = [
    mergeGroupGreen,
    { id: 2, event: "push", head_sha: SHA, jobs: [pending(20, "typecheck + test (Node)")] },
    { id: 3, event: "push", head_sha: SHA, jobs: [ok(30, "whole-repo invariants")] },
  ];
  const d = decideGate(SHA, runs);
  assertEquals(d.release, false);
  assertEquals(d.checks[0]?.state, "pending");
});

test("(b) merge_group success with the push run missing → no release", () => {
  const d = decideGate(SHA, [mergeGroupGreen, { id: 3, event: "push", head_sha: SHA, jobs: [ok(30, "whole-repo invariants")] }]);
  assertEquals(d.release, false);
  assertEquals(d.checks[0]?.state, "missing");
});

test("(c) both push checks successful → release", () => {
  const runs: GateRun[] = [
    { id: 2, event: "push", head_sha: SHA, jobs: [ok(20, "typecheck + test (Node)")] },
    { id: 3, event: "push", head_sha: SHA, jobs: [ok(30, "whole-repo invariants")] },
  ];
  assertEquals(decideGate(SHA, runs).release, true);
});

test("(d) a re-run → the latest job is used (both directions)", () => {
  const failedThenGreen: GateRun[] = [
    { id: 2, event: "push", head_sha: SHA, jobs: [{ id: 20, name: "typecheck + test (Node)", status: "completed", conclusion: "failure" }] },
    { id: 4, event: "push", head_sha: SHA, jobs: [ok(40, "typecheck + test (Node)")] },
    { id: 3, event: "push", head_sha: SHA, jobs: [ok(30, "whole-repo invariants")] },
  ];
  assertEquals(decideGate(SHA, failedThenGreen).release, true);
  const greenThenRerunning: GateRun[] = [
    { id: 2, event: "push", head_sha: SHA, jobs: [ok(20, "typecheck + test (Node)"), pending(50, "typecheck + test (Node)")] },
    { id: 3, event: "push", head_sha: SHA, jobs: [ok(30, "whole-repo invariants")] },
  ];
  assertEquals(decideGate(SHA, greenThenRerunning).release, false);
});

test("push runs for a different SHA never count", () => {
  const runs: GateRun[] = [
    { id: 2, event: "push", head_sha: "b".repeat(40), jobs: [ok(20, "typecheck + test (Node)"), ok(21, "whole-repo invariants")] },
  ];
  assertEquals(decideGate(SHA, runs).release, false);
});

test("summary names the outcome and what it is waiting on", () => {
  const s = renderSummary(SHA, decideGate(SHA, [mergeGroupGreen]));
  assert(s.includes("NOT releasing"));
  assert(s.includes("`typecheck + test (Node)` (missing)"));
  const g = renderSummary(SHA, { release: true, checks: [] });
  assert(g.includes("proceeding to semantic-release"));
});

test("workflow_dispatch recovery: no push run → merge_group jobs count", () => {
  const d = decideGate(SHA, [mergeGroupGreen], undefined, { mergeGroupFallback: true });
  assertEquals(d.release, true);
  assertEquals(d.source, "merge_group");
  assert(renderSummary(SHA, d).includes("Manual dispatch fallback"));
});

test("workflow_dispatch recovery never overrides an existing push run", () => {
  const runs: GateRun[] = [mergeGroupGreen, { id: 2, event: "push", head_sha: SHA, jobs: [pending(20, "typecheck + test (Node)")] }];
  const d = decideGate(SHA, runs, undefined, { mergeGroupFallback: true });
  assertEquals(d.release, false);
  assertEquals(d.source, "push");
});

test("automatic triggers (no fallback) never count merge_group", () => {
  assertEquals(decideGate(SHA, [mergeGroupGreen]).release, false);
});
