// Issue #1007: each epic slice PR is converged inside the epic (converge-cell → pr.converge-slice).
import { test } from "node:test";
import type { DataLayer } from "@nanobpm/urban";
import { assertEquals } from "#test-assert";
import type { ParsedPr } from "./prParse.ts";
import { convergeSlice, sliceMergeIntent } from "./sliceConverge.ts";

function memData(stores: Record<string, Record<string, unknown>[]>, keys: Record<string, string>): DataLayer {
  const data = {
    table(name: string) {
      const rows = stores[name] ?? [];
      return {
        get: async (k: unknown) => rows.find((r) => r[keys[name] ?? "id"] === k),
        find: async (q: Record<string, unknown>) => rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)),
      };
    },
  };
  return data as unknown as DataLayer;
}

interface Call {
  prKey: string;
  dependsOn: string[];
  root: string;
  autoResolve: boolean;
  autoMerge: boolean;
}

function recorder() {
  const calls: Call[] = [];
  const submit = async (p: ParsedPr, dependsOn: string[], root: string, autoResolve: boolean, autoMerge: boolean) => {
    calls.push({ prKey: p.prKey, dependsOn, root, autoResolve, autoMerge });
  };
  return { calls, submit };
}

const stores = (autoMerge = 1) => ({
  plans: [{ plan_key: "o/r#1", auto_resolve_escalations: 1, auto_merge: autoMerge }],
  plan_tasks: [
    { plan_key: "o/r#1", task_id: "a", pr_key: "o/r#10" },
    { plan_key: "o/r#1", task_id: "b", pr_key: null },
    { plan_key: "o/r#1", task_id: "c", pr_key: null },
  ],
  plan_task_deps: [
    { plan_key: "o/r#1", task_id: "c", depends_on_task_id: "a" },
    { plan_key: "o/r#1", task_id: "c", depends_on_task_id: "b" },
  ],
});
const keys = { plans: "plan_key", plan_tasks: "id", plan_task_deps: "id" };

test("convergeSlice enrolls the slice PR under the epic with its dependency PRs and the steward opt-in", async () => {
  const { calls, submit } = recorder();
  const res = await convergeSlice(memData(stores(), keys), { planKey: "o/r#1", taskId: "c", prKey: "o/r#12" }, submit);
  assertEquals(res.enrolled, true);
  assertEquals(calls, [{ prKey: "o/r#12", dependsOn: ["o/r#10"], root: "o/r#1", autoResolve: true, autoMerge: true }]);
});

test("convergeSlice reads the merge policy from the durable plans row, not the (clobberable) input variable", async () => {
  // Issue #1007 review (F1): the operator's `autoMerge: false` lives on `plans.auto_merge = 0`. An
  // agent completion echoing `autoMerge: true` into the process scope must NOT re-enable merging —
  // the row is authoritative and overrides the input variable.
  const { calls, submit } = recorder();
  await convergeSlice(memData(stores(0), keys), { planKey: "o/r#1", taskId: "a", prKey: "o/r#10", autoMerge: true }, submit);
  assertEquals(calls[0]?.autoMerge, false, "the durable plans.auto_merge=0 opt-out wins over an agent-echoed autoMerge=true");
});

test("convergeSlice honours an explicit autoMerge=false (converge only)", async () => {
  const { calls, submit } = recorder();
  await convergeSlice(memData(stores(0), keys), { planKey: "o/r#1", taskId: "a", prKey: "o/r#10", autoMerge: false }, submit);
  assertEquals(calls[0]?.autoMerge, false);
  assertEquals(calls[0]?.dependsOn, []);
});

test("convergeSlice falls back to the input intent when the plan row is absent", async () => {
  const { calls, submit } = recorder();
  const data = memData({ plans: [], plan_tasks: [], plan_task_deps: [] }, keys);
  await convergeSlice(data, { planKey: "o/r#1", taskId: "a", prKey: "o/r#10", autoMerge: false }, submit);
  assertEquals(calls[0]?.autoMerge, false);
});

test("convergeSlice never enrolls a phantom PR", async () => {
  const { calls, submit } = recorder();
  const res = await convergeSlice(memData(stores(), keys), { planKey: "o/r#1", taskId: "a", prKey: null }, submit);
  assertEquals(res.enrolled, false);
  assertEquals(calls.length, 0);
});

test("sliceMergeIntent defaults to auto-merge unless explicitly false", () => {
  assertEquals(sliceMergeIntent(undefined), true);
  assertEquals(sliceMergeIntent(null), true);
  assertEquals(sliceMergeIntent(true), true);
  assertEquals(sliceMergeIntent(false), false);
});
