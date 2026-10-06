// Unit coverage for the agent-task liveness SLA duration policy. The value is baked into every
// merge-loop instance's `agentSlaTimeout` process variable and evaluated by the rebase / fix-ci
// agent tasks' interrupting timer boundary, so a malformed operator env must never deploy an
// uninterpretable `<bpmn:timeDuration>` — it falls back to the default instead. Run with
// `node --test`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { agentSlaTimeout, DEFAULT_AGENT_SLA_TIMEOUT } from "./agentSla.ts";
import { readEnv } from "./contracts.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENT_SLA_SOURCE = readFileSync(join(REPO_ROOT, "app", "agentSla.ts"), "utf8");

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

test("the canonical constant reads NANO_PR_AGENT_SLA_TIMEOUT through the ONE typed env schema", () => {
  // Regression for review r3 (PR #864): the constant must go through `readEnv` (the typed
  // ENV_CONTRACTS reader), not a raw `process.env` lookup. `readEnv` trims and collapses a
  // blank/whitespace value to `undefined`, so this composition is only blank-safe when the constant
  // is built from `readEnv(...)` — a raw `process.env.NANO_PR_AGENT_SLA_TIMEOUT` would pass the
  // untrimmed blank straight through. (The synonym/typo rejection is the compile-time half, pinned
  // by `npm run check:contracts`; this pins the runtime half.)
  assert.equal(agentSlaTimeout(readEnv("NANO_PR_AGENT_SLA_TIMEOUT", {})), DEFAULT_AGENT_SLA_TIMEOUT);
  assert.equal(
    agentSlaTimeout(readEnv("NANO_PR_AGENT_SLA_TIMEOUT", { NANO_PR_AGENT_SLA_TIMEOUT: "   " })),
    DEFAULT_AGENT_SLA_TIMEOUT,
    "a blank env value collapses to undefined → default, never an uninterpretable timer",
  );
  assert.equal(
    agentSlaTimeout(readEnv("NANO_PR_AGENT_SLA_TIMEOUT", { NANO_PR_AGENT_SLA_TIMEOUT: "  pt90m  " })),
    "PT90M",
    "a valid operator override is trimmed, validated, and honoured",
  );
});

test("SOURCE GUARD: AGENT_SLA_TIMEOUT is built from readEnv, never a raw process.env read", () => {
  // Regression for review r8 (PR #864, "Previously missed"): the composition test above recomputes
  // `agentSlaTimeout(readEnv(...))` inline, so it stays green even if the exported constant regresses
  // to `agentSlaTimeout(process.env.NANO_PR_AGENT_SLA_TIMEOUT)` — a raw read that bypasses the typed
  // schema's trim/blank-collapse AND the compile-time synonym/typo check. `AGENT_SLA_TIMEOUT` is
  // frozen once at import time, so a same-process test cannot re-drive it with a controlled env; the
  // deterministic guard is source-level. Pin both halves: (1) no raw `process.env` read of the key
  // anywhere in the module, and (2) the constant is composed from the typed `readEnv` reader.
  assert.equal(
    AGENT_SLA_SOURCE.includes("process.env.NANO_PR_AGENT_SLA_TIMEOUT"),
    false,
    "agentSla.ts must not read process.env.NANO_PR_AGENT_SLA_TIMEOUT directly — route it through " +
      "readEnv (the ONE typed env schema) so a synonym/typo is a compile-time error",
  );
  assert.match(
    AGENT_SLA_SOURCE,
    /AGENT_SLA_TIMEOUT\s*=\s*agentSlaTimeout\(\s*readEnv\(\s*"NANO_PR_AGENT_SLA_TIMEOUT"/,
    "AGENT_SLA_TIMEOUT must be composed from readEnv(\"NANO_PR_AGENT_SLA_TIMEOUT\")",
  );
});
