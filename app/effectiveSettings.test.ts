// Issue #1059: every start door echoes `effective` — derived from the SEEDED variable map, so the
// echo always equals what the engine instance carries.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { customInstructionsWarnings, deriveEffectiveSettings } from "./effectiveSettings.ts";

test("deriveEffectiveSettings: reads every setting from the seeded variables", () => {
  const eff = deriveEffectiveSettings({
    converge: true,
    autoMerge: false,
    convergeOnly: true,
    maxRounds: 4,
    readinessProbes: [{ kind: "capability", target: "owner/up#1" }],
    autoResolveEscalations: true,
    customInstructions: "be terse",
    baseBranch: "epic/x",
  });
  assertEquals(eff, {
    converge: true,
    autoMerge: false,
    convergeOnly: true,
    maxRounds: 4,
    blockedOn: ["owner/up#1"],
    autoResolveEscalations: true,
    customInstructions: { present: true, length: 8 },
    baseBranch: "epic/x",
  });
});

test("deriveEffectiveSettings: an unseeded setting is null, never a guessed default", () => {
  assertEquals(deriveEffectiveSettings({}), {
    converge: null,
    autoMerge: null,
    convergeOnly: null,
    maxRounds: null,
    blockedOn: null,
    autoResolveEscalations: false,
    customInstructions: { present: false, length: 0 },
    baseBranch: null,
  });
});

test("customInstructionsWarnings: blank is ignored, padding is trimmed", () => {
  assertEquals(customInstructionsWarnings("   ").length, 1);
  assertEquals(customInstructionsWarnings(" x ").length, 1);
  assertEquals(customInstructionsWarnings("x"), []);
  assertEquals(customInstructionsWarnings(undefined), []);
});

test("deriveEffectiveSettings: blockedOn redacts credential-bearing probe targets (never echoes raw secrets)", () => {
  const eff = deriveEffectiveSettings({
    readinessProbes: [
      { kind: "command", target: "curl -H 'Authorization: token s3cret' x" },
      { kind: "http", target: "https://user:s3cret@example.com/health" },
      { target: "opaque-s3cret" },
      { kind: "capability", target: "owner/up#1" },
    ],
  });
  const shown = eff.blockedOn ?? [];
  assertEquals(shown.length, 4);
  assertEquals(shown.some((t) => t.includes("s3cret")), false);
  assertEquals(shown[0], "<redacted>");
  assertEquals(shown[2], "<redacted>");
  assertEquals(shown[3], "owner/up#1");
});
