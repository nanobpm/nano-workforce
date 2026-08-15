// Unit coverage for the agent-task liveness SLA duration policy. The value is baked into every
// merge-loop instance's `agentSlaTimeout` process variable and evaluated by the rebase / fix-ci
// agent tasks' interrupting timer boundary, so a malformed operator env must never deploy an
// uninterpretable `<bpmn:timeDuration>` — it falls back to the default instead. Run with
// `node --test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentSlaTimeout, DEFAULT_AGENT_SLA_TIMEOUT } from "./agentSla.ts";

test("agentSlaTimeout: blank / absent / malformed → default", () => {
  assert.equal(agentSlaTimeout(undefined), DEFAULT_AGENT_SLA_TIMEOUT);
  assert.equal(agentSlaTimeout(""), DEFAULT_AGENT_SLA_TIMEOUT);
  assert.equal(agentSlaTimeout("   "), DEFAULT_AGENT_SLA_TIMEOUT);
  assert.equal(agentSlaTimeout("2h"), DEFAULT_AGENT_SLA_TIMEOUT); // missing leading P/T
  assert.equal(agentSlaTimeout("P"), DEFAULT_AGENT_SLA_TIMEOUT); // no component
  assert.equal(agentSlaTimeout("PT"), DEFAULT_AGENT_SLA_TIMEOUT); // T with no time part
  assert.equal(agentSlaTimeout("garbage"), DEFAULT_AGENT_SLA_TIMEOUT);
});

test("agentSlaTimeout: a valid ISO-8601 duration is honoured and upper-cased", () => {
  assert.equal(agentSlaTimeout("PT30M"), "PT30M");
  assert.equal(agentSlaTimeout("pt4h"), "PT4H");
  assert.equal(agentSlaTimeout("P1D"), "P1D");
  assert.equal(agentSlaTimeout("  pt90m  "), "PT90M");
});

test("agentSlaTimeout: an explicit fallback is honoured for a bad value", () => {
  assert.equal(agentSlaTimeout("nope", "PT10M"), "PT10M");
  assert.equal(agentSlaTimeout("PT45M", "PT10M"), "PT45M");
});

test("the default is itself a well-formed ISO-8601 duration (never an uninterpretable timer)", () => {
  // Validate the default against the grammar with a *distinct* fallback: if the default were
  // malformed it would fall through to the sentinel, so equality to itself proves it parses.
  const sentinel = "PT1S";
  assert.notEqual(DEFAULT_AGENT_SLA_TIMEOUT, sentinel);
  assert.equal(agentSlaTimeout(DEFAULT_AGENT_SLA_TIMEOUT, sentinel), DEFAULT_AGENT_SLA_TIMEOUT);
});
