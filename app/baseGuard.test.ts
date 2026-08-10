// Unit tests for the dead-end-base guard decision (#60).
import { assertEquals } from "jsr:@std/assert@1";
import { type BaseTarget, isDeadEndBase } from "./baseGuard.ts";

const t = (base: string, defaultBranch: string, landed: BaseTarget["landed"]): BaseTarget => ({
  base,
  defaultBranch,
  landed,
});

Deno.test("dead-end: a non-default base that has already landed", () => {
  // The exact #54 case: base 'feat/coordination-blackboard' merged to 'main' but wasn't deleted.
  assertEquals(isDeadEndBase(t("feat/coordination-blackboard", "main", "landed")), true);
});

Deno.test("NOT a dead-end: the base IS the default branch (the common straight-to-main PR)", () => {
  // Even if a same-named 'main' somehow reported landed, a PR targeting the default branch is the
  // normal terminal target — never a dead-end.
  assertEquals(isDeadEndBase(t("main", "main", "landed")), false);
});

Deno.test("NOT a dead-end: a live stacked base whose PR is still open", () => {
  assertEquals(isDeadEndBase(t("feat/tier2", "main", "open")), false);
});

Deno.test("NOT a dead-end on ambiguity: base has no PR / transport couldn't tell (unknown)", () => {
  // We block only on a positive `landed` signal, so a legitimately-stacked feature branch that
  // simply has no PR yet is never wrongly held.
  assertEquals(isDeadEndBase(t("feat/tier2", "main", "unknown")), false);
});

Deno.test("unknown-safe: blank base or blank default is never a dead-end", () => {
  assertEquals(isDeadEndBase(t("", "main", "landed")), false);
  assertEquals(isDeadEndBase(t("feat/x", "", "landed")), false);
});
