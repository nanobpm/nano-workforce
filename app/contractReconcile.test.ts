// Unit tests for the contract reconciliation pass (issue #227, ADR 0004).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { Contract } from "./contracts.ts";
import {
  formatReconciliationReport,
  reconcileContracts,
  reconcileRegistry,
} from "./contractReconcile.ts";

test("reconcileRegistry: the committed registry reconciles clean (no synonyms/contradictions)", () => {
  assertEquals(reconcileRegistry(), []);
});

test("reconcileRegistry: two same-category entries with equivalent semantics are flagged as synonyms", () => {
  const contracts: Contract[] = [
    { category: "env", name: "NANO_A_URL", owner: "a", semantics: "externally reachable base url agents use to reach this app" },
    { category: "env", name: "NANO_B_URL", owner: "b", semantics: "externally reachable base url agents use to reach this app" },
  ];
  const findings = reconcileRegistry(contracts);
  assertEquals(findings.length, 1, "one symmetric synonym pair, reported once");
  assertEquals(findings[0].kind, "synonym");
  assertEquals(findings[0].names.sort(), ["NANO_A_URL", "NANO_B_URL"]);
});

test("reconcileContracts: an in-flight signal for a contract not in the registry is mock-vs-real skew", () => {
  const report = reconcileContracts([
    { authorTask: "task-x", category: "env", name: "NANO_GHOST", body: "some new key nobody landed" },
  ]);
  assert(
    report.findings.some((f) => f.kind === "mock-vs-real-skew" && f.names.includes("NANO_GHOST")),
    "a signalled contract absent from the durable registry must be flagged as skew",
  );
});

test("reconcileContracts: a signal reintroducing a rejected synonym is flagged", () => {
  const report = reconcileContracts([
    { authorTask: "task-y", category: "env", name: "NANO_PR_BASE_URL", body: "the base url" },
  ]);
  assert(
    report.findings.some((f) => f.kind === "rejected-synonym"),
    "a rejected synonym signalled on the blackboard must be reconciled",
  );
});

test("reconcileContracts: a signal for an existing registry contract, reused correctly, is clean of skew", () => {
  const report = reconcileContracts([
    {
      authorTask: "task-z",
      category: "env",
      name: "NANO_PR_PUBLIC_BASE_URL",
      body: "Externally-reachable base URL agents use to reach this app; drives every plan's blackboard capability URL.",
    },
  ]);
  assertEquals(report.findings.filter((f) => f.kind === "mock-vs-real-skew"), []);
});

test("formatReconciliationReport: clean report reads clean, dirty report lists findings", () => {
  assert(formatReconciliationReport({ findings: [], clean: true }).includes("no synonyms"));
  const dirty = formatReconciliationReport({
    findings: [{ kind: "synonym", detail: "x looks like y", names: ["x", "y"], source: "registry" }],
    clean: false,
  });
  assert(dirty.includes("1 issue"));
  assert(dirty.includes("[synonym]"));
});
