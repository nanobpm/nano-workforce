// Tests for the crew vocabulary artifact (epic #152 / N1 #145). Assert the artifact is a valid vocab
// document, ships the crew's leaf tokens, resolves a declared capability to its SERVE set, and grades
// the diversity SLO — the ADR 0056 §10 red/blue spar acceptance.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { correlateRegistry } from "@nanobpm/agentic/vocab";
import type { Capability } from "@nanobpm/agentic/protocol";
import { CREW_VOCAB, CREW_VOCAB_VERSION, crewResolver } from "./crew-vocab.ts";

const frontierPlanner: Capability = { cognition: "planning", weight: 5, family: "frontier", host: "h1" };
const kimiPlanner: Capability = { cognition: "planning", weight: 5, family: "kimi", host: "h2" };

test("the crew vocab is a valid artifact the resolver accepts", () => {
  const resolver = crewResolver();
  assertEquals(resolver.version, CREW_VOCAB_VERSION);
  // Same singleton is memoised.
  assert(crewResolver() === resolver);
});

test("it ships the crew's leaf tokens", () => {
  const tokens = crewResolver().tokens();
  for (const expected of [
    "planning.spar",
    "planning.finalize",
    "qa.review",
    "qa.lint",
    "implementation.senior",
    "implementation.junior",
    "implementation.reviewer",
    "ci.runner",
    "decide",
    "senior",
  ]) {
    assert(tokens.includes(expected), `expected token ${expected}`);
  }
});

test("a representative senior worker resolves the rank-gated `senior` role (any cognition, weight>=4)", () => {
  const implementation = crewResolver().resolve({ cognition: "implementation", weight: 5, family: "frontier" });
  const planning = crewResolver().resolve({ cognition: "planning", weight: 4, family: "kimi" });
  assert(implementation.tokens.includes("senior"), "an implementation senior serves `senior`");
  assert(planning.tokens.includes("senior"), "a planning senior serves `senior` (rank, not cognition)");
});

test("a junior-weight worker does not resolve the `senior` rank role", () => {
  assert(!crewResolver().resolve({ cognition: "implementation", weight: 2, family: "kimi" }).tokens.includes("senior"));
});

test("the spar role carries two distinct-family named seats", () => {
  const spar = crewResolver().roleForToken("planning.spar");
  assert(spar !== undefined);
  assertEquals(spar.seats, ["red", "blue"]);
  assertEquals(spar.seatsDistinctFamily, true);
});

test("a frontier and a kimi/qwen planning worker both resolve planning.spar", () => {
  const frontier = crewResolver().resolve(frontierPlanner);
  const kimi = crewResolver().resolve(kimiPlanner);
  assert(frontier.tokens.includes("planning.spar"), "frontier serves planning.spar");
  assert(kimi.tokens.includes("planning.spar"), "kimi serves planning.spar");
  // Deterministic / idempotent: the same capability always yields the same SERVE.
  assertEquals(crewResolver().resolve(frontierPlanner).tokens, frontier.tokens);
});

test("a capability that satisfies no requires gate resolves to an empty SERVE set", () => {
  const stranger: Capability = { cognition: "marketing", family: "frontier" };
  assertEquals(crewResolver().resolve(stranger).tokens, []);
});

test("diversity SLO is green for distinct-family spar seats, red for a same-family collision", () => {
  const resolver = crewResolver();
  const distinct = correlateRegistry(resolver, [
    { instance: "a", capability: frontierPlanner },
    { instance: "b", capability: kimiPlanner },
  ]);
  assertEquals(distinct.status, "green");

  const sameFamily = correlateRegistry(resolver, [
    { instance: "a", capability: frontierPlanner },
    { instance: "b", capability: { ...kimiPlanner, family: "frontier" } },
  ]);
  const spar = sameFamily.roles.find((r) => r.token === "planning.spar");
  assert(spar !== undefined);
  // A same-family collision on the STRICT (seatsDistinctFamily) spar role is an SLO violation (RED).
  assertEquals(spar.status, "red");
  assertEquals(sameFamily.status, "red");
});

test("CREW_VOCAB is deep-frozen so a consumer cannot mutate the shared artifact", () => {
  assert(Object.isFrozen(CREW_VOCAB));
  // Object.freeze is shallow — assert the nested structures are frozen too, so the "no consumer can
  // mutate the shared artifact" invariant holds all the way down.
  assert(Object.isFrozen(CREW_VOCAB.networks));
  assert(Object.isFrozen(CREW_VOCAB.networks.planning));
  assert(Object.isFrozen(CREW_VOCAB.networks.planning.roles));
  assert(Object.isFrozen(CREW_VOCAB.networks.planning.roles.spar));
  assert(Object.isFrozen(CREW_VOCAB.networks.planning.roles.spar.seats));
});
