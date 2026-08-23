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
// A demanded taskDefinition leaf. `agentic` is the structural signal the engine reads from a task's
// `linkName="prompt"` side-car (agentic package >=0.4): true for an external agent task (its type is a
// routing token matched against crew supply), false for a deterministic in-process host job (bucketed
// as nonAgentic, out of the demand×supply accounting). Defaults to an agent task since most demand
// here is agentic; the host-job cases pass `false` explicitly.
const leaf = (taskType: string, agentic = true): TaskDefinitionLeaf => ({ taskType, process: "p", elementId: taskType, agentic });

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

test("ordinary host jobs (pr.*) are non-agentic (no prompt link) and excluded from demand×supply", () => {
  // A deterministic in-process host job carries no `linkName="prompt"` side-car, so the engine reports
  // it agentic:false and the model buckets it as nonAgentic — off the agentic demand board, never a
  // false RED. The colon-form bridge still leaves its dot-form type untouched (it is not `<rank>:<task>`).
  const report = buildRegistryReport({ taskDefinitions: [leaf("pr.finalize", false)], workers: [], now: NOW });
  assert(report.nonAgentic.includes("pr.finalize"), "pr.finalize is a non-agentic host job");
  assert(!report.networks.some((n) => n.network === "pr"), "and is not counted as agentic pr-network demand");
  assertEquals(report.missing, []);
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

test("an agentic leaf whose type resolves to no crew role is a missing (red) gap, not silently dropped", () => {
  // Under the structural model, nonAgentic means "no prompt link", NOT "unparseable/unknown token": an
  // agent task (agentic:true) demanding a rank no crew role serves is a real RED supply gap the board
  // must surface. `principal:*` is a new rank with no crew role — the #323 bridge derives `principal`,
  // which resolves to no supply and trips this regression guard rather than being swept into nonAgentic.
  const report = buildRegistryReport({ taskDefinitions: [leaf("principal:feature")], workers: [], now: NOW });
  assert(report.missing.includes("principal"), "an unsuppliable agent rank is missing, not nonAgentic");
  assertEquals(report.nonAgentic, []);
  assertEquals(report.status, "red");
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
