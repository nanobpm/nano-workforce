// Unit coverage for the cross-repo capability-edge helpers (app/capabilityNeed.ts, issue #289).
//
// The gate wiring is proven through the process; these tests pin the pure surface: tolerant need
// parsing + de-dupe, the handle → releases-repo derivation, the need → readiness-gate input mapping
// (reusing the #274 `capability` probe verbatim), the gate-key shape, and the late-bind prompt brief.
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "#test-assert";
import {
  type CapabilityNeed,
  capabilityGateKey,
  capabilityNeedToProbeInput,
  capabilityRefNumber,
  capabilityReleasesRepo,
  parseCapabilityNeed,
  parseCapabilityNeeds,
  renderResolvedDepsBrief,
  UnresolvableCapabilityRefError,
} from "./capabilityNeed.ts";

// ── parseCapabilityNeed / parseCapabilityNeeds ───────────────────────────────────────────────────

test("parseCapabilityNeed: a well-formed need round-trips its fields", () => {
  const need = parseCapabilityNeed({
    capabilityRef: "nanobpm/nano-ide#274",
    package: "@nanobpm/urban",
    verifyCommand: "node -e 0",
  });
  assertEquals(need, {
    capabilityRef: "nanobpm/nano-ide#274",
    package: "@nanobpm/urban",
    verifyCommand: "node -e 0",
  });
});

test("parseCapabilityNeed: verifyCommand is dropped when blank (deterministic-only edge)", () => {
  const need = parseCapabilityNeed({ capabilityRef: "#274", package: "@nanobpm/urban", verifyCommand: "  " });
  assertEquals(need, { capabilityRef: "#274", package: "@nanobpm/urban" });
});

test("parseCapabilityNeed: a blank capabilityRef or package is dropped (unusable, never throws)", () => {
  assertEquals(parseCapabilityNeed({ capabilityRef: "  ", package: "@nanobpm/urban" }), null);
  assertEquals(parseCapabilityNeed({ capabilityRef: "#274", package: "" }), null);
  assertEquals(parseCapabilityNeed(null), null);
  assertEquals(parseCapabilityNeed("nope"), null);
});

test("parseCapabilityNeeds: drops malformed entries and de-dupes on capabilityRef@package", () => {
  const needs = parseCapabilityNeeds([
    { capabilityRef: "owner/repo#1", package: "@nanobpm/urban" },
    { capabilityRef: "owner/repo#1", package: "@nanobpm/urban" }, // dup
    { capabilityRef: "owner/repo#1", package: "@nanobpm/agentic" }, // different package, kept
    { capabilityRef: "  ", package: "@x" }, // malformed
    "garbage",
  ]);
  assertEquals(needs.length, 2);
  assertEquals(needs[0], { capabilityRef: "owner/repo#1", package: "@nanobpm/urban" });
  assertEquals(needs[1], { capabilityRef: "owner/repo#1", package: "@nanobpm/agentic" });
});

test("parseCapabilityNeeds: a non-array is []", () => {
  assertEquals(parseCapabilityNeeds(undefined), []);
  assertEquals(parseCapabilityNeeds({}), []);
});

// ── capabilityRefNumber / capabilityReleasesRepo ─────────────────────────────────────────────────

test("capabilityRefNumber: extracts the trailing number from any handle form", () => {
  assertEquals(capabilityRefNumber("nanobpm/nano-ide#274"), "274");
  assertEquals(capabilityRefNumber("nano-ide#274"), "274");
  assertEquals(capabilityRefNumber("#274"), "274");
  assertEquals(capabilityRefNumber("274"), "274");
  assertEquals(capabilityRefNumber("no-number-here"), undefined);
});

test("capabilityReleasesRepo: owner/repo prefix yields the releases source, bare/short forms yield undefined", () => {
  assertEquals(capabilityReleasesRepo("nanobpm/nano-ide#274"), "nanobpm/nano-ide");
  assertEquals(capabilityReleasesRepo("nano-ide#274"), undefined);
  assertEquals(capabilityReleasesRepo("#274"), undefined);
  assertEquals(capabilityReleasesRepo("a/b/c#1"), undefined);
});

