// Tests for the demand×supply report (epic #152 / N1 #145). The report is a pure fold over injected
// demand (deployed taskDefinition leaves) + supply (registry rows) resolved through the crew vocab,
// so it needs no live engine or presence store here.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { TaskDefinitionLeaf } from "@nanobpm/agentic/demand";
import type { RegisteredWorker } from "@nanobpm/agentic/vocab";
import { CREW_VOCAB_VERSION } from "./crew-vocab.ts";
import { buildRegistryReport, engineRestAddress, toWireReport } from "./demand-report.ts";

const NOW = new Date(0);
const leaf = (taskType: string): TaskDefinitionLeaf => ({ taskType, process: "p", elementId: taskType });

const plannerFrontier: RegisteredWorker = { instance: "w-front", capability: { cognition: "planning", weight: 5, family: "frontier" } };
const plannerKimi: RegisteredWorker = { instance: "w-kimi", capability: { cognition: "planning", weight: 5, family: "kimi" } };
const seniorImpl: RegisteredWorker = { instance: "w-senior", capability: { cognition: "implementation", weight: 5, family: "frontier" } };

test("a deployed colon-form agent job type resolves to live supply from an enrolled senior worker (#323)", () => {
  const report = buildRegistryReport({
    taskDefinitions: [leaf("senior:feature"), leaf("senior:retro"), leaf("senior:rebase")],
    workers: [seniorImpl],
    now: NOW,
  });
  // All three colon-form agent job types bridge onto the bare `senior` routing role, which the senior
  // worker supplies — so the board shows live supply, not a false RED, and nothing is nonAgentic.
  assertEquals(report.missing, []);
  assertEquals(report.nonAgentic, []);
  const senior = report.networks.find((n) => n.network === "senior");
  assert(senior !== undefined, "the `senior` network bucket is present");
  const token = senior.tokens.find((t) => t.token === "senior");
  assert(token !== undefined);
  assertEquals(token.satisfied, true);
  assertEquals(token.supply, 1);
  assertEquals(token.instances, ["w-senior"]);
});

test("an agent job type with no enrolled senior worker is flagged missing, not nonAgentic (#323)", () => {
  const report = buildRegistryReport({ taskDefinitions: [leaf("senior:feature")], workers: [], now: NOW });
  assert(report.missing.includes("senior"), "senior demand with no supplier is missing (red)");
  assertEquals(report.nonAgentic, []);
  assertEquals(report.status, "red");
});

test("ordinary host jobs (pr.*) are not colon-form and pass through the bridge untouched", () => {
  const report = buildRegistryReport({ taskDefinitions: [leaf("pr.finalize")], workers: [], now: NOW });
  const pr = report.networks.find((n) => n.network === "pr");
  assert(pr !== undefined, "pr.finalize stays a pr-network routing token");
  assert(pr.tokens.some((t) => t.token === "pr.finalize"));
});

test("flags a demanded leaf with no supplier as missing (red) and a supplied leaf as satisfied", () => {
  const report = buildRegistryReport({
    taskDefinitions: [leaf("planning.spar"), leaf("ci.runner")],
    workers: [plannerFrontier],
    now: NOW,
  });
  assert(report.missing.includes("ci.runner"), "ci.runner has no supplier");
  assertEquals(report.status, "red");
  const planning = report.networks.find((n) => n.network === "planning");
  assert(planning !== undefined);
  const spar = planning.tokens.find((t) => t.token === "planning.spar");
  assert(spar !== undefined);
  assertEquals(spar.satisfied, true);
  assertEquals(spar.supply, 1);
  assertEquals(spar.instances, ["w-front"]);
  assertEquals(report.version, CREW_VOCAB_VERSION);
  assertEquals(report.generatedAt, NOW.toISOString());
  assertEquals(report.demandUnavailable, false);
});

test("a deployed type that is not a valid routing token is surfaced as nonAgentic, not missing", () => {
  const report = buildRegistryReport({ taskDefinitions: [leaf("weird token!")], workers: [], now: NOW });
  assert(report.nonAgentic.includes("weird token!"));
  assertEquals(report.missing, []);
});

test("the diversity SLO reads the correlated supply — green for distinct-family spar seats", () => {
  const report = buildRegistryReport({
    taskDefinitions: [leaf("planning.spar")],
    workers: [plannerFrontier, plannerKimi],
    now: NOW,
  });
  assertEquals(report.diversity.status, "green");
});

test("when the engine demand read is unavailable the report is supply-only, flagged demandUnavailable", () => {
  const report = buildRegistryReport({ taskDefinitions: undefined, workers: [plannerFrontier], now: NOW });
  assertEquals(report.demandUnavailable, true);
  assertEquals(report.networks, []);
  assertEquals(report.missing, []);
});

test("toWireReport rebuilds the report into the mutable wire shape structurally", () => {
  const report = buildRegistryReport({ taskDefinitions: [leaf("planning.spar")], workers: [plannerFrontier], now: NOW });
  const wire = toWireReport(report);
  assertEquals(wire.version, report.version);
  assertEquals(wire.status, report.status);
  assertEquals(wire.networks[0].tokens[0].token, "planning.spar");
  assert(Array.isArray(wire.missing));
});

test("engineRestAddress derives a /v2 REST base by default", () => {
  const address = engineRestAddress();
  assert(address.startsWith("http"), "an http(s) base");
});

test("engineRestAddress strips trailing slashes from an explicit CAMUNDA_REST_ADDRESS", () => {
  const prev = process.env.CAMUNDA_REST_ADDRESS;
  try {
    process.env.CAMUNDA_REST_ADDRESS = "http://engine.example:8080/v2///";
    assertEquals(engineRestAddress(), "http://engine.example:8080/v2");
  } finally {
    if (prev === undefined) delete process.env.CAMUNDA_REST_ADDRESS;
    else process.env.CAMUNDA_REST_ADDRESS = prev;
  }
});

test("engineRestAddress strips trailing slashes from the derived NANOBPMN_BASE_URL base", () => {
  const prevExplicit = process.env.CAMUNDA_REST_ADDRESS;
  const prevBase = process.env.NANOBPMN_BASE_URL;
  try {
    delete process.env.CAMUNDA_REST_ADDRESS;
    process.env.NANOBPMN_BASE_URL = "http://engine.example:8080//";
    assertEquals(engineRestAddress(), "http://engine.example:8080/v2");
  } finally {
    if (prevExplicit === undefined) delete process.env.CAMUNDA_REST_ADDRESS;
    else process.env.CAMUNDA_REST_ADDRESS = prevExplicit;
    if (prevBase === undefined) delete process.env.NANOBPMN_BASE_URL;
    else process.env.NANOBPMN_BASE_URL = prevBase;
  }
});
