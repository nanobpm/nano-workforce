// Unit coverage for `pr.slice-branch` (issue #945): the per-slice deterministic `branch.create`,
// emitted as the FLAT dotted variable the c8ctl harness reads, derived from the ONE canonical
// `sliceBranchCreate`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { AGENT_TASK_BRANCH_CREATE_VAR, sliceBranchCreate } from "../../app/repoEnvelope.ts";
import handler from "./worker.ts";

async function run(task: unknown): Promise<Record<string, unknown>> {
  return (await handler({ variables: { task } } as any, {} as any)) ?? {};
}

test("slice-branch: stamps feat/<task.id> as the flat dotted branch.create (#945)", async () => {
  const out = await run({ id: "t1", prompt: "x" });
  assertEquals(out[AGENT_TASK_BRANCH_CREATE_VAR], "feat/t1");
  assertEquals(out[AGENT_TASK_BRANCH_CREATE_VAR], sliceBranchCreate("t1"));
});

test("slice-branch: distinct slices derive distinct branches (sibling isolation is per-instance) (#945)", async () => {
  const a = await run({ id: "t1" });
  const b = await run({ id: "t2" });
  assertEquals(a[AGENT_TASK_BRANCH_CREATE_VAR], "feat/t1");
  assertEquals(b[AGENT_TASK_BRANCH_CREATE_VAR], "feat/t2");
});

test("slice-branch: a missing/blank/implausible/non-string id emits nothing (#945)", async () => {
  for (const task of [undefined, null, "t1", [], {}, { id: "" }, { id: "  " }, { id: "bad..id" }, { id: 7 }]) {
    const out = await run(task);
    assertEquals(AGENT_TASK_BRANCH_CREATE_VAR in out, false, `no branch.create for ${JSON.stringify(task)}`);
  }
});
