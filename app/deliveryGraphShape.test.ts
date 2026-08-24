// Unit coverage for `validateDeliveryGraphShape` — the reused OpenAPI `DeliveryGraph` shape gate
// (PR #533 review). It must (a) reject the nested-type/unknown-property violations the semantic
// validator deliberately does not re-enumerate, with path-qualified errors, and (b) accept a
// structurally-valid graph — INCLUDING a not-yet-resolvable capability/pr probe, whose late-binding
// is deferred to the runner and must NOT be a shape-time failure.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { validateDeliveryGraphShape } from "./deliveryGraphShape.ts";

test("accepts a structurally-valid graph (agent + human)", () => {
  assertEquals(
    validateDeliveryGraphShape({
      name: "ok",
      nodes: [
        { id: "a", kind: "agent", agent: { jobType: "senior:feature" } },
        { id: "h", kind: "human", human: { prompt: "do X" } },
      ],
      edges: [{ from: "a", to: "h" }],
    }).length,
    0,
  );
});

test("accepts a not-yet-resolvable capability/pr wait probe (shape only, resolution deferred)", () => {
  assertEquals(
    validateDeliveryGraphShape({
      nodes: [
        { id: "c", kind: "wait", wait: { kind: "capability", target: "pkg@1.0.0", match: { package: "pkg", capabilityRef: "o/r#1" } } },
        { id: "p", kind: "wait", wait: { kind: "pr", target: "o/r#1", match: { prState: "merged" } } },
      ],
    }).length,
    0,
  );
});

test("rejects a nested wrong-typed optional field with a path-qualified error", () => {
  const errors = validateDeliveryGraphShape({
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed.
    nodes: [{ id: "h", kind: "human", human: { prompt: 42 } } as any],
  });
  assert(errors.length > 0);
  assert(errors.some((e) => e.path.includes("nodes[0]/human/prompt")));
});

test("rejects a wrong-typed nested wait.poll.backoff", () => {
  const errors = validateDeliveryGraphShape({
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed.
    nodes: [{ id: "w", kind: "wait", wait: { kind: "http", target: "http://x", poll: { backoff: 42 } } } as any],
  });
  assert(errors.length > 0);
  assert(errors.some((e) => e.path.includes("nodes[0]/wait/poll/backoff")));
});

test("rejects an unknown top-level property", () => {
  const errors = validateDeliveryGraphShape({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }],
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed.
    bogus: 1,
  } as any);
  assert(errors.length > 0);
  assert(errors.some((e) => e.path.includes("bogus")));
});

test("rejects an empty-nodes graph (nodes.minItems: 1)", () => {
  assert(validateDeliveryGraphShape({ name: "x", nodes: [] }).length > 0);
});
