// Unit coverage for `pr.caps-prepare` (issue #289). The worker derives the per-task capability
// barrier key + gate flag from the MI child's `task` (surfaced as `planKey`/`taskId`/`needs` job
// vars), which the model hoists into the child scope so the following gateway + catch can read them.
// The key MUST equal `capabilityTaskBarrierKey` (the host publishes `caps-resolved` on it), and the
// flag MUST reflect whether any VALID need survives the tolerant parse.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { capabilityTaskBarrierKey } from "../../app/capabilityNeed.ts";
import handler from "./worker.ts";

test("caps-prepare: a task with needs yields the barrier key and hasNeeds=true", async () => {
  const out = await handler(
    {
      variables: {
        planKey: "owner/repo#7",
        taskId: "gap-a",
        needs: [{ capabilityRef: "nanobpm/nano-ide#274", package: "@nanobpm/urban" }],
      },
    } as any,
    {} as any,
  );
  assertEquals(out.capsGateKey, capabilityTaskBarrierKey("owner/repo#7", "gap-a"));
  assertEquals(out.capsGateKey, "owner/repo#7:gap-a");
  assertEquals(out.hasNeeds, true);
});

test("caps-prepare: a task with no needs yields hasNeeds=false (takes the no-needs shortcut)", async () => {
  const out = await handler(
    { variables: { planKey: "owner/repo#7", taskId: "gap-b", needs: [] } } as any,
    {} as any,
  );
  assertEquals(out.capsGateKey, "owner/repo#7:gap-b");
  assertEquals(out.hasNeeds, false);
});

test("caps-prepare: a missing/undefined needs list is treated as no needs", async () => {
  const out = await handler(
    { variables: { planKey: "owner/repo#7", taskId: "gap-c" } } as any,
    {} as any,
  );
  assertEquals(out.hasNeeds, false);
});

test("caps-prepare: a malformed need is dropped — only a valid remainder gates the task", async () => {
  const onlyBad = await handler(
    { variables: { planKey: "p", taskId: "t", needs: [{ capabilityRef: "", package: "" }] } } as any,
    {} as any,
  );
  assertEquals(onlyBad.hasNeeds, false, "a wholly-malformed need must not gate the fan-out");

  const mixed = await handler(
    {
      variables: {
        planKey: "p",
        taskId: "t",
        needs: [{ capabilityRef: "", package: "" }, { capabilityRef: "o/r#1", package: "pkg" }],
      },
    } as any,
    {} as any,
  );
  assertEquals(mixed.hasNeeds, true, "a valid need still gates even alongside a malformed one");
});

// Issue #945: the worker also stamps the implement-cell's repository envelope with the slice's
// deterministic `branch.create` (`feat/<task.id>`), emitted as the FLAT dotted process variable the
// c8ctl harness reads (`io.nanobpm.agentTask.branch.create`). Derived via the ONE canonical
// `sliceBranchCreate`, so the envelope, the prompt's branch instruction, and the reconcile lookup share
// a single source. A retry re-derives the SAME branch (it is a pure function of `task.id`), so the
// durable WIP checkpoint restore matches.
test("caps-prepare: stamps the deterministic per-slice branch.create as a flat dotted variable (#945)", async () => {
  const out = await handler(
    { variables: { planKey: "owner/repo#7", taskId: "tool-metadata-engine", needs: [] } } as any,
    {} as any,
  );
  assertEquals(out["io.nanobpm.agentTask.branch.create"], "feat/tool-metadata-engine");
});

test("caps-prepare: an implausible task id omits branch.create (never an unusable ref) (#945)", async () => {
  const out = await handler(
    { variables: { planKey: "owner/repo#7", taskId: "bad..id", needs: [] } } as any,
    {} as any,
  );
  assertEquals("io.nanobpm.agentTask.branch.create" in out, false, "an ill-formed branch degrades to omission");
  // …while the barrier key + gate flag are still emitted (the fan-out is not wedged by a bad id).
  assertEquals(out.capsGateKey, "owner/repo#7:bad..id");
});
