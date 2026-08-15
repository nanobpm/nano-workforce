// Coverage for the config-key SCAN in the contract gate (scripts/check-contracts.ts, PR #229).
//
// The gate is only as strong as the read patterns it recognises. Before this fix it matched only
// dot-access (`process.env.KEY`), so a config-family key smuggled in through the `envVar("KEY")`
// helper or string-literal bracket-access silently bypassed the "must be declared" invariant — which
// is how NANO_PR_WEBHOOK_SECRET / NANO_AGENTIC* stayed undeclared while `check:contracts` passed
// green. These assert `envKeyReads` sees all three patterns so the gate can hold them to the registry.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { envKeyReads } from "./check-contracts.ts";

test("envKeyReads: dot-access is recognised", () => {
  assertEquals(envKeyReads("const x = process.env.NANO_PR_POLL_MS;"), ["NANO_PR_POLL_MS"]);
});

test("envKeyReads: string-literal bracket-access is recognised (double and single quote)", () => {
  assert(envKeyReads('process.env["NANO_PR_WEBHOOK_SECRET"]').includes("NANO_PR_WEBHOOK_SECRET"));
  assert(envKeyReads("process.env['NANO_AGENTIC']").includes("NANO_AGENTIC"));
});

test("envKeyReads: the envVar(\"KEY\") helper is recognised", () => {
  assert(envKeyReads('const s = envVar("NANO_AGENTIC_SECRET") ?? "";').includes("NANO_AGENTIC_SECRET"));
  assert(envKeyReads('envVar( "NANO_WORKFORCE_GIT_SHA" )').includes("NANO_WORKFORCE_GIT_SHA"));
});

test("envKeyReads: catches keys across all patterns in one source", () => {
  const src = [
    "const a = process.env.CAMUNDA_TRANSPORT;",
    'const b = process.env["NANOBPMN_BASE_URL"];',
    'const c = envVar("NANO_WORKFORCE_GIT_SHA");',
  ].join("\n");
  const keys = new Set(envKeyReads(src));
  assert(keys.has("CAMUNDA_TRANSPORT"));
  assert(keys.has("NANOBPMN_BASE_URL"));
  assert(keys.has("NANO_WORKFORCE_GIT_SHA"));
});

test("envKeyReads: a dynamic (non-literal) read is NOT matched", () => {
  // `process.env[name]` (a variable) can't be resolved statically, so it isn't reported.
  assertEquals(envKeyReads("const v = process.env[name];"), []);
});
