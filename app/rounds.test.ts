// Contract for clampRounds — the per-submit round-cap coercion. The submit form renders every
// field as a text input (the runtime hardcodes type="text"), so the override arrives as a string
// and a blank field must fall back to the fleet default. Run with `deno test`.
import { assertEquals } from "jsr:@std/assert@1";
import { clampCiFixBudget, clampRounds, MAX_CI_FIX_CEILING, MAX_ROUNDS_CEILING } from "./rounds.ts";

Deno.test("blank / absent / non-numeric → fallback", () => {
  assertEquals(clampRounds("", 20), 20);
  assertEquals(clampRounds("   ", 20), 20);
  assertEquals(clampRounds(undefined, 20), 20);
  assertEquals(clampRounds(null, 20), 20);
  assertEquals(clampRounds("abc", 20), 20);
  assertEquals(clampRounds(NaN, 20), 20);
});

Deno.test("a valid positive value (string or number) is honoured", () => {
  assertEquals(clampRounds("5", 20), 5);
  assertEquals(clampRounds(30, 20), 30);
  assertEquals(clampRounds(" 12 ", 20), 12);
});

Deno.test("fractional values are truncated to a whole round", () => {
  assertEquals(clampRounds("7.9", 20), 7);
  assertEquals(clampRounds(3.2, 20), 3);
});

Deno.test("zero and negatives fall back (a cap < 1 would escalate before round 1)", () => {
  assertEquals(clampRounds(0, 20), 20);
  assertEquals(clampRounds("-4", 20), 20);
});

Deno.test("above the ceiling is clamped, not rejected", () => {
  assertEquals(clampRounds(1000, 20), MAX_ROUNDS_CEILING);
  assertEquals(clampRounds(String(MAX_ROUNDS_CEILING + 1), 20), MAX_ROUNDS_CEILING);
});

Deno.test("an oversized fallback is itself clamped to the ceiling", () => {
  // A blank/invalid input falls back — but the fallback must not bypass the ceiling.
  assertEquals(clampRounds("", MAX_ROUNDS_CEILING + 50), MAX_ROUNDS_CEILING);
  assertEquals(clampRounds("   ", MAX_ROUNDS_CEILING + 1), MAX_ROUNDS_CEILING);
  assertEquals(clampRounds(0, MAX_ROUNDS_CEILING + 999), MAX_ROUNDS_CEILING);
  assertEquals(clampRounds("abc", MAX_ROUNDS_CEILING + 1), MAX_ROUNDS_CEILING);
});

// clampCiFixBudget — the merge stage's CI-fix attempt budget (NANO_PR_MAX_CI_FIX_ROUNDS). Unlike
// clampRounds it ALLOWS 0, because 0 is a meaningful setting: disable auto-fix so a blocked PR
// escalates to a human immediately.
Deno.test("ci-fix budget: blank / non-numeric / negative → fallback", () => {
  assertEquals(clampCiFixBudget("", 3), 3);
  assertEquals(clampCiFixBudget("   ", 3), 3);
  assertEquals(clampCiFixBudget(undefined, 3), 3);
  assertEquals(clampCiFixBudget(null, 3), 3);
  assertEquals(clampCiFixBudget("abc", 3), 3);
  assertEquals(clampCiFixBudget(NaN, 3), 3);
  assertEquals(clampCiFixBudget("-1", 3), 3);
});

Deno.test("ci-fix budget: 0 is honoured (disables auto-fix), unlike clampRounds", () => {
  assertEquals(clampCiFixBudget(0, 3), 0);
  assertEquals(clampCiFixBudget("0", 3), 0);
  // Contrast: the round cap treats 0 as invalid and falls back.
  assertEquals(clampRounds(0, 3), 3);
});

Deno.test("ci-fix budget: a valid positive value is honoured and truncated", () => {
  assertEquals(clampCiFixBudget("5", 3), 5);
  assertEquals(clampCiFixBudget(2, 3), 2);
  assertEquals(clampCiFixBudget("4.8", 3), 4);
});

Deno.test("ci-fix budget: above the ceiling is clamped; oversized fallback too", () => {
  assertEquals(clampCiFixBudget(1000, 3), MAX_CI_FIX_CEILING);
  assertEquals(clampCiFixBudget("", MAX_CI_FIX_CEILING + 5), MAX_CI_FIX_CEILING);
});
