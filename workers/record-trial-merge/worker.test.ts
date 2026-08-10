import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import handler, { parseResult } from "./worker.ts";

function fakeApp() {
  const inserts: Record<string, unknown[]> = { plan_trial_merges: [] };
  const app = {
    data: {
      table(name: string, _key: string) {
        return {
          // deno-lint-ignore require-await
          async find(_q: unknown) {
            return [];
          },
          // deno-lint-ignore require-await
          async insert(row: unknown) {
            (inserts[name] ??= []).push(row);
            return 7;
          },
          // deno-lint-ignore require-await
          async update(_key: unknown, _patch: unknown) {},
        };
      },
    },
    log: () => undefined,
  };
  return { app, inserts };
}

Deno.test("record-trial-merge shapes clean results as proceed", async () => {
  const { app, inserts } = fakeApp();
  const out = await handler(
    // deno-lint-ignore no-explicit-any
    { key: 11, variables: { planKey: "o/r#69", currentWave: 2, result: "clean", summary: "green" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, false);
  assertEquals(inserts.plan_trial_merges.length, 1);
  // deno-lint-ignore no-explicit-any
  assertEquals((inserts.plan_trial_merges[0] as any).result, "clean");
});

Deno.test("parseResult trims valid agent result strings", () => {
  assertEquals(parseResult("clean\n"), "clean");
  assertEquals(parseResult(" merge-conflict "), "merge-conflict");
  assertEquals(parseResult("unknown"), "suite-failed");
});

Deno.test("record-trial-merge escalates only suite-failed results", async () => {
  const { app } = fakeApp();
  const out = await handler(
    // deno-lint-ignore no-explicit-any
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
    // deno-lint-ignore no-explicit-any
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, true);
  assertEquals(out.task, { id: "trial-merge-wave-3", title: "Trial merge gate for wave 3" });
  assertStringIncludes(String(out.question ?? ""), "combined test failed");
  assertStringIncludes(String(out.question ?? ""), "proceed");
});

Deno.test("record-trial-merge renders odd failing payloads without throwing", async () => {
  const { app } = fakeApp();
  const out = await handler(
    // deno-lint-ignore no-explicit-any
    {
      variables: {
        planKey: "o/r#69",
        result: "suite-failed",
        summary: "combined test failed",
        failing: [1n],
      },
    } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, true);
  assertStringIncludes(String(out.question ?? ""), "Failing:");
});

Deno.test("record-trial-merge treats textual conflicts as pass-through", async () => {
  const { app } = fakeApp();
  const out = await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#69", result: "merge-conflict", conflicts: [{ prs: [1, 2] }] } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.trialMergeRed, false);
});
