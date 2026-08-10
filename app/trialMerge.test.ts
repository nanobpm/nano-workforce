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
