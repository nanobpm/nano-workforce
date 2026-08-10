// Red/green regression for D6's pure merge-train lane planner.
import { assertEquals } from "jsr:@std/assert@1";
import { planLane, planPrLane, taskDependencyDepths } from "./mergeTrain.ts";

const taskToPr = new Map([
  ["gap-2", "o/r#2"],
  ["gap-8", "o/r#8"],
  ["gap-9", "o/r#9"],
  ["gap-10", "o/r#10"],
]);

Deno.test("planLane: dependency depth then task id picks the single lane head", () => {
  const depth = new Map([["gap-8", 2], ["gap-2", 0], ["gap-9", 0]]);
  assertEquals(planLane(["gap-8", "gap-9", "gap-2"], taskToPr, new Set(), depth), {
    headTaskId: "gap-2",
    headPrKey: "o/r#2",
    heldTaskIds: ["gap-9", "gap-8"],
    heldPrKeys: ["o/r#9", "o/r#8"],
  });
});

Deno.test("taskDependencyDepths: longest dependency path determines landing order depth", () => {
  const depths = taskDependencyDepths([
    { task_id: "b", depends_on_task_id: "a" },
    { task_id: "c", depends_on_task_id: "b" },
    { task_id: "d", depends_on_task_id: "a" },
    { task_id: "e", depends_on_task_id: "c" },
    { task_id: "e", depends_on_task_id: "d" },
  ]);
  assertEquals([depths.get("a"), depths.get("b"), depths.get("c"), depths.get("d"), depths.get("e")], [
    0,
    1,
    2,
    1,
    3,
  ]);
});

Deno.test("planLane: task id is the deterministic tiebreaker", () => {
  assertEquals(planLane(["gap-9", "gap-2", "gap-8"], taskToPr, new Set()), {
    headTaskId: "gap-2",
    headPrKey: "o/r#2",
    heldTaskIds: ["gap-8", "gap-9"],
    heldPrKeys: ["o/r#8", "o/r#9"],
  });
});

Deno.test("planLane: already-merged head advances to the next unmerged member", () => {
  assertEquals(planLane(["gap-2", "gap-8", "gap-9"], taskToPr, new Set(["o/r#2"])), {
    headTaskId: "gap-8",
    headPrKey: "o/r#8",
    heldTaskIds: ["gap-9"],
    heldPrKeys: ["o/r#9"],
  });
});

Deno.test("planLane: single-member lanes never hold their PR", () => {
  assertEquals(planLane(["gap-10"], taskToPr, new Set()), {
    headTaskId: null,
    headPrKey: null,
    heldTaskIds: [],
    heldPrKeys: [],
  });
});

Deno.test("planLane: tasks without PR keys do not block PR-backed members", () => {
  assertEquals(planLane(["scaffold", "gap-2", "gap-8"], taskToPr, new Set()), {
    headTaskId: "gap-2",
    headPrKey: "o/r#2",
    heldTaskIds: ["gap-8"],
    heldPrKeys: ["o/r#8"],
  });
});

Deno.test("planPrLane: held PRs point at the current lane head", () => {
  assertEquals(
    planPrLane([["gap-2", "gap-8"], ["gap-10"]], taskToPr, new Set(), "o/r#8"),
    {
      isHeld: true,
      laneHeadOf: "o/r#2",
      laneHeadTaskId: "gap-2",
      laneTaskIds: ["gap-2", "gap-8"],
    },
  );
});

Deno.test("planPrLane: lane head and PRs outside exclusion lanes are not held", () => {
  assertEquals(planPrLane([["gap-2", "gap-8"], ["gap-10"]], taskToPr, new Set(), "o/r#2").isHeld, false);
  assertEquals(planPrLane([["gap-2", "gap-8"], ["gap-10"]], taskToPr, new Set(), "o/r#10").isHeld, false);
  assertEquals(planPrLane([["gap-2", "gap-8"]], taskToPr, new Set(), "o/r#404").isHeld, false);
});
