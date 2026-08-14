// Unit tests for the durable contract registry + typed env schema (issue #227, ADR 0004).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  allContracts,
  detectDeclarationConflicts,
  ENV_CONTRACTS,
  envContract,
  readEnv,
  readEnvOr,
  rejectedEnvSynonyms,
} from "./contracts.ts";

test("readEnv: trims, treats blank/whitespace as unset, reads the injected env", () => {
  assertEquals(readEnv("NANO_PR_PUBLIC_BASE_URL", { NANO_PR_PUBLIC_BASE_URL: "  https://x  " }), "https://x");
  assertEquals(readEnv("NANO_PR_PUBLIC_BASE_URL", { NANO_PR_PUBLIC_BASE_URL: "   " }), undefined);
  assertEquals(readEnv("NANO_PR_PUBLIC_BASE_URL", {}), undefined);
});

test("readEnvOr: falls back to the registry default, then to the given fallback", () => {
  assertEquals(readEnvOr("NANO_PR_PUBLIC_BASE_URL", "x", {}), "http://localhost:3000");
  assertEquals(readEnvOr("NANO_PR_PUBLIC_BASE_URL", "x", { NANO_PR_PUBLIC_BASE_URL: "https://y" }), "https://y");
  // A key with no registered default falls through to the caller's fallback.
  assertEquals(readEnvOr("NANO_ESCALATION_SLA_TIMEOUT", "PT24H", {}), "PT24H");
});

test("rejectedEnvSynonyms: maps the retired NANO_PR_BASE_URL to its canonical key (#223)", () => {
  const rejected = rejectedEnvSynonyms();
  assertEquals(rejected.get("NANO_PR_BASE_URL"), "NANO_PR_PUBLIC_BASE_URL");
});

test("envContract: exposes owner + semantics + default for a declared key", () => {
  const c = envContract("NANO_PR_PUBLIC_BASE_URL");
  assertEquals(c.name, "NANO_PR_PUBLIC_BASE_URL");
  assertEquals(c.default, "http://localhost:3000");
  assert(c.semantics.length > 0, "an env contract must carry semantics");
});

test("allContracts: includes env, wire, type, and capability-url entries", () => {
  const cats = new Set(allContracts().map((c) => c.category));
  for (const cat of ["env", "wire", "type", "capability-url"] as const) {
    assert(cats.has(cat), `registry must carry a ${cat} contract`);
  }
});

test("detectDeclarationConflicts: a differently-named env key with equivalent semantics is a synonym", () => {
  const conflicts = detectDeclarationConflicts({
    category: "env",
    name: "NANO_PR_EXTERNAL_BASE_URL",
    semantics:
      "Externally-reachable base URL agents use to reach this app; drives every plan's blackboard capability URL.",
  });
  assert(
    conflicts.some((c) => c.kind === "synonym" && c.existingName === "NANO_PR_PUBLIC_BASE_URL"),
    "a semantically-equivalent env key must be flagged as a synonym of the existing one",
  );
});

test("detectDeclarationConflicts: the same name with different semantics is a contradiction", () => {
  const conflicts = detectDeclarationConflicts({
    category: "env",
    name: "NANO_PR_POLL_MS",
    semantics: "completely unrelated meaning about widget colours and fonts",
  });
  assert(
    conflicts.some((c) => c.kind === "contradiction"),
    "a redeclaration of an existing name with different semantics must contradict",
  );
});

test("detectDeclarationConflicts: a retired synonym is flagged as rejected-synonym", () => {
  const conflicts = detectDeclarationConflicts({
    category: "env",
    name: "NANO_PR_BASE_URL",
    semantics: "the base url",
  });
  assertEquals(conflicts[0].kind, "rejected-synonym");
  assertEquals(conflicts[0].existingName, "NANO_PR_PUBLIC_BASE_URL");
});

test("detectDeclarationConflicts: a genuinely new, distinct contract is clean", () => {
  const conflicts = detectDeclarationConflicts({
    category: "env",
    name: "NANO_WIDGET_TIMEOUT",
    semantics: "milliseconds a widget waits before giving up on a render",
  });
  assertEquals(conflicts, []);
});

test("every declared env key's registry name matches its key (no internal drift)", () => {
  for (const [key, value] of Object.entries(ENV_CONTRACTS)) {
    assertEquals(value.name, key, `ENV_CONTRACTS['${key}'].name must equal its key`);
  }
});
