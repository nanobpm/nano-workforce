// Unit coverage for the pr.delivery-connector worker's input validation (workers/delivery-connector/worker.ts).
// Job variables are UNTYPED at runtime, so the worker must not forward a misconfigured node's garbage
// into the (side-effecting) connector I/O surface: a blank `target` fails CLOSED, and a wrong-shaped
// `payload`/`boundFacts` is coerced to null with a surfaced warning rather than passed through.
import { test } from "node:test";
import { assert, assertEquals, assertThrows } from "#test-assert";
import { readConnectorInput } from "./worker.ts";

test("readConnectorInput: a blank/missing target fails closed (a connector with no destination is meaningless)", () => {
  for (const target of [undefined, "", "   "]) {
    assertThrows(() => readConnectorInput({ target }), Error, "target");
  }
});

test("readConnectorInput: a valid target is trimmed and passed through; well-shaped payload/boundFacts survive", () => {
  const facts = [{ from: "n1", name: "mergedSha", value: "abc" }];
  const r = readConnectorInput({ target: "  slack  ", payload: { channel: "#rel" }, boundFacts: facts });
  assertEquals(r.target, "slack");
  assertEquals(r.payload, { channel: "#rel" });
  assertEquals(r.boundFacts, facts);
  assertEquals(r.warnings.length, 0);
});

test("readConnectorInput: absent payload/boundFacts default to null with no warning", () => {
  const r = readConnectorInput({ target: "slack" });
  assertEquals(r.payload, null);
  assertEquals(r.boundFacts, null);
  assertEquals(r.warnings.length, 0);
});

test("readConnectorInput: a non-object payload / non-array boundFacts is coerced to null and warned (never forwarded)", () => {
  const r = readConnectorInput({ target: "slack", payload: "oops" as unknown as Record<string, unknown>, boundFacts: "nope" as unknown as [] });
  assertEquals(r.payload, null, "a scalar payload never reaches the connector surface");
  assertEquals(r.boundFacts, null, "a non-array boundFacts never reaches the connector surface");
  assertEquals(r.warnings.length, 2, "both coercions are surfaced for logging (not silent)");
  assert(r.warnings.some((w) => w.includes("payload")), "the payload coercion is named");
  assert(r.warnings.some((w) => w.includes("boundFacts")), "the boundFacts coercion is named");
});

test("readConnectorInput: an array payload is rejected (arrays are not plain objects)", () => {
  const r = readConnectorInput({ target: "slack", payload: [1, 2, 3] as unknown as Record<string, unknown> });
  assertEquals(r.payload, null);
  assertEquals(r.warnings.length, 1);
});
