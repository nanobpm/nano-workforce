// Contract for the review-wait liveness policy — the ISO-8601 timeout validation handed to the
// process's timer catch, and the Copilot re-request nudge cooldown. Both are env-driven, so a
// blank/malformed operator value must fall back to a sane default rather than deploy an
// uninterpretable timer or a runaway nudge interval. Run with `deno test -A`.
import { assertEquals } from "jsr:@std/assert@1";
import {
  clampNudgeMinutes,
  DEFAULT_REVIEW_NUDGE_MINUTES,
  DEFAULT_REVIEW_WAIT_TIMEOUT,
  MAX_REVIEW_NUDGE_MINUTES,
  reviewWaitTimeout,
} from "./reviewWait.ts";

Deno.test("reviewWaitTimeout: blank / absent / malformed → default", () => {
  assertEquals(reviewWaitTimeout(undefined), DEFAULT_REVIEW_WAIT_TIMEOUT);
  assertEquals(reviewWaitTimeout(""), DEFAULT_REVIEW_WAIT_TIMEOUT);
  assertEquals(reviewWaitTimeout("   "), DEFAULT_REVIEW_WAIT_TIMEOUT);
  assertEquals(reviewWaitTimeout("20m"), DEFAULT_REVIEW_WAIT_TIMEOUT); // missing leading P/T
  assertEquals(reviewWaitTimeout("P"), DEFAULT_REVIEW_WAIT_TIMEOUT); // no component
  assertEquals(reviewWaitTimeout("PT"), DEFAULT_REVIEW_WAIT_TIMEOUT); // T with no time component
  assertEquals(reviewWaitTimeout("garbage"), DEFAULT_REVIEW_WAIT_TIMEOUT);
});

Deno.test("reviewWaitTimeout: a valid ISO-8601 duration is honoured and upper-cased", () => {
  assertEquals(reviewWaitTimeout("PT30M"), "PT30M");
  assertEquals(reviewWaitTimeout("pt30m"), "PT30M");
  assertEquals(reviewWaitTimeout(" PT1H30M "), "PT1H30M");
  assertEquals(reviewWaitTimeout("PT45S"), "PT45S");
  assertEquals(reviewWaitTimeout("P1D"), "P1D");
  assertEquals(reviewWaitTimeout("P1DT2H"), "P1DT2H");
});

Deno.test("reviewWaitTimeout: a custom fallback is used when the value is invalid", () => {
  assertEquals(reviewWaitTimeout("nope", "PT10M"), "PT10M");
  assertEquals(reviewWaitTimeout(undefined, "PT10M"), "PT10M");
});

Deno.test("clampNudgeMinutes: blank / absent / non-numeric → fallback", () => {
  assertEquals(clampNudgeMinutes(""), DEFAULT_REVIEW_NUDGE_MINUTES);
  assertEquals(clampNudgeMinutes("   "), DEFAULT_REVIEW_NUDGE_MINUTES);
  assertEquals(clampNudgeMinutes(undefined), DEFAULT_REVIEW_NUDGE_MINUTES);
  assertEquals(clampNudgeMinutes(null), DEFAULT_REVIEW_NUDGE_MINUTES);
  assertEquals(clampNudgeMinutes("abc"), DEFAULT_REVIEW_NUDGE_MINUTES);
  assertEquals(clampNudgeMinutes(NaN), DEFAULT_REVIEW_NUDGE_MINUTES);
});

Deno.test("clampNudgeMinutes: a valid positive value (string or number) is honoured", () => {
  assertEquals(clampNudgeMinutes("10"), 10);
  assertEquals(clampNudgeMinutes(15), 15);
  assertEquals(clampNudgeMinutes(" 7 "), 7);
});

Deno.test("clampNudgeMinutes: fractional values are truncated", () => {
  assertEquals(clampNudgeMinutes("5.9"), 5);
  assertEquals(clampNudgeMinutes(3.2), 3);
});

Deno.test("clampNudgeMinutes: zero and negatives fall back (a 0 cooldown would hammer the API)", () => {
  assertEquals(clampNudgeMinutes(0), DEFAULT_REVIEW_NUDGE_MINUTES);
  assertEquals(clampNudgeMinutes("-4"), DEFAULT_REVIEW_NUDGE_MINUTES);
});

Deno.test("clampNudgeMinutes: above the ceiling is clamped, not rejected", () => {
  assertEquals(clampNudgeMinutes(100_000), MAX_REVIEW_NUDGE_MINUTES);
  assertEquals(clampNudgeMinutes(String(MAX_REVIEW_NUDGE_MINUTES + 1)), MAX_REVIEW_NUDGE_MINUTES);
});

Deno.test("clampNudgeMinutes: an oversized fallback is itself clamped to the ceiling", () => {
  assertEquals(clampNudgeMinutes("", MAX_REVIEW_NUDGE_MINUTES + 50), MAX_REVIEW_NUDGE_MINUTES);
});
