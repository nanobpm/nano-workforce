// Unit coverage for the feature-intake readiness gate desugaring (issue #295).
//
// `parseFeatureReadiness` turns a submitted feature's optional `readiness`/`blockedOn` intake into the
// `readinessProbes` + `probeTimeout` process variables the feature.bpmn preflight runs. These tests
// pin the desugaring: full descriptors round-trip through `parseProbe`, `blockedOn` desugars to
// `capability` probes (with `consumerPackage`) or `command` state probes (fallback), the bound is
// derived, and malformed intake fails loudly at submit.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { parseFeatureReadiness } from "./featureReadiness.ts";

const ENV = { NANO_READINESS_POLL_TIMEOUT: "PT30M" } as Record<string, string | undefined>;

test("parseFeatureReadiness: no intake ⇒ empty probes, null bound (gate skipped)", () => {
  assertEquals(parseFeatureReadiness(undefined, ENV), { probes: [], probeTimeout: null });
  assertEquals(parseFeatureReadiness({}, ENV), { probes: [], probeTimeout: null });
  assertEquals(parseFeatureReadiness({ readiness: [], blockedOn: [] }, ENV), { probes: [], probeTimeout: null });
});

test("parseFeatureReadiness: blockedOn + consumerPackage ⇒ capability probes with derived bound", () => {
  const out = parseFeatureReadiness(
    { blockedOn: ["nanobpm/nano-bpm#631", "nanobpm/nano-bpm#808"], consumerPackage: "@nanobpm/engine-wasm" },
    ENV,
  );
  assertEquals(out.probes.length, 2);
  assertEquals(out.probes[0], {
    kind: "capability",
    target: "github-releases:nanobpm/nano-bpm",
    match: { package: "@nanobpm/engine-wasm", capabilityRef: "nanobpm/nano-bpm#631" },
    onTimeout: "escalate",
  });
  assertEquals(out.probes[1].match?.capabilityRef, "nanobpm/nano-bpm#808");
  // Every derived probe shares the env default, so the bound is that default.
  assertEquals(out.probeTimeout, "PT30M");
});

test("parseFeatureReadiness: blockedOn without consumerPackage ⇒ command state probes (merged-is-enough)", () => {
  const out = parseFeatureReadiness({ blockedOn: ["octo/cat#7"] }, ENV);
  assertEquals(out.probes[0], {
    kind: "command",
    target: "gh api repos/octo/cat/issues/7 --jq .state",
    match: { stdoutIncludes: "closed" },
    onTimeout: "escalate",
  });
  assertEquals(out.probeTimeout, "PT30M");
});

test("parseFeatureReadiness: full readiness descriptors round-trip through parseProbe", () => {
  const out = parseFeatureReadiness(
    {
      readiness: [
        { kind: "http", target: "https://example.test/health", match: { status: 200 } },
        { kind: "command", target: "make ready" },
      ],
    },
    ENV,
  );
  assertEquals(out.probes.length, 2);
  assertEquals(out.probes[0].kind, "http");
  assertEquals(out.probes[0].match?.status, 200);
  assertEquals(out.probes[1].kind, "command");
});

test("parseFeatureReadiness: readiness + blockedOn concatenate", () => {
  const out = parseFeatureReadiness(
    { readiness: [{ kind: "command", target: "make ready" }], blockedOn: ["octo/cat#7"] },
    ENV,
  );
  assertEquals(out.probes.length, 2);
  assertEquals(out.probes[0].kind, "command");
  assertEquals(out.probes[1].target, "gh api repos/octo/cat/issues/7 --jq .state");
});

test("parseFeatureReadiness: a longer per-probe budget wins the derived bound", () => {
  const out = parseFeatureReadiness(
    {
      readiness: [
        { kind: "command", target: "a", poll: { timeoutMs: 60_000 } },
        { kind: "command", target: "b", poll: { timeoutMs: 3_600_000 } },
      ],
    },
    ENV,
  );
  assertEquals(out.probeTimeout, "PT3600S");
});

test("parseFeatureReadiness: a bare repo#N handle is rejected (cannot name a provenance repo)", () => {
  let threw = false;
  try {
    parseFeatureReadiness({ blockedOn: ["nano-bpm#631"], consumerPackage: "@nanobpm/engine-wasm" }, ENV);
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message.includes("owner/repo#123"), true);
  }
  assertEquals(threw, true);
});

test("parseFeatureReadiness: a handle whose repo carries shell metacharacters is rejected (no injection into the command probe)", () => {
  // The `command` fallback interpolates `parsed.repo` into a shell string run via `exec`. `parseIssue`'s
  // `owner/repo#N` branch matches `[^#]+` for the slug, so a crafted handle could smuggle `;`/`$()`/backticks
  // into the readiness worker's shell. Desugaring MUST reject any repo that isn't a valid GitHub slug.
  for (const evil of [
    "octo/cat; rm -rf /#7",
    "octo/cat$(touch pwned)#7",
    "octo/`whoami`#7",
    "octo/cat rm#7",
  ]) {
    let threw = false;
    try {
      parseFeatureReadiness({ blockedOn: [evil] }, ENV);
    } catch (err) {
      threw = true;
      assertEquals((err as Error).message.includes("owner/repo"), true);
    }
    assertEquals(threw, true);
  }
});

test("parseFeatureReadiness: a non-string blockedOn entry is rejected", () => {
  let threw = false;
  try {
    parseFeatureReadiness({ blockedOn: [42] }, ENV);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("parseFeatureReadiness: a blank consumerPackage is rejected", () => {
  let threw = false;
  try {
    parseFeatureReadiness({ blockedOn: ["octo/cat#7"], consumerPackage: "   " }, ENV);
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message.includes("consumerPackage"), true);
  }
  assertEquals(threw, true);
});

test("parseFeatureReadiness: a malformed readiness descriptor fails loudly (unknown kind)", () => {
  let threw = false;
  try {
    parseFeatureReadiness({ readiness: [{ kind: "bogus", target: "x" }] }, ENV);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("parseFeatureReadiness: a non-array readiness/blockedOn is rejected", () => {
  let a = false;
  let b = false;
  try {
    parseFeatureReadiness({ readiness: { kind: "command", target: "x" } }, ENV);
  } catch {
    a = true;
  }
  try {
    parseFeatureReadiness({ blockedOn: "octo/cat#7" }, ENV);
  } catch {
    b = true;
  }
  assertEquals(a, true);
  assertEquals(b, true);
});
