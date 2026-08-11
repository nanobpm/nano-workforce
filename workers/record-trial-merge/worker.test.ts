import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler, { parseResult } from "./worker.ts";

function fakeApp() {
  const inserts: Record<string, unknown[]> = { plan_trial_merges: [] };
  const app = {
    data: {
      table(name: string, _key: string) {
        return {
          async find(_q: unknown) {
            return [];
          },
          async insert(row: unknown) {
            (inserts[name] ??= []).push(row);
            return 7;
          },
          async update(_key: unknown, _patch: unknown) {},
        };
      },
    },
    log: noopLog(),
  };
  return { app, inserts };
}

test("record-trial-merge shapes clean results as proceed", async () => {
  const { app, inserts } = fakeApp();
  const out = await handler(
    { key: 11, variables: { planKey: "o/r#69", currentWave: 2, result: "clean", summary: "green" } } as any,
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, false);
  assertEquals(inserts.plan_trial_merges.length, 1);
  assertEquals((inserts.plan_trial_merges[0] as any).result, "clean");
});

test("parseResult trims valid agent result strings", () => {
  assertEquals(parseResult("clean\n"), "clean");
  assertEquals(parseResult(" merge-conflict "), "merge-conflict");
  assertEquals(parseResult("unknown"), "suite-failed");
});

test("record-trial-merge escalates only suite-failed results", async () => {
  const { app } = fakeApp();
  const out = await handler(
    {
      key: 12,
      variables: {
        planKey: "o/r#69",
        currentWave: 3,
        result: "suite-failed",
        summary: "combined test failed",
        failing: ["integration suite"],
      },
    } as any,
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, true);
  assertEquals(out.task, { id: "trial-merge-wave-3", title: "Trial merge gate for wave 3" });
  assertStringIncludes(String(out.question ?? ""), "combined test failed");
  assertStringIncludes(String(out.question ?? ""), "proceed");
});

test("record-trial-merge renders odd failing payloads without throwing", async () => {
  const { app } = fakeApp();
  const out = await handler(
    {
      variables: {
        planKey: "o/r#69",
        result: "suite-failed",
        summary: "combined test failed",
        failing: [1n],
      },
    } as any,
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, true);
  assertStringIncludes(String(out.question ?? ""), "Failing:");
});

test("record-trial-merge treats textual conflicts as pass-through", async () => {
  const { app } = fakeApp();
  const out = await handler(
    { variables: { planKey: "o/r#69", result: "merge-conflict", conflicts: [{ prs: [1, 2] }] } } as any,
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, false);
});
