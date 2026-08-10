// Red/green regression for the plan levelizer (issue #20). Run with `deno test`.
//
// One `Deno.test` = one named property of computeWaves. These encode the wave
// contract: independent tasks share wave 0 (all-parallel), a chain steps 0,1,2…
// (all-sequential), a diamond re-converges, and a malformed graph is rejected
// rather than silently mis-levelized.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { computeWaves, WaveError, type WaveGateTask, type WaveTask, waveMergeTargets } from "./waves.ts";

Deno.test("no dependencies → every task in wave 0 (fully parallel)", () => {
  const tasks: WaveTask[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const { waves, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 1);
  assertEquals(waves, [["a", "b", "c"]]);
});

Deno.test("linear chain → one task per wave (fully sequential)", () => {
  const tasks: WaveTask[] = [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
  ];
  const { waves, waveCount, waveOf } = computeWaves(tasks);
  assertEquals(waveCount, 3);
  assertEquals(waves, [["a"], ["b"], ["c"]]);
  assertEquals([waveOf.get("a"), waveOf.get("b"), waveOf.get("c")], [0, 1, 2]);
});

Deno.test("diamond → longest-path level; join waits for both arms", () => {
  const tasks: WaveTask[] = [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["a"] },
    { id: "d", dependsOn: ["b", "c"] },
  ];
  const { waves, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 3);
  assertEquals(waves, [["a"], ["b", "c"], ["d"]]);
});

Deno.test("mixed graph → level is 1 + max(dep level), not 1 + min", () => {
  // e depends on a (wave 0) and d (wave 2) → must land in wave 3, behind the deeper dep.
  const tasks: WaveTask[] = [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
    { id: "d", dependsOn: ["c"] },
    { id: "e", dependsOn: ["a", "d"] },
  ];
  const { waveOf, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 5);
  assertEquals(waveOf.get("e"), 4);
});

Deno.test("empty plan → zero waves", () => {
  const { waves, waveCount } = computeWaves([]);
  assertEquals(waveCount, 0);
  assertEquals(waves, []);
});

Deno.test("blank / whitespace dependsOn entries are ignored", () => {
  const tasks: WaveTask[] = [{ id: "a", dependsOn: ["", "  "] }];
  const { waves, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 1);
  assertEquals(waves, [["a"]]);
});

Deno.test("dependency cycle → WaveError", () => {
  const tasks: WaveTask[] = [
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ];
  assertThrows(() => computeWaves(tasks), WaveError, "cycle");
});

Deno.test("self-dependency → WaveError", () => {
  assertThrows(() => computeWaves([{ id: "a", dependsOn: ["a"] }]), WaveError, "itself");
});

Deno.test("unknown dependency id → WaveError", () => {
  assertThrows(
    () => computeWaves([{ id: "a", dependsOn: ["ghost"] }]),
    WaveError,
    "unknown task",
  );
});

Deno.test("duplicate task id → WaveError", () => {
  assertThrows(
    () => computeWaves([{ id: "a" }, { id: "a" }]),
    WaveError,
    "duplicate",
  );
});

// --- Wave-merge barrier: which PRs must merge for a wave to clear? ---
// `waveMergeTargets` drives the poller's `wave-merged` gate. It must select exactly the
// opened/waiting-with-a-PR tasks of the gate wave, ignore other waves, and treat blocked/skipped
// and keyless tasks as nothing-to-wait-on so no non-mergeable PR state can wedge the barrier.

Deno.test("waveMergeTargets → only opened PRs of the gate wave", () => {
  const tasks: WaveGateTask[] = [
    { wave: 0, status: "opened", pr_key: "o/r#1" },
    { wave: 0, status: "opened", pr_key: "o/r#2" },
    { wave: 1, status: "opened", pr_key: "o/r#9" }, // a later wave — not this gate
  ];
  assertEquals(waveMergeTargets(tasks, 0), ["o/r#1", "o/r#2"]);
});

Deno.test("waveMergeTargets → mergeable waiting tasks are waited on; failed/keyless tasks are not", () => {
  const tasks: WaveGateTask[] = [
    { wave: 0, status: "opened", pr_key: "o/r#1" },
    { wave: 0, status: "blocked", pr_key: null },
    { wave: 0, status: "skipped", pr_key: null },
    { wave: 0, status: "waiting-for-lane", pr_key: "o/r#2" },
    { wave: 0, status: "waiting-for-lane", pr_key: null },
    { wave: 0, status: "opened", pr_key: null }, // opened but no PR key → nothing to merge
  ];
  assertEquals(waveMergeTargets(tasks, 0), ["o/r#1", "o/r#2"]);
});

Deno.test("waveMergeTargets → a wave with no opened PRs clears vacuously (empty)", () => {
  const tasks: WaveGateTask[] = [
    { wave: 0, status: "blocked", pr_key: null },
    { wave: 0, status: "skipped", pr_key: null },
  ];
  assertEquals(waveMergeTargets(tasks, 0), []);
});
