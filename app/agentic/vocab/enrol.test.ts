// Tests for the enrolment resolver (epic #152 / N1 #145). The server side of REGISTER → SERVE:
// a declared capability resolves to a deterministic SERVE set, the vocab version, and a lease TTL.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { Capability } from "@nanobpm/agentic/protocol";
import { CREW_VOCAB_VERSION } from "./crew-vocab.ts";
import { DEFAULT_LEASE_TTL_MS, resolveEnrolment } from "./enrol.ts";

const planner: Capability = { cognition: "planning", weight: 5, family: "frontier", host: "h1" };

test("resolves a capability to its SERVE token set with the vocab version and a lease TTL", () => {
  const result = resolveEnrolment(planner);
  assert(result.serve.includes("planning.spar"));
  assertEquals(result.demandVersion, CREW_VOCAB_VERSION);
  // No presence registry is mounted in a unit test, so the lease falls back to the default TTL.
  assertEquals(result.leaseTtl, DEFAULT_LEASE_TTL_MS);
});

test("the resolution is deterministic (idempotent per worker)", () => {
  assertEquals(resolveEnrolment(planner).serve, resolveEnrolment(planner).serve);
});

test("roles provenance carries the SERVE tokens with their diversity flag", () => {
  const result = resolveEnrolment(planner);
  const spar = result.roles.find((r) => r.token === "planning.spar");
  assert(spar !== undefined);
  assertEquals(spar.seatsDistinctFamily, true);
  // Every SERVE token has a matching role entry.
  assertEquals(
    [...result.serve].sort(),
    result.roles.map((r) => r.token).sort(),
  );
});

test("a capability that fills no role gets an empty SERVE set", () => {
  const result = resolveEnrolment({ cognition: "unknown" });
  assertEquals(result.serve, []);
  assertEquals(result.roles, []);
});

test("serve is sorted and de-duplicated, and roles are sorted by token", () => {
  const result = resolveEnrolment(planner);
  assertEquals([...result.serve], [...result.serve].sort((a, b) => a.localeCompare(b)));
  assertEquals(new Set(result.serve).size, result.serve.length);
  assertEquals(
    result.roles.map((r) => r.token),
    result.roles.map((r) => r.token).sort((a, b) => a.localeCompare(b)),
  );
});