// ── capabilityGateKey ────────────────────────────────────────────────────────────────────────────

test("capabilityGateKey: <planKey>:<taskId>:<capabilityRef>:<package> (stable across a resume)", () => {
  assertEquals(
    capabilityGateKey("owner/repo#289", "issue-289", "nanobpm/nano-ide#274", "@nanobpm/urban"),
    "owner/repo#289:issue-289:nanobpm/nano-ide#274:@nanobpm/urban",
  );
});

test("capabilityGateKey: same capabilityRef, different package → distinct keys (no gate collision)", () => {
  const a = capabilityGateKey("owner/repo#289", "issue-289", "nanobpm/nano-ide#274", "@nanobpm/urban");
  const b = capabilityGateKey("owner/repo#289", "issue-289", "nanobpm/nano-ide#274", "@nanobpm/urban-testkit");
  assertEquals(a === b, false);
});

// ── capabilityNeedToProbeInput ───────────────────────────────────────────────────────────────────

test("capabilityNeedToProbeInput: maps a need to the readiness-gate capability probe input", () => {
  const need: CapabilityNeed = {
    capabilityRef: "nanobpm/nano-ide#274",
    package: "@nanobpm/urban",
    verifyCommand: "verify.sh",
  };
  const input = capabilityNeedToProbeInput(need, {
    planKey: "owner/repo#289",
    taskId: "issue-289",
    probeTimeout: "PT12H",
    probePollEvery: "PT15S",
  });
  assertEquals(input.gateKey, "owner/repo#289:issue-289:nanobpm/nano-ide#274:@nanobpm/urban");
  assertEquals(input.probeTimeout, "PT12H");
  assertEquals(input.probePollEvery, "PT15S");
  assertEquals(input.onTimeout, "escalate");
  assertEquals(input.probe.kind, "capability");
  assertEquals(input.probe.target, "github-releases:nanobpm/nano-ide");
  assertEquals(input.probe.onTimeout, "escalate");
  assertEquals(input.probe.match?.capabilityRef, "nanobpm/nano-ide#274");
  assertEquals(input.probe.match?.package, "@nanobpm/urban");
  assertEquals(input.probe.match?.verifyCommand, "verify.sh");
});

test("capabilityNeedToProbeInput: omits verifyCommand when the need has none", () => {
  const input = capabilityNeedToProbeInput(
    { capabilityRef: "nanobpm/nano-ide#274", package: "@nanobpm/urban" },
    { planKey: "o/r#1", taskId: "t1", probeTimeout: "PT1H", probePollEvery: "PT15S" },
  );
  assertEquals(input.probe.match?.verifyCommand, undefined);
});

test("capabilityNeedToProbeInput: throws when the handle names no releases source (fail loudly)", () => {
  assertThrows(
    () =>
      capabilityNeedToProbeInput(
        { capabilityRef: "#274", package: "@nanobpm/urban" },
        { planKey: "o/r#1", taskId: "t1", probeTimeout: "PT1H", probePollEvery: "PT15S" },
      ),
    UnresolvableCapabilityRefError,
    "names no owner/repo releases source",
  );
});

// ── renderResolvedDepsBrief ──────────────────────────────────────────────────────────────────────

test("renderResolvedDepsBrief: empty list renders nothing (unconditional concatenation is safe)", () => {
  assertEquals(renderResolvedDepsBrief([]), "");
});

test("renderResolvedDepsBrief: pins each capabilityRef → resolvedArtifact", () => {
  const brief = renderResolvedDepsBrief([
    { capabilityRef: "nanobpm/nano-ide#274", resolvedArtifact: "@nanobpm/urban@0.54.0" },
    { capabilityRef: "nanobpm/nano-ide#280", resolvedArtifact: "@nanobpm/agentic@0.9.0" },
  ]);
  assert(brief.startsWith("\n\n---\n"));
  assertStringIncludes(brief, "`nanobpm/nano-ide#274` → `@nanobpm/urban@0.54.0`");
  assertStringIncludes(brief, "`nanobpm/nano-ide#280` → `@nanobpm/agentic@0.9.0`");
  assertStringIncludes(brief, "pin these EXACT versions");
});
