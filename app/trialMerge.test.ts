// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// biome-ignore-all assist/source/organizeImports: tests keep imports grouped by fixture role.
import { assertEquals } from "jsr:@std/assert@1";
import { shouldRunTrialMerge, trialMergeDecision } from "./trialMerge.ts";

Deno.test("trialMergeDecision only escalates clean-merge suite failures", () => {
  assertEquals(trialMergeDecision("clean"), "proceed");
  assertEquals(trialMergeDecision("merge-conflict"), "proceed");
  assertEquals(trialMergeDecision("suite-failed"), "escalate");
});

Deno.test("shouldRunTrialMerge skips lone heads and mergify queues", () => {
  assertEquals(shouldRunTrialMerge(0, { land: { method: "gh-merge" } }), false);
  assertEquals(shouldRunTrialMerge(1, { land: { method: "gh-merge" } }), false);
  assertEquals(shouldRunTrialMerge(2, { land: { method: "mergify-queue" } }), false);
  assertEquals(shouldRunTrialMerge(2, { land: { method: "gh-merge" } }), true);
});
