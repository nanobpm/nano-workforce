// Unit coverage for the escalation-of-the-escalation SLA duration policy (U5, #156). The value is
// baked into every plan-fanout instance's `escalationSlaTimeout` process variable and evaluated by
// each escalation user task's interrupting timer boundary, so a malformed operator env must never
// deploy an uninterpretable `<bpmn:timeDuration>` — it falls back to the default instead. Run with
// `node --test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ESCALATION_SLA_TIMEOUT, escalationSlaTimeout } from "./escalationSla.ts";

test("escalationSlaTimeout: blank / absent / malformed → default", () => {
  assert.equal(escalationSlaTimeout(undefined), DEFAULT_ESCALATION_SLA_TIMEOUT);
  assert.equal(escalationSlaTimeout(""), DEFAULT_ESCALATION_SLA_TIMEOUT);
  assert.equal(escalationSlaTimeout("   "), DEFAULT_ESCALATION_SLA_TIMEOUT);
  assert.equal(escalationSlaTimeout("2h"), DEFAULT_ESCALATION_SLA_TIMEOUT); // missing leading P/T
  assert.equal(escalationSlaTimeout("P"), DEFAULT_ESCALATION_SLA_TIMEOUT); // no component
  assert.equal(escalationSlaTimeout("PT"), DEFAULT_ESCALATION_SLA_TIMEOUT); // T with no time part
  assert.equal(escalationSlaTimeout("garbage"), DEFAULT_ESCALATION_SLA_TIMEOUT);
});

test("escalationSlaTimeout: a valid ISO-8601 duration is honoured and upper-cased", () => {
  assert.equal(escalationSlaTimeout("PT30M"), "PT30M");
  assert.equal(escalationSlaTimeout("pt2h"), "PT2H");
  assert.equal(escalationSlaTimeout("P1D"), "P1D");
  assert.equal(escalationSlaTimeout("  pt15m  "), "PT15M");
});

test("escalationSlaTimeout: an explicit fallback is honoured for a bad value", () => {
  assert.equal(escalationSlaTimeout("nope", "PT10M"), "PT10M");
  assert.equal(escalationSlaTimeout("PT45M", "PT10M"), "PT45M");
});

test("the default is itself a well-formed ISO-8601 duration (never an uninterpretable timer)", () => {
  // Validate the default against the grammar with a *distinct* fallback: if the default were
  // malformed it would fall through to the sentinel, so equality to itself proves it parses.
  const sentinel = "PT1S";
  assert.notEqual(DEFAULT_ESCALATION_SLA_TIMEOUT, sentinel);
  assert.equal(escalationSlaTimeout(DEFAULT_ESCALATION_SLA_TIMEOUT, sentinel), DEFAULT_ESCALATION_SLA_TIMEOUT);
});
