// Derivation-layer guard for the CI-concurrency-cancellation drift class (issue #348).
//
// GitHub's CI concurrency cancels a superseded workflow run while a newer run on the *identical
// head SHA* takes over. Both land in the head's `statusCheckRollup` under the same check name — the
// stale one stamped `CANCELLED`, the live one green. The merge poller's check derivation used to
// count that stale `CANCELLED` as a failing required check, so a PR whose head is actually green
// read as `blocked`, armed `senior:fix-ci`, which honestly pushed nothing and (pre-#348) returned
// `blocked` → a human merge-escalation for a self-healing PR.
//
// The fix collapses the rollup to the NEWEST run per check before classifying, so a superseded
// `CANCELLED` never counts. These are pure unit tests over the exported derivation helpers.

import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { allCheckNames, checkConclusions, failingCheckNames, latestRunPerCheck } from "./github.ts";

test("a CANCELLED run superseded by a newer green run on the same head does not count as failing", () => {
  const rollup = [
    // The superseded run: GitHub CI concurrency cancelled it when a newer run started.
    { name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z", completedAt: "2024-01-01T00:01:00Z" },
    // The live run on the identical head SHA: green.
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z", completedAt: "2024-01-01T00:05:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "the stale CANCELLED must not read as a failing gate");
});

test("every CANCELLED-superseded required check on one head SHA is dropped (the #348 instance)", () => {
  // The exact PR #887 evidence: four required checks each with a superseded CANCELLED + a newer
  // green run on the same head. None must count as failing.
  const names = ["engine-core", "engine-wasm read-model wasm32 type-check", "processos", "server"];
  const rollup = names.flatMap((name) => [
    { name, conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name, conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
  ]);
  assertEquals(failingCheckNames(rollup), [], "no superseded CANCELLED may count as a failing check");
});

test("a genuine failure on the newest run still counts (no false-negative)", () => {
  const rollup = [
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:00:00Z" },
    // Newest run genuinely failed — this must still be reported.
    { name: "engine-core", conclusion: "FAILURE", startedAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), ["engine-core"], "a real failure on the newest run must count");
});

test("a lone CANCELLED with no superseding run still counts (nothing green replaced it)", () => {
  const rollup = [{ name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" }];
  assertEquals(failingCheckNames(rollup), ["engine-core"], "an unsuperseded CANCELLED remains a failing gate");
});

test("ties (missing timestamps) prefer the non-CANCELLED run so the real result wins", () => {
  // GitHub sometimes omits run times; a superseded CANCELLED alongside a completed run must not
  // shadow the real conclusion even when neither carries a timestamp.
  const cancelledFirst = [
    { name: "server", conclusion: "CANCELLED" },
    { name: "server", conclusion: "SUCCESS" },
  ];
  const successFirst = [
    { name: "server", conclusion: "SUCCESS" },
    { name: "server", conclusion: "CANCELLED" },
  ];
  assertEquals(failingCheckNames(cancelledFirst), [], "CANCELLED-first tie resolves to the real (green) result");
  assertEquals(failingCheckNames(successFirst), [], "success-first tie keeps the real (green) result");
});

test("latestRunPerCheck keeps exactly one run per check name (newest)", () => {
  const rollup = [
    { name: "a", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name: "a", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
    { name: "b", conclusion: "FAILURE", startedAt: "2024-01-01T00:00:00Z" },
  ];
  const latest = latestRunPerCheck(rollup);
  assertEquals(latest.length, 2, "one run per distinct check name");
  const a = latest.find((c) => c.name === "a");
  assert(a && a.conclusion === "SUCCESS", "check `a` resolves to its newest (green) run");
});

test("allCheckNames dedupes superseded reruns to a single name", () => {
  const rollup = [
    { name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(allCheckNames(rollup), ["engine-core"], "a superseded rerun must not double-list the check name");
});

test("legacy StatusContext (state + context) supersession is handled by createdAt", () => {
  const rollup = [
    { context: "ci/legacy", state: "ERROR", createdAt: "2024-01-01T00:00:00Z" },
    { context: "ci/legacy", state: "SUCCESS", createdAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "a superseded legacy status context is not a failing gate");
});

// ── Issue #955: same display name, DIFFERENT triggering events — not the same gate ──────────────
//
// One workflow file with both `pull_request` and `push` jobs named `build` puts TWO runs named
// `build` on the same head SHA. They are different gates: the ruleset / branch-protection required
// context gates the `pull_request` run, so a red PR `build` must never be collapsed away by a newer
// green push `build` (camunda/console-api-js#17: the collapse hid the red required check, the merge
// loop classified `waiting`, and `senior:fix-ci` never ran).

test("#955: a red pull_request `build` is not collapsed away by a newer green push `build`", () => {
  const rollup = [
    // The required gate: PR-event run, failed (biome check on CHANGELOG.md), completed 00:41:34Z.
    { name: "build", event: "pull_request", conclusion: "FAILURE", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:41:34Z" },
    // A different gate sharing the display name: push-event run, green, completed 4s later.
    { name: "build", event: "push", conclusion: "SUCCESS", startedAt: "2026-11-12T00:41:30Z", completedAt: "2026-11-12T00:41:38Z" },
  ];
  assertEquals(
    failingCheckNames(rollup),
    ["build"],
    "the red required pull_request run must survive the collapse — a green push job must not satisfy it",
  );
  assertEquals(
    checkConclusions(rollup).build,
    "FAILURE",
    "the gate's conclusion is the red pull_request run's, so requiredChecksVerdict sees the failure",
  );
});

test("#955: the #348 collapse still holds WITHIN one event — a cancelled rerun of the same job collapses", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "CANCELLED", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:31:00Z" },
    { name: "build", event: "pull_request", conclusion: "SUCCESS", startedAt: "2026-11-12T00:32:00Z", completedAt: "2026-11-12T00:35:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "a CANCELLED rerun of the SAME workflow/event still collapses to the newest run");
  assertEquals(checkConclusions(rollup).build, "SUCCESS");
});

test("#955: a green pull_request run does not mask a red push run of the same name (symmetric)", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "SUCCESS", startedAt: "2026-11-12T00:41:30Z", completedAt: "2026-11-12T00:41:38Z" },
    { name: "build", event: "push", conclusion: "FAILURE", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:41:34Z" },
  ];
  assertEquals(failingCheckNames(rollup), ["build"], "any non-superseded failed run of the name fails the gate");
});

test("#955: distinct events keep both runs in latestRunPerCheck (one per gate, not one per name)", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "FAILURE", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", event: "push", conclusion: "SUCCESS", completedAt: "2026-11-12T00:41:38Z" },
  ];
  const latest = latestRunPerCheck(rollup);
  assertEquals(latest.length, 2, "two different gates sharing a name must both survive");
});

test("#955: runs without event identity keep the pre-#955 name-only collapse (legacy shapes unchanged)", () => {
  // A rollup whose entries carry no `event` (older gh, a StatusContext-only head) collapses exactly
  // as before: same name → newest run wins.
  const rollup = [
    { name: "build", conclusion: "FAILURE", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", conclusion: "SUCCESS", completedAt: "2026-11-12T00:41:38Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "no event identity → the name-only #348 collapse is unchanged");
  assertEquals(latestRunPerCheck(rollup).length, 1);
});

test("#955: allCheckNames still reports the display name once when events differ", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "FAILURE", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", event: "push", conclusion: "SUCCESS", completedAt: "2026-11-12T00:41:38Z" },
  ];
  assertEquals(allCheckNames(rollup), ["build"], "presence is by required-context name, not per (name, event) pair");
});
