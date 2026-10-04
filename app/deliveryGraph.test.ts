// Unit coverage for the pure delivery-graph validator `validateDeliveryGraph` (ADR 0005, slice S0).
// It exercises the SEMANTIC rules the openapi schema cannot express — the closed-kind allowlist,
// node-id uniqueness, edge integrity (dangling / self), typed-fact resolution (`from: <node>.<fact>`),
// and acyclicity — directly, with no HTTP and no side effects, mirroring how app/epicSetValidation
// unit-tests `validateEpicSet`. Each error class (unknown-kind / dangling / bad-`from` / cycle) has a
// dedicated case, and a fully-worked well-formed graph proves the happy path returns no errors.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  DELIVERY_NODE_KINDS,
  type DeliveryGraphError,
  type DeliveryGraphErrorCode,
  redactConnectorValue,
  validateDeliveryGraph,
} from "./deliveryGraph.ts";

/** The single error in the result, asserting there is exactly one. */
function only(errors: DeliveryGraphError[]): DeliveryGraphError {
  assertEquals(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
  return errors[0];
}

/** Assert the result contains at least one error of the given code. */
function hasCode(errors: DeliveryGraphError[], code: DeliveryGraphErrorCode): DeliveryGraphError {
  const found = errors.find((e) => e.code === code);
  assert(found !== undefined, `expected an error with code "${code}", got ${JSON.stringify(errors)}`);
  return found;
}

// A realistic, fully-worked graph mirroring the ADR's motivating case: an agent opens PR #B, a `pr`
// wait node (S2's kind, referenced by shape only here) watches it merge and emits `mergedSha`, a
// human does the manual OTP publish emitting `resolvedArtifact`, and a downstream wait consumes that
// published artifact. Proves nodes, per-kind config, typed emits, and both edge shapes validate.
const WELL_FORMED = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:feature", prompt: "un-draft + merge #B" } },
    {
      id: "watch-b",
      kind: "wait",
      wait: { kind: "github-check", target: "owner/repo@main" },
      emits: [{ name: "mergedSha", type: "string" }],
    },
    {
      id: "manual-publish",
      kind: "human",
      human: { prompt: "do the manual OTP publish + set up OIDC" },
      emits: [{ name: "resolvedArtifact", type: "artifact" }],
    },
    {
      id: "consume-c",
      kind: "wait",
      wait: { kind: "capability", target: "github-releases:owner/repo" },
    },
    { id: "notify", kind: "connector", connector: { target: "slack:#releases", dedupeKey: "notify-1" } },
  ],
  edges: [
    { from: "open-b", to: "watch-b" },
    { from: "watch-b.mergedSha", to: "manual-publish" },
    { from: "manual-publish.resolvedArtifact", to: "consume-c" },
    { from: "consume-c", to: "notify" },
  ],
};

test("a well-formed delivery graph produces no errors", () => {
  assertEquals(validateDeliveryGraph(WELL_FORMED), []);
});

test("an empty node set is rejected", () => {
  const err = only(validateDeliveryGraph({ nodes: [] }));
  assertEquals(err.code, "empty-graph");
});

test("a non-object graph is rejected without throwing", () => {
  assertEquals(validateDeliveryGraph(null).length, 1);
  assertEquals(validateDeliveryGraph(undefined)[0].code, "empty-graph");
  assertEquals(validateDeliveryGraph({ nodes: "nope" })[0].code, "empty-graph");
});

test("invalid-graph-name: a non-string top-level `name` is rejected, path-qualified", () => {
  // Regression (#524 review): a JSON-string import body bypasses the OpenAPI shape gate, so a
  // non-string `name` would otherwise reach the compiler and THROW out of `escapeXml` (surfacing as a
  // 400 with no path-qualified `errors`). The semantic validator now catches it cleanly.
  const err = hasCode(validateDeliveryGraph({ ...WELL_FORMED, name: 42 }), "invalid-graph-name");
  assertEquals(err.path, "name");
});

test("invalid-graph-name: a top-level `name` longer than 255 chars is rejected, path-qualified", () => {
  // Regression (#524 review): an over-long name would otherwise be persisted despite violating the
  // openapi `DeliveryGraph.name` `maxLength: 255` contract.
  const err = hasCode(validateDeliveryGraph({ ...WELL_FORMED, name: "x".repeat(256) }), "invalid-graph-name");
  assertEquals(err.path, "name");
  // The boundary (exactly 255) is accepted.
  assertEquals(validateDeliveryGraph({ ...WELL_FORMED, name: "x".repeat(255) }), []);
});

test("invalid-graph-name: `name` length is counted by code point, not UTF-16 code unit", () => {
  // Regression (#524 review): JS `String.length` counts UTF-16 code units, but openapi `maxLength`
  // counts Unicode code points. A name of 255 astral characters (each 2 code units) is WITHIN the
  // contract and must be accepted; the previous `String.length` check wrongly rejected it as 510.
  const astral255 = "\u{1F600}".repeat(255); // 255 emoji code points = 510 UTF-16 code units
  assertEquals([...astral255].length, 255);
  assertEquals(validateDeliveryGraph({ ...WELL_FORMED, name: astral255 }), []);
  // 256 code points is over the limit and rejected, path-qualified.
  const astral256 = "\u{1F600}".repeat(256);
  const err = hasCode(validateDeliveryGraph({ ...WELL_FORMED, name: astral256 }), "invalid-graph-name");
  assertEquals(err.path, "name");
});

test("too-many-nodes: a node set larger than the openapi `maxItems: 256` cap is rejected", () => {
  // Regression (#524 review): a JSON-string import/save body bypasses the OpenAPI shape gate, so the
  // declared `nodes.maxItems: 256` bound is re-enforced here — otherwise an oversized-but-compilable
  // graph reaches the layout/compiler and is persisted.
  const node = (i: number) => ({ id: `n${i}`, kind: "human", human: { prompt: "x" } });
  const tooMany = Array.from({ length: 257 }, (_, i) => node(i));
  const err = hasCode(validateDeliveryGraph({ nodes: tooMany }), "too-many-nodes");
  assertEquals(err.path, "nodes");
  // The cap SHORT-CIRCUITS the per-node walk: an oversized array is rejected on the cap ALONE, so
  // even when every node is independently invalid (here: `human` config of the wrong type) the
  // validator returns ONLY the single `too-many-nodes` error rather than doing 257 nodes' worth of
  // per-node validation/map-building work first (#533 review — make the resource limit effective).
  const oversizedAndInvalid = Array.from({ length: 257 }, (_, i) => ({ id: `n${i}`, kind: "human", human: 42 }));
  assertEquals(validateDeliveryGraph({ nodes: oversizedAndInvalid }), [
    {
      path: "nodes",
      message: "delivery graph has too many nodes (257) — the limit is 256",
      code: "too-many-nodes",
    },
  ]);
  // The boundary (exactly 256) is accepted (no too-many-nodes error).
  const exactly = Array.from({ length: 256 }, (_, i) => node(i));
  assertEquals(
    validateDeliveryGraph({ nodes: exactly }).filter((e) => e.code === "too-many-nodes"),
    [],
  );
});

test("too-many-edges: an edge set larger than the openapi `maxItems: 1024` cap is rejected", () => {
  // Regression (#524 review): re-enforce `edges.maxItems: 1024` for the bypassed shape gate.
  const nodes = [
    { id: "a", kind: "human", human: { prompt: "x" } },
    { id: "b", kind: "human", human: { prompt: "y" } },
  ];
  const tooMany = Array.from({ length: 1025 }, () => ({ from: "a", to: "b" }));
  const err = hasCode(validateDeliveryGraph({ nodes, edges: tooMany }), "too-many-edges");
  assertEquals(err.path, "edges");
  // The cap SHORT-CIRCUITS the edge walk: an oversized edge array is rejected before any endpoint
  // resolution / adjacency work, so even 1025 dangling edges surface ONLY the cap error, not 1025
  // `dangling-edge` errors (#533 review — make the resource limit effective).
  const oversizedDangling = Array.from({ length: 1025 }, () => ({ from: "ghost", to: "phantom" }));
  const capOnly = validateDeliveryGraph({ nodes, edges: oversizedDangling });
  assertEquals(capOnly.filter((e) => e.code === "dangling-edge"), []);
  assertEquals(hasCode(capOnly, "too-many-edges").path, "edges");
});

test("too-many-emits: a node declaring more than the openapi `maxItems: 32` facts is rejected", () => {
  // Regression (#524 review): re-enforce `DeliveryNodeCommon.emits.maxItems: 32` for the bypassed gate.
  const emits = Array.from({ length: 33 }, (_, i) => ({ name: `f${i}`, type: "string" }));
  const graph = { nodes: [{ id: "a", kind: "wait", wait: { kind: "capability", target: "x:y" }, emits }] };
  const err = hasCode(validateDeliveryGraph(graph), "too-many-emits");
  assertEquals(err.path, "nodes[0].emits");
});

test("unknown-kind: a node kind outside the closed allowlist is rejected, path-qualified", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "x", kind: "script", script: { run: "rm -rf /" } }],
  });
  const err = hasCode(errors, "unknown-kind");
  assertEquals(err.path, "nodes[0].kind");
  assert(err.message.includes(DELIVERY_NODE_KINDS.join(", ")), "message should list the allowlist");
});

test("unknown-kind: the closed allowlist is exactly the four ADR-0005 kinds", () => {
  assertEquals([...DELIVERY_NODE_KINDS], ["agent", "wait", "human", "connector"]);
});

test("dangling edge: a `to` that names no node is rejected, path-qualified", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: [{ from: "a", to: "ghost" }],
  });
  const err = hasCode(errors, "dangling-edge");
  assertEquals(err.path, "edges[0].to");
});

test("dangling edge: a `from` that names no node is rejected, path-qualified", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: [{ from: "ghost", to: "a" }],
  });
  const err = hasCode(errors, "dangling-edge");
  assertEquals(err.path, "edges[0].from");
});

test("bad-from: a `<node>.<fact>` reference to an undeclared fact is rejected, path-qualified", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "version", type: "version" }] },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "a.sha", to: "b" }],
  });
  const err = hasCode(errors, "bad-from");
  assertEquals(err.path, "edges[0].from");
  assert(err.message.includes("sha"), "message should name the missing fact");
});

test("bad-from: a declared fact reference resolves cleanly", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "version", type: "version" }] },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "a.version", to: "b" }],
  });
  assertEquals(errors, []);
});

test("a node id containing dots resolves as a whole node, not a fact split", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "repo.owner.a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "repo.owner.a", to: "b" }],
  });
  assertEquals(errors, []);
});

test("bad-from: an edge that resolves as both a whole node id and a `<node>.<fact>` reference is rejected as ambiguous", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "a.b", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "c", type: "version" }] },
      { id: "a.b.c", kind: "agent", agent: { jobType: "j" } },
      { id: "d", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "a.b.c", to: "d" }],
  });
  const err = hasCode(errors, "bad-from");
  assertEquals(err.path, "edges[0].from");
  assert(err.message.includes("ambiguous"), "message should call out the ambiguity");
});

test("cycle: a self-edge is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: [{ from: "a", to: "a" }],
  });
  const err = hasCode(errors, "self-edge");
  assertEquals(err.path, "edges[0]");
});

test("cycle: a multi-node dependency cycle is rejected, naming the cycle", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
      { id: "c", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ],
  });
  const err = hasCode(errors, "cycle");
  assertEquals(err.path, "edges");
  assert(err.message.includes("→"), "cycle message should render the cycle path");
});

test("duplicate-id: two nodes sharing an id is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "a", kind: "human" },
    ],
  });
  const err = hasCode(errors, "duplicate-id");
  assertEquals(err.path, "nodes[1].id");
});

test("missing-config: a non-human node without its per-kind config is rejected", () => {
  const errors = validateDeliveryGraph({ nodes: [{ id: "a", kind: "wait" }] });
  const err = hasCode(errors, "missing-config");
  assertEquals(err.path, "nodes[0].wait");
});

test("missing-required-field: an agent node whose `agent` config omits `jobType` is rejected", () => {
  const errors = validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: {} }] });
  const err = hasCode(errors, "missing-required-field");
  assertEquals(err.path, "nodes[0].agent.jobType");
});

test("missing-required-field: a wait node whose probe omits `kind`/`target` is rejected per field", () => {
  const errors = validateDeliveryGraph({ nodes: [{ id: "a", kind: "wait", wait: {} }] });
  hasCode(errors, "missing-required-field");
  assertEquals(
    errors.filter((e) => e.code === "missing-required-field").map((e) => e.path).sort(),
    ["nodes[0].wait.kind", "nodes[0].wait.target"],
  );
});

test("missing-required-field: a connector node whose config has an empty `target` is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "connector", connector: { target: "" } }],
  });
  const err = hasCode(errors, "missing-required-field");
  assertEquals(err.path, "nodes[0].connector.target");
});

test("a human node may omit its config (generic-fallback resolution lands in S3)", () => {
  assertEquals(validateDeliveryGraph({ nodes: [{ id: "done", kind: "human" }] }), []);
});

test("raw-converge-node: a raw `senior:converge`/`senior:merge` agent job is not expressible (S5)", () => {
  for (const jobType of ["senior:converge", "senior:merge", "converge", "merge"]) {
    const errors = validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType } }] });
    const err = hasCode(errors, "raw-converge-node");
    assertEquals(err.path, "nodes[0].agent.jobType");
  }
});

test("raw-converge-node: `senior:trial-merge` (the merge-cell body) is NOT swept up (exact-verb)", () => {
  assertEquals(
    validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:trial-merge" } }] }),
    [],
  );
});

test("a cell node may carry first-class `converge`/`merge` policy (S5)", () => {
  assertEquals(
    validateDeliveryGraph({
      nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", converge: true, merge: true } }],
    }),
    [],
  );
  // converge-only (stop at green) is legal on its own.
  assertEquals(
    validateDeliveryGraph({
      nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", converge: true } }],
    }),
    [],
  );
});

test("converge-merge-type: `agent.converge`/`agent.merge` must be boolean when present (S5 trust boundary)", () => {
  // `validateDeliveryGraph` is the trust boundary before `as DeliveryGraph`, so a graph that bypassed
  // OpenAPI validation must not be able to smuggle a non-boolean `converge`/`merge` past the S5 policy
  // checks (which compare `=== true`) — a truthy `"true"`/`1` would silently evade merge-requires-converge.
  for (const bad of ["true", 1, 0, null] as const) {
    const cErr = hasCode(
      validateDeliveryGraph({
        nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", converge: bad } }],
      }),
      "converge-merge-type",
    );
    assertEquals(cErr.path, "nodes[0].agent.converge");
    const mErr = hasCode(
      validateDeliveryGraph({
        nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", converge: true, merge: bad } }],
      }),
      "converge-merge-type",
    );
    assertEquals(mErr.path, "nodes[0].agent.merge");
  }
});

test("merge-requires-converge: `agent.merge` without `agent.converge` is rejected (S5 edge-gate)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", merge: true } }],
  });
  const err = hasCode(errors, "merge-requires-converge");
  assertEquals(err.path, "nodes[0].agent.merge");
});

test("duplicate-fact: two emits sharing a name on one node is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      {
        id: "a",
        kind: "agent",
        agent: { jobType: "j" },
        emits: [{ name: "v", type: "version" }, { name: "v", type: "string" }],
      },
    ],
  });
  const err = hasCode(errors, "duplicate-fact");
  assertEquals(err.path, "nodes[0].emits[1].name");
});

test("all errors are collected in one pass, not just the first", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "a", kind: "bogus" },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "ghost", to: "a" }],
  });
  hasCode(errors, "unknown-kind");
  hasCode(errors, "duplicate-id");
  hasCode(errors, "dangling-edge");
  assert(errors.length >= 3, `expected the pass to collect every error, got ${errors.length}`);
});

test("a graph with no edges (independent roots) is valid", () => {
  assertEquals(
    validateDeliveryGraph({
      nodes: [
        { id: "a", kind: "agent", agent: { jobType: "j" } },
        { id: "b", kind: "agent", agent: { jobType: "j" } },
      ],
    }),
    [],
  );
});

test("a non-array `edges` is rejected as a shape error (`invalid-edges`), not silently treated as no edges", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: "nope",
  });
  const err = hasCode(errors, "invalid-edges");
  assertEquals(err.path, "edges");
});

test("a non-object edge entry is a shape error (`invalid-edges`), not `dangling-edge`", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: ["nope"],
  });
  const err = hasCode(errors, "invalid-edges");
  assertEquals(err.path, "edges[0]");
});

test("an edge missing string `from`/`to` is a shape error (`invalid-edges`), not `dangling-edge`", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: [{ from: "", to: 3 }],
  });
  const fromErr = hasCode(errors, "invalid-edges");
  assertEquals(fromErr.path, "edges[0].from");
  assert(
    errors.some((e) => e.code === "invalid-edges" && e.path === "edges[0].to"),
    "expected the missing `to` to also be an invalid-edges shape error",
  );
});

test("invalid-id: a node id violating the openapi id pattern is rejected so downstream id use stays safe", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "1 bad id", kind: "agent", agent: { jobType: "j" } }],
  });
  const err = hasCode(errors, "invalid-id");
  assertEquals(err.path, "nodes[0].id");
});

test("a `human` node whose `human` config is not an object is rejected, path-qualified", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "done", kind: "human", human: "just do it" }],
  });
  const err = hasCode(errors, "missing-config");
  assertEquals(err.path, "nodes[0].human");
});

test("invalid-fact-name: an emitted fact name containing a dot is rejected so qualified `from` stays unambiguous", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "sha.short", type: "string" }] }],
  });
  const err = hasCode(errors, "invalid-fact-name");
  assertEquals(err.path, "nodes[0].emits[0].name");
});

test("invalid-fact-name: an emitted fact name over the openapi 128-char cap is rejected so a length-trusting consumer can't be overrun", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "f".repeat(129), type: "string" }] }],
  });
  const err = hasCode(errors, "invalid-fact-name");
  assertEquals(err.path, "nodes[0].emits[0].name");
});

test("invalid-fact-type: an emitted fact with a type outside the allowlist is rejected, path-qualified", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      {
        id: "a",
        kind: "agent",
        agent: { jobType: "j" },
        emits: [{ name: "sha", type: "bogus" }],
      },
    ],
  });
  const err = hasCode(errors, "invalid-fact-type");
  assertEquals(err.path, "nodes[0].emits[0].type");
});

test("invalid-fact-type: an emitted fact missing its `type` is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "sha" }] },
    ],
  });
  const err = hasCode(errors, "invalid-fact-type");
  assertEquals(err.path, "nodes[0].emits[0].type");
});

// ── S7: guarded (conditional) edges — the exclusive-gateway extension (ADR 0005 S7) ────────────────
// A guarded split node emits a scalar outcome fact and routes on it: exactly one out-edge's `when`
// value matches at runtime (or the `default` else-branch fires). These cases exercise the new
// validation surface — guard shape, scalar-fact resolution, exhaustiveness, no-mixing, and the
// exclusive-merge parity the compiler relies on.

/** Mode A (adopt), the ADR's motivating guarded split: `bump` emits a scalar `result`; a guard routes
 *  the breaking outcome through `migrate`, the default (green) straight to `release`, and the branches
 *  re-converge at `release` (an exclusive merge). Exhaustive via its `default`. */
const GUARDED_ADOPT = {
  name: "adopt",
  nodes: [
    { id: "bump", kind: "agent", agent: { jobType: "senior:feature" }, emits: [{ name: "result", type: "string" }] },
    { id: "migrate", kind: "agent", agent: { jobType: "senior:feature" } },
    { id: "release", kind: "connector", connector: { target: "npm:publish" } },
  ],
  edges: [
    { from: "bump", to: "migrate", when: "bump.result", equals: "breaking" },
    { from: "bump", to: "release", default: true },
    { from: "migrate", to: "release" },
  ],
};

test("S7 happy: a well-formed guarded split (with a default) validates with no errors", () => {
  assertEquals(validateDeliveryGraph(GUARDED_ADOPT), []);
});

test("S7 happy: a boolean fact guarded on BOTH values is exhaustive without a default", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "gate", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "ok", type: "boolean" }] },
      { id: "yes", kind: "agent", agent: { jobType: "j" } },
      { id: "no", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "gate", to: "yes", when: "gate.ok", equals: true },
      { from: "gate", to: "no", when: "gate.ok", equals: false },
    ],
  });
  assertEquals(errors, []);
});

test("S7 non-exhaustive-split: a string guard without a default is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "migrate", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "bump", to: "migrate", when: "bump.result", equals: "breaking" }],
  });
  hasCode(errors, "non-exhaustive-split");
});

test("S7 mixed-fan-out: a node whose out-edges MIX a guard with a plain edge is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.result", equals: "x" },
      { from: "bump", to: "b" },
    ],
  });
  hasCode(errors, "mixed-fan-out");
});

test("S7 bad-when: a guard on an UNDECLARED fact is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.nope", equals: "x" },
      { from: "bump", to: "b", default: true },
    ],
  });
  const err = hasCode(errors, "bad-when");
  assertEquals(err.path, "edges[0].when");
});

test("S7 bad-when: a guard on a NON-SCALAR (artifact) fact is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "human", human: {}, emits: [{ name: "art", type: "artifact" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.art", equals: "x" },
      { from: "bump", to: "b", default: true },
    ],
  });
  hasCode(errors, "bad-when");
});

test("S7 bad-when: a guard referencing a fact of a DIFFERENT node than the edge producer is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "other", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "other.result", equals: "x" },
      { from: "bump", to: "b", default: true },
    ],
  });
  hasCode(errors, "bad-when");
});

test("S7 guard-missing-equals: `when` without `equals` is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.result" },
      { from: "bump", to: "b", default: true },
    ],
  });
  hasCode(errors, "guard-missing-equals");
});

test("S7 guard-type-mismatch: an `equals` whose type differs from the fact's declared type is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "n", type: "number" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.n", equals: "not-a-number" },
      { from: "bump", to: "b", default: true },
    ],
  });
  hasCode(errors, "guard-type-mismatch");
});

test("S7 guard-invalid-equals: a string `equals` carrying an XML-1.0-invalid character is rejected, not silently rewritten into a different FEEL guard (#778 review)", () => {
  // A string `equals` is baked VERBATIM into the compiled `<bpmn:conditionExpression>` FEEL literal.
  // An XML-1.0-forbidden character (here U+FFFE) cannot be entity-escaped, so the compiler's
  // display-text sanitiser would STRIP it — turning the guard `bump_result = "a\uFFFEb"` into
  // `bump_result = "ab"` and routing the split down the wrong edge. It must be rejected at validation
  // instead of silently mutating executable FEEL.
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.result", equals: "a\uFFFEb" },
      { from: "bump", to: "b", default: true },
    ],
  });
  hasCode(errors, "guard-invalid-equals");
});

test("S7 guard-invalid-equals: a clean string `equals` (no XML-invalid characters) passes validation", () => {
  assertEquals(
    validateDeliveryGraph({
      nodes: [
        { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
        { id: "a", kind: "agent", agent: { jobType: "j" } },
        { id: "b", kind: "agent", agent: { jobType: "j" } },
      ],
      edges: [
        { from: "bump", to: "a", when: "bump.result", equals: "breaking" },
        { from: "bump", to: "b", default: true },
      ],
    }).filter((e) => e.code === "guard-invalid-equals"),
    [],
  );
});

test("invalid-job-type: an `agent.jobType` carrying an XML-1.0-invalid character is rejected, not silently rewritten into a different executable worker type (#778 review)", () => {
  // `agent.jobType` is emitted VERBATIM as the executable `<zeebe:taskDefinition type=…>` (and mirrored
  // into `resolved.calledElement`). An XML-1.0-forbidden character (here a C0 control) cannot be
  // entity-escaped, so the compiler's attribute sanitiser would STRIP it — deploying `senior:feature`
  // for an authored `senior:\u0001feature` and routing the cell to the WRONG worker. It must be
  // rejected at validation rather than silently mutated.
  const errors = validateDeliveryGraph({
    nodes: [{ id: "impl", kind: "agent", agent: { jobType: "senior:\u0001feature" } }],
    edges: [],
  });
  hasCode(errors, "invalid-job-type");
});

test("invalid-job-type: an `agent.jobType` carrying attribute whitespace (LF) is rejected — XML attribute-value normalization would fold it to a space, deploying a different worker type (#778 review)", () => {
  // A literal TAB/LF/CR is a valid XML `Char` (so the invalid-char strip does NOT catch it), but XML
  // attribute-value normalization rewrites it to a single space when emitted as `type="…"`. An authored
  // `senior:\nfeature` would deploy as `senior: feature` — a DIFFERENT worker type — so it must be
  // rejected at validation, not silently normalized.
  const errors = validateDeliveryGraph({
    nodes: [{ id: "impl", kind: "agent", agent: { jobType: "senior:\nfeature" } }],
    edges: [],
  });
  hasCode(errors, "invalid-job-type");
});

test("invalid-job-type: a clean `agent.jobType` (no XML-invalid characters, no attribute whitespace) passes validation", () => {
  assertEquals(
    validateDeliveryGraph({
      nodes: [{ id: "impl", kind: "agent", agent: { jobType: "senior:feature" } }],
      edges: [],
    }).filter((e) => e.code === "invalid-job-type"),
    [],
  );
});

test("invalid-job-type: the rejection message REDACTS a credential embedded in the (URL-shaped, XML-invalid) job type — a 400 never echoes a secret (#778 review)", () => {
  // A job type that is BOTH URL-shaped (userinfo credential) AND carries an XML-1.0-invalid control char
  // trips `invalid-job-type`. The message interpolates the value through `redactConnectorValue`, so the
  // embedded `user:pass` must NOT survive into the error a text-ingress caller sees.
  const errors = validateDeliveryGraph({
    nodes: [{ id: "impl", kind: "agent", agent: { jobType: "//user:pass@host\u0001/route" } }],
    edges: [],
  });
  const err = hasCode(errors, "invalid-job-type");
  assert(!err.message.includes("user:pass"), `the invalid-job-type message must redact the credential, got: ${err.message}`);
});

test("url-shaped-job-type: a URL-shaped `agent.jobType` is REJECTED at the semantic boundary — it is baked verbatim into the executable `<zeebe:taskDefinition type=…>`, so an embedded credential would leak into the compiled BPMN the preview door returns (#778 review)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "impl", kind: "agent", agent: { jobType: "https://user:pass@evil.example/route" } }],
    edges: [],
  });
  const err = hasCode(errors, "url-shaped-job-type");
  assert(!err.message.includes("user:pass"), `the url-shaped-job-type message must redact the credential, got: ${err.message}`);
});

test("url-shaped-job-type: a scheme-relative `//host` job type is rejected too; a plain routing token passes", () => {
  assert(
    hasCode(
      validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "//user:pass@host/x" } }], edges: [] }),
      "url-shaped-job-type",
    ) !== undefined,
  );
  assertEquals(
    validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }], edges: [] }).filter(
      (e) => e.code === "url-shaped-job-type",
    ),
    [],
  );
});

test("credential-in-job-type: a plausible token with an EMBEDDED credential-bearing URL (`senior:feature //user:pass@host`, past the anchored url-shape and TAB/LF/CR checks) is REJECTED, message redacted (#778 review — thread deliveryGraph.ts:550)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature //user:pass@evil.example/route" } }],
    edges: [],
  });
  const err = hasCode(errors, "credential-in-job-type");
  assert(!err.message.includes("user:pass"), `the credential-in-job-type message must redact the credential, got: ${err.message}`);
  // A plain routing token with no embedded credential is untouched.
  assertEquals(
    validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }], edges: [] }).filter(
      (e) => e.code === "credential-in-job-type",
    ),
    [],
  );
});

test("invalid-job-type: a NON-url-shaped token that both embeds a credential AND carries an XML-invalid char (`senior:feature //user:pass@host\\x01`) redacts the credential in the message — `redactConnectorValue` would have echoed it verbatim (#778 review — thread deliveryGraph.ts:532)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "impl", kind: "agent", agent: { jobType: "senior:feature //user:pass@evil.example\u0001/route" } }],
    edges: [],
  });
  const err = hasCode(errors, "invalid-job-type");
  assert(!err.message.includes("user:pass"), `the invalid-job-type message must redact the EMBEDDED credential, got: ${err.message}`);
});

test("credential-in-job-type: a literal SPACE inside the userinfo (`senior:feature //user:secret pass@host`) is caught — the whitespace-tolerant `//…@` span matches the display redactor, message redacted (#778 review — thread deliveryGraph.ts:570)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature //user:secret pass@evil.example/route" } }],
    edges: [],
  });
  const err = hasCode(errors, "credential-in-job-type");
  assert(!err.message.includes("secret pass"), `the credential-in-job-type message must redact the space-bearing credential, got: ${err.message}`);
});

test("invalid-credential-env: a `wait.credentialEnv` that is not a DECLARED env-contract key is rejected at the semantic boundary — a raw secret can never reach the compiled BPMN the preview door returns (#778 review)", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      {
        id: "g",
        kind: "wait",
        wait: { kind: "pr", target: "acme/repo#1", match: { prState: "merged" }, credentialEnv: "sk-an-actual-secret-value" },
      },
    ],
    edges: [],
  });
  hasCode(errors, "invalid-credential-env");
});

test("invalid-credential-env: a DECLARED env-contract key on an `http` probe passes (the secret is read from the ambient env at execution time, never carried here)", () => {
  assertEquals(
    validateDeliveryGraph({
      nodes: [
        {
          id: "g",
          kind: "wait",
          wait: { kind: "http", target: "https://acme.example/health", credentialEnv: "GITHUB_TOKEN" },
        },
      ],
      edges: [],
    }).filter((e) => e.code === "invalid-credential-env"),
    [],
  );
});

test("invalid-credential-env: a well-formed `credentialEnv` key on a NON-`http` probe kind is rejected at the semantic boundary — `parseProbe` supports it only for `http`, so reject here rather than stage-then-throw at dispatch (#778 review, thread deliveryGraph.ts:474)", () => {
  for (const kind of ["pr", "command", "npm", "github-check", "capability", "epic"] as const) {
    const errors = validateDeliveryGraph({
      nodes: [
        {
          id: "g",
          kind: "wait",
          wait: { kind, target: "acme/repo#1", credentialEnv: "GITHUB_TOKEN" },
        },
      ],
      edges: [],
    });
    hasCode(errors, "invalid-credential-env");
  }
});

test("invalid-credential-env: a padded-but-valid `credentialEnv` on `http` passes — validation trims like `parseProbe` does, so it agrees with execution (#778 review, suppressed advisory deliveryGraph.ts:466)", () => {
  assertEquals(
    validateDeliveryGraph({
      nodes: [{ id: "g", kind: "wait", wait: { kind: "http", target: "https://x/health", credentialEnv: "  GITHUB_TOKEN  " } }],
      edges: [],
    }).filter((e) => e.code === "invalid-credential-env"),
    [],
  );
  // A whitespace-only credentialEnv is treated as ABSENT (parseProbe reads `.trim() || undefined`), so it
  // is neither rejected nor carried — no error.
  assertEquals(
    validateDeliveryGraph({
      nodes: [{ id: "g", kind: "wait", wait: { kind: "http", target: "https://x/health", credentialEnv: "   " } }],
      edges: [],
    }).filter((e) => e.code === "invalid-credential-env"),
    [],
  );
});

test("invalid-credential-env: a non-string `credentialEnv` (e.g. 123) is rejected at the semantic boundary — it can never name an env key and `parseProbe` throws at dispatch, so reject rather than stage-then-throw (#778 review, suppressed advisory deliveryGraph.ts:473)", () => {
  for (const bad of [123, true, { k: "v" }, ["GITHUB_TOKEN"]]) {
    const errors = validateDeliveryGraph({
      nodes: [{ id: "g", kind: "wait", wait: { kind: "http", target: "https://x/health", credentialEnv: bad } }],
      edges: [],
    });
    hasCode(errors, "invalid-credential-env");
  }
});

test("invalid-credential-env: a padded probe `kind` (\" http \") still accepts a `credentialEnv` — the http-only check trims `kind` like `parseProbe` does, so a valid padded-kind http probe is not false-rejected (#778 review — thread deliveryGraph.ts:488)", () => {
  assertEquals(
    validateDeliveryGraph({
      nodes: [{ id: "g", kind: "wait", wait: { kind: " http ", target: "https://x/health", credentialEnv: "GITHUB_TOKEN" } }],
      edges: [],
    }).filter((e) => e.code === "invalid-credential-env"),
    [],
  );
});

test("invalid-backoff: an invalid `poll.backoff` (e.g. `linear`) is rejected at the semantic boundary — `normalizePoll` would silently default it to `exponential`, colliding its digest with a valid default-poll graph so a malformed proposal is marked dispatched instead of rejected; reject it before defaulting (#778 review, thread readiness.ts:432)", () => {
  // `parseProbe`→`parsePoll` throws on `backoff: "linear"` at DISPATCH, but the compiler's display/digest
  // path calls `normalizePoll` on the RAW graph, which maps every unrecognised backoff to `exponential`.
  // With the doc suppressing a default backoff and `digestInvisibleRawValues` only fingerprinting
  // XML-strip differences (`"linear"` is XML-clean), the malformed graph shares the omitted-poll graph's
  // digest/key — letting keyless dispatch short-circuit onto a valid run and mark the malformed proposal
  // dispatched. Reject it here (mirroring `parsePoll`'s canonical `isBackoff` guard) so it fails loudly
  // at the preview/stage door, exactly like the `credentialEnv`/`onTimeout` semantic-boundary checks.
  for (const backoff of ["linear", "LINEAR", "expo", "fixed ", "bogus"]) {
    const errors = validateDeliveryGraph({
      nodes: [{ id: "g", kind: "wait", wait: { kind: "pr", target: "acme/repo#1", poll: { everyMs: 1000, backoff } } }],
      edges: [],
    });
    // `"fixed "` (padded) is VALID — `parsePoll` trims before `isBackoff`, so validation must trim too
    // and accept it (agreement with execution), while genuinely invalid values are rejected.
    if (backoff.trim() === "fixed") {
      assertEquals(errors.filter((e) => e.code === "invalid-backoff"), [], `padded-but-valid backoff ${JSON.stringify(backoff)} must pass`);
    } else {
      hasCode(errors, "invalid-backoff");
    }
  }
});

test("invalid-backoff: a valid or omitted `poll.backoff` passes — `fixed`/`exponential`/omitted are accepted, agreeing with `parsePoll` (#778 review, thread readiness.ts:432)", () => {
  for (const poll of [{ everyMs: 1000 }, { everyMs: 1000, backoff: "fixed" }, { everyMs: 1000, backoff: "exponential" }, { everyMs: 1000, backoff: "" }]) {
    assertEquals(
      validateDeliveryGraph({
        nodes: [{ id: "g", kind: "wait", wait: { kind: "pr", target: "acme/repo#1", poll } }],
        edges: [],
      }).filter((e) => e.code === "invalid-backoff"),
      [],
      `backoff ${JSON.stringify(poll)} must pass`,
    );
  }
});

test("credential-in-job-type: a PASSWORDLESS userinfo token (`senior:feature //token@host`, no colon) is REJECTED — a bearer/OAuth token riding the userinfo is a credential too, and a routing key never contains `//…@` at all (#778 review push-back — thread readiness.ts:1170)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature //tok3n@host" } }],
    edges: [],
  });
  const err = hasCode(errors, "credential-in-job-type");
  assert(!err.message.includes("tok3n"), `the credential-in-job-type message must redact the passwordless token, got: ${err.message}`);
});

test("#778 redactConnectorValue: an EMBEDDED `//user:pass@host` credential after a non-URL prefix (a `parsePrTarget` value like `prefix //user:pass@host#42`) is redacted, not echoed verbatim; a userinfo-bearing authority is a URL so its `#fragment`/`?query` is redacted too (round-7 strengthening — thread deliveryGraph.ts:188), while an OPAQUE `//host#42` (no userinfo) keeps its `#42` (#778 review — thread deliveryGraph.ts:162/566)", () => {
  const out = redactConnectorValue("prefix //user:pass@host#42");
  assert(!out.includes("user:pass"), `an embedded credential must be redacted even without a URL prefix: ${out}`);
  assert(out.includes("//***@host"), `the userinfo collapses to the redaction marker: ${out}`);
  // A userinfo-bearing `//…@` authority IS a URL, so its `#fragment` is redacted (round 7, Finding A) —
  // an opaque PR ref never carries userinfo, so nothing meaningful is lost. The opaque `//host#42` case
  // (no userinfo) that keeps its `#42` is asserted separately below.
  assert(!out.includes("#42"), `a userinfo-bearing URL's fragment is redacted (safe direction): ${out}`);
  // A passwordless `//token@host` bearer token embedded after a prefix is redacted too.
  const bearer = redactConnectorValue("route //tok3n@host now");
  assert(!bearer.includes("tok3n") && bearer.includes("//***@host"), `a passwordless embedded token must be redacted: ${bearer}`);
  // An OPAQUE scheme-relative `//host#42` (no userinfo) keeps its meaningful `#42` PR ref.
  assertEquals(redactConnectorValue("prefix //host#42"), "prefix //host#42");
  // Opaque identifiers where `#`/`?`/`@` are MEANINGFUL and carry no embedded `//…@` are shown verbatim.
  assertEquals(redactConnectorValue("slack:#releases"), "slack:#releases");
  assertEquals(redactConnectorValue("owner/repo#42"), "owner/repo#42");
  assertEquals(redactConnectorValue("pkg@1.2.3"), "pkg@1.2.3");
});

test("#778 redactConnectorValue: an EMBEDDED absolute-URL token (explicit `scheme://…`) after a non-URL prefix (`prefix https://host/path?token=secret`) has its `?query`/`#fragment` secret redacted, while a scheme-relative `//host#42` PR ref and opaque `#`/`?` identifiers survive (#778 review — thread deliveryGraph.ts:181)", () => {
  const q = redactConnectorValue("prefix https://host/path?token=secret");
  assert(!q.includes("token=secret"), `an embedded absolute-URL query secret must be redacted: ${q}`);
  assert(q.includes("https://host/path?***"), `the query collapses to the redaction marker: ${q}`);
  const frag = redactConnectorValue("see https://host/p#sig=zzz");
  assert(!frag.includes("sig=zzz") && frag.includes("#***"), `an embedded absolute-URL fragment secret must be redacted: ${frag}`);
  // userinfo AND query of an embedded absolute URL are both redacted.
  const both = redactConnectorValue("go https://user:pass@host/p?token=x");
  assert(
    !both.includes("user:pass") && !both.includes("token=x") && both.includes("https://***@host/p?***"),
    `embedded absolute-URL userinfo + query are both redacted: ${both}`,
  );
  // A scheme-RELATIVE `//host#42` (no explicit scheme) keeps its meaningful opaque `#42` PR ref — the
  // `?`/`#` there are opaque-token characters, not URL syntax (parsePrTarget behaviour, unchanged).
  assertEquals(redactConnectorValue("prefix //host#42"), "prefix //host#42");
  assertEquals(redactConnectorValue("slack:#releases"), "slack:#releases");
  assertEquals(redactConnectorValue("owner/repo#42"), "owner/repo#42");
});

test("#778 redactConnectorValue: an embedded absolute-URL token whose userinfo or path carries an XML-valid TAB/LF/CR (`prefix https://user:pa\\tss@host/path?token=secret`) still has its `?query`/`#fragment` secret redacted — the embedded-URL scan is bounded by a literal SPACE, so it crosses the internal whitespace the primary `[^\\s]+` token stopped at (#778 review — thread deliveryGraph.ts:188)", () => {
  // The embedded-URL redactor used `[^\s]+`, which stops at an XML-valid TAB/LF/CR the value may still
  // carry after `stripXmlInvalidChars`. So `https://user:pa\tss@host/path?token=secret` matched only up
  // to the TAB; the credential pass then collapsed `//user:pa\tss@` to `//***@` but left the trailing
  // `?token=secret` un-rescanned, leaking the query into the connector display. Bounding the token by a
  // literal SPACE (like the free-text belt) makes the whole URL — userinfo AND query — one span.
  const tabUserinfo = redactConnectorValue("prefix https://user:pa\tss@host/path?token=secret");
  assert(!tabUserinfo.includes("token=secret"), `an embedded-URL query after an internal-TAB userinfo must be redacted: ${JSON.stringify(tabUserinfo)}`);
  assert(!tabUserinfo.includes("user:pa"), `the split userinfo must be redacted: ${JSON.stringify(tabUserinfo)}`);
  // Same leak without userinfo: whitespace inside the path/query must not truncate the scan.
  const tabPath = redactConnectorValue("prefix https://host/pa\tth?token=secret");
  assert(!tabPath.includes("token=secret"), `an embedded-URL query after an internal-TAB path must be redacted: ${JSON.stringify(tabPath)}`);
  // A newline inside the embedded URL is crossed the same way.
  const lf = redactConnectorValue("see https://host/p\n#sig=zzz");
  assert(!lf.includes("sig=zzz"), `an embedded-URL fragment after an internal newline must be redacted: ${JSON.stringify(lf)}`);
  // The scheme-relative `//host#42` PR ref (no explicit scheme) still keeps its meaningful `#42`.
  assertEquals(redactConnectorValue("prefix //host#42"), "prefix //host#42");
});

test("#778 redactConnectorValue: an embedded absolute-URL whose scheme is separated from the `//` authority by XML-valid whitespace (`prefix https:\\t//user:pass@host?token=secret`) still has its userinfo AND `?query` secret redacted — the embedded-URL token now allows `scheme:\\s*//`, aligned with `isUrlShaped` (#778 review — thread readiness.ts:1239)", () => {
  // The value is not whole-value URL-shaped (a non-URL prefix precedes it), so the anchored `isUrlShaped`
  // check misses it and it falls to the embedded-URL scan. Before the fix that scan required a contiguous
  // `://`, so `https:\t//user:pass@host?token=secret` was not matched as an absolute URL; the userinfo-only
  // fallback then stripped `//…@` but LEFT the `?token=secret` query in the connector/probe display.
  for (const ws of ["\t", "\n", "\r", " "]) {
    const v = `prefix https:${ws}//user:pass@host?token=secret`;
    const out = redactConnectorValue(v);
    assert(!out.includes("token=secret"), `an embedded-URL query after a scheme${JSON.stringify(ws)}// gap must be redacted: ${JSON.stringify(out)}`);
    assert(!out.includes("user:pass"), `the userinfo after a scheme${JSON.stringify(ws)}// gap must be redacted: ${JSON.stringify(out)}`);
  }
  // A scheme-relative `//host#42` PR ref (no explicit scheme) still keeps its meaningful `#42`.
  assertEquals(redactConnectorValue("prefix //host#42"), "prefix //host#42");
});

test("#778 redactConnectorValue: a scheme-RELATIVE credential URL (`//user:pass@host/path?token=secret`) embedded after a non-URL prefix has its userinfo AND `?query`/`#fragment` secret redacted — userinfo marks it a URL, so its `?`/`#` are URL syntax, while an opaque `//host#42` (no userinfo) keeps its `#42` (#778 review — thread deliveryGraph.ts:188)", () => {
  // Before the fix the non-URL branch used the userinfo-ONLY `redactEmbeddedCredential`, which collapsed
  // `//user:pass@` to `//***@` but LEFT the trailing `?token=secret` query — leaking it into the display.
  const q = redactConnectorValue("prefix //user:pass@host/path?token=secret");
  assert(!q.includes("token=secret"), `a scheme-relative credential URL's query secret must be redacted: ${JSON.stringify(q)}`);
  assert(!q.includes("user:pass"), `the scheme-relative userinfo must be redacted: ${JSON.stringify(q)}`);
  // A fragment on a scheme-relative credential URL is redacted the same way.
  const frag = redactConnectorValue("go //tok3n@host/p#sig=zzz");
  assert(!frag.includes("sig=zzz") && !frag.includes("tok3n"), `a scheme-relative credential URL's fragment secret must be redacted: ${JSON.stringify(frag)}`);
  // A query/fragment after an XML-valid internal TAB is still crossed (bounded by a literal SPACE).
  const tab = redactConnectorValue("prefix //user:pa\tss@host?token=secret");
  assert(!tab.includes("token=secret") && !tab.includes("user:pa"), `a scheme-relative credential URL split by a TAB must still redact its query: ${JSON.stringify(tab)}`);
  // A userinfo-LESS opaque `//host#42` PR ref keeps its meaningful `#42` — no userinfo ⇒ not a URL.
  assertEquals(redactConnectorValue("prefix //host#42"), "prefix //host#42");
  assertEquals(redactConnectorValue("slack:#releases"), "slack:#releases");
  assertEquals(redactConnectorValue("owner/repo#42"), "owner/repo#42");
});

test("embedded-url-in-job-type: a plausible token with an embedded USERINFO-LESS absolute URL (`senior:feature https://host/path?token=secret`) is REJECTED — it passes the anchored url-shape check AND `hasEmbeddedCredential` (no `//…@`), yet its `?query` would land verbatim in `<zeebe:taskDefinition type=…>`; message redacted (#778 review — thread deliveryGraph.ts:602)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature https://evil.example/route?token=secret" } }],
    edges: [],
  });
  const err = hasCode(errors, "embedded-url-in-job-type");
  assert(!err.message.includes("token=secret"), `the embedded-url-in-job-type message must redact the query secret, got: ${err.message}`);
  // A plain routing token with no embedded URL is untouched.
  assertEquals(
    validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }], edges: [] }).filter(
      (e) => e.code === "embedded-url-in-job-type",
    ),
    [],
  );
  // An opaque `owner/repo#42`-style token (no `scheme://`) is not a URL and is not rejected.
  assertEquals(
    validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:review owner/repo#42" } }], edges: [] }).filter(
      (e) => e.code === "embedded-url-in-job-type",
    ),
    [],
  );
});

test("scheme-relative-url-in-job-type: a plausible token with an embedded USERINFO-LESS SCHEME-RELATIVE URL (`senior:feature //host?token=secret`) is REJECTED — it slips past the anchored url-shape check, `hasEmbeddedCredential` (no `//…@`) AND `hasEmbeddedUrl` (no explicit `scheme://`), yet its `//authority?query` would land verbatim in `<zeebe:taskDefinition type=…>`; message redacted (#778 review — thread deliveryGraph.ts:633)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature //evil.example/route?token=secret" } }],
    edges: [],
  });
  const err = hasCode(errors, "scheme-relative-url-in-job-type");
  assert(!err.message.includes("token=secret"), `the scheme-relative-url-in-job-type message must redact the query secret, got: ${err.message}`);
  // Exactly one error class fires — the residual check is gated behind the three prior url checks so a
  // token is never double-reported.
  assertEquals(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
  // A plain routing token with no embedded scheme-relative URL is untouched.
  assertEquals(
    validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }], edges: [] }).filter(
      (e) => e.code === "scheme-relative-url-in-job-type",
    ),
    [],
  );
  // An opaque `owner/repo#42` PR ref (a `//`-less identifier) is not a URL and is not rejected.
  assertEquals(
    validateDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:review owner/repo#42" } }], edges: [] }).filter(
      (e) => e.code === "scheme-relative-url-in-job-type",
    ),
    [],
  );
});

test("#778 redactConnectorValue: an embedded USERINFO-LESS SCHEME-RELATIVE URL (`prefix //host/path?token=secret`, no explicit scheme, no `//…@` credential) has its `?query` secret redacted — the `?` after a `//authority` is unambiguously URL syntax — while an opaque `//host#42` PR ref (no `?`) keeps its meaningful `#42` (#778 review — thread deliveryGraph.ts:633)", () => {
  const q = redactConnectorValue("prefix //host/path?token=secret");
  assert(!q.includes("token=secret"), `a scheme-relative URL's query secret must be redacted: ${JSON.stringify(q)}`);
  // A userinfo-LESS opaque `//host#42` PR ref (no `?`) is preserved — nothing sensitive there.
  assertEquals(redactConnectorValue("prefix //host#42"), "prefix //host#42");
  assertEquals(redactConnectorValue("slack:#releases"), "slack:#releases");
  assertEquals(redactConnectorValue("owner/repo#42"), "owner/repo#42");
});

test("#778 redactConnectorValue: a WHOLE-value opaque scheme-relative PR ref (`//host#42` — no explicit scheme, no `//…@` credential, no `?query`) keeps its meaningful `#42` exactly like the embedded `prefix //host#42` form; `isUrlShaped` matches the scheme-relative `//authority`, so without the opaque-PR-ref exception the whole-value branch would `redactString` the `#42` → `#***`, an inconsistency with the embedded contract (#778 review — thread deliveryGraph.ts:198)", () => {
  // Whole-value opaque `//host#42` PR ref survives — matches the embedded `prefix //host#42` contract.
  assertEquals(redactConnectorValue("//host#42"), "//host#42");
  // A leading-whitespace opaque ref (isUrlShaped trims before its anchored check) also survives.
  assertEquals(redactConnectorValue(" //host#42"), " //host#42");
  // But a whole-value URL that actually hides a credential is STILL fully redacted:
  // — an explicit `scheme://…#fragment` (fragment IS URL syntax):
  assertEquals(redactConnectorValue("https://host#42"), "https://host#***");
  // — a `//user:pass@host#42` userinfo credential (userinfo marks it a URL, so `#` is URL syntax):
  assertEquals(redactConnectorValue("//user:pass@host#42"), "//***@host#***");
  // — a userinfo-less `//host?token=secret` query (the `?` after `//authority` is unambiguously URL syntax):
  const wholeQ = redactConnectorValue("//host?token=secret");
  assert(!wholeQ.includes("token=secret"), `a whole-value scheme-relative URL's query secret must be redacted: ${JSON.stringify(wholeQ)}`);
  // — a NON-NUMERIC fragment is NOT a PR ref: only `#<digits>` (`parsePrTarget`) is a valid PR handle,
  //   so `//host#access-token` is an ordinary scheme-relative URL whose fragment can hide a secret and
  //   MUST be redacted like any other URL fragment — the opaque-PR-ref exception must not swallow it
  //   (#778 review — thread deliveryGraph.ts:206).
  const nonNumericFrag = redactConnectorValue("//host#access-token");
  assert(
    !nonNumericFrag.includes("access-token"),
    `a whole-value //host#<non-numeric> fragment is not a PR ref and must be redacted: ${JSON.stringify(nonNumericFrag)}`,
  );
  // The numeric PR ref itself still survives (regression guard for the exception's happy path):
  assertEquals(redactConnectorValue("//host#42"), "//host#42");
});

test("S7 guard-default-conflict: an edge with both `default` and `when` is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "bump", to: "a", when: "bump.result", equals: "x", default: true }],
  });
  hasCode(errors, "guard-default-conflict");
});

test("S7 multiple-defaults: more than one `default` out-edge on a split is rejected", () => {
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
      { id: "c", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.result", equals: "x" },
      { from: "bump", to: "b", default: true },
      { from: "bump", to: "c", default: true },
    ],
  });
  hasCode(errors, "multiple-defaults");
});

test("S7 exclusive-merge-parity: a parallel AND-join fed by an exclusive-split branch is rejected (the deadlock shape)", () => {
  // `indep` always fires; `x` fires only on the "a" branch of `split`. A plain fan-in of {indep, x}
  // into `sink` would be a parallel AND-join that waits forever for `x` when the else-branch is taken.
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "split", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "x", kind: "agent", agent: { jobType: "j" } },
      { id: "y", kind: "agent", agent: { jobType: "j" } },
      { id: "indep", kind: "agent", agent: { jobType: "j" } },
      { id: "sink", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "split", to: "x", when: "split.result", equals: "a" },
      { from: "split", to: "y", default: true },
      { from: "x", to: "sink" },
      { from: "indep", to: "sink" },
    ],
  });
  hasCode(errors, "exclusive-merge-parity");
});

test("S7 default:false is not a default — a `default: false` sibling of a guard is a plain edge and MIXES the fan-out", () => {
  // `default` is a flag: only `true` marks the else-branch. `default: false` must NOT be treated as
  // present (else it silently escapes both the guarded and the plain classification and bypasses the
  // no-mixing rule). Here it must fall through to `plain` and trip mixed-fan-out.
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "bump", to: "a", when: "bump.result", equals: "x" },
      { from: "bump", to: "b", default: false },
    ],
  });
  hasCode(errors, "mixed-fan-out");
});

test("S7 exclusive-merge-parity: terminal nodes that MIX a conditional tail with an always-firing tail are rejected (the End-sink deadlock/double-fire shape)", () => {
  // `split` fans an exhaustive XOR to two leaves (`cond`/`other` — exactly one fires); `indep` always
  // fires. All three are graph leaves, so the End sink joins them. A parallel join there deadlocks on
  // the untaken branch; an exclusive merge double-fires when both `indep` and a branch arrive. The
  // validator must reject the mix so the compiler's End-gateway choice is sound.
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "split", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "cond", kind: "agent", agent: { jobType: "j" } },
      { id: "other", kind: "agent", agent: { jobType: "j" } },
      { id: "feed", kind: "agent", agent: { jobType: "j" } },
      { id: "indep", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "split", to: "cond", when: "split.result", equals: "a" },
      { from: "split", to: "other", default: true },
      { from: "feed", to: "indep" },
    ],
  });
  hasCode(errors, "exclusive-merge-parity");
});

test("S7 default-only node is NOT an exclusive split — a lone `default: true` out-edge always fires and must not mark downstream leaves conditional", () => {
  // `fork` unconditionally fans to `p` and `q` (a parallel fork). `q` has a SINGLE out-edge marked
  // `default: true` with no guarded `when` sibling — semantically that edge always fires, so `q` is
  // NOT an exclusive split. Leaves {p, z} are both always-firing and join cleanly at the End sink.
  // Deriving `splitNodes` from `when`-guarded edges only (not a lone `default`) keeps `q` off the
  // split set; treating a default-only node as a split spuriously marks `z` conditional and trips a
  // false End-sink exclusive-merge-parity error.
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "fork", kind: "agent", agent: { jobType: "j" } },
      { id: "p", kind: "agent", agent: { jobType: "j" } },
      { id: "q", kind: "agent", agent: { jobType: "j" } },
      { id: "z", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "fork", to: "p" },
      { from: "fork", to: "q" },
      { from: "q", to: "z", default: true },
    ],
  });
  assertEquals(errors, []);
});

test("S7 single-target guarded fan-out is NOT an exclusive split — a node whose guarded + default edges all converge on ONE downstream node has no real fan-out and must not mark that node conditional", () => {
  // `gate` has a guarded edge and a `default` edge that BOTH target `conv` — one distinct downstream
  // node, so there is no structural fan-out: `conv` fires whenever `gate` does. Deriving `splitNodes`
  // from "has a guarded edge" alone wrongly adds `gate` to the split set, marking `conv` conditional;
  // then leaves {conv, indep} look like a mixed conditional/always-firing End sink and trip a false
  // exclusive-merge-parity error. A split must fan to >=2 distinct targets to be exclusive.
  const errors = validateDeliveryGraph({
    nodes: [
      { id: "gate", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "conv", kind: "agent", agent: { jobType: "j" } },
      { id: "feed", kind: "agent", agent: { jobType: "j" } },
      { id: "indep", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "gate", to: "conv", when: "gate.result", equals: "a" },
      { from: "gate", to: "conv", default: true },
      { from: "feed", to: "indep" },
    ],
  });
  assertEquals(errors, []);
});

test("a wait node's onTimeout: fail is rejected (unsupported-on-timeout) while continue/escalate validate (#462)", () => {
  const waitWith = (onTimeout: string) => ({
    name: "onTimeout",
    nodes: [{ id: "g", kind: "wait", wait: { kind: "pr", target: "acme/repo#1", match: { prState: "merged" }, onTimeout } }],
    edges: [],
  });
  const err = hasCode(validateDeliveryGraph(waitWith("fail")), "unsupported-on-timeout");
  assertEquals(err.path, "nodes[0].wait.onTimeout");
  // continue + escalate are honored — they must NOT raise the unsupported-on-timeout error.
  assertEquals(validateDeliveryGraph(waitWith("continue")), []);
  assertEquals(validateDeliveryGraph(waitWith("escalate")), []);
});

// ── Pass 4 (#548): converge/wait PR late-binding ──────────────────────────────────────────────────

/** The canonical no-literal converge shape: `open` emits a `pr` fact, both the converge connector and
 * the pr-wait reference it (`open.pr`) on incoming fact edges. */
function noLiteralConverge(overrides?: {
  connectorPr?: unknown;
  waitTarget?: string;
  openEmitsPr?: boolean;
  edges?: { from: string; to: string }[];
}) {
  const emits = overrides?.openEmitsPr === false ? [{ name: "pr", type: "url" }] : [{ name: "pr", type: "pr" }];
  const connector =
    "connectorPr" in (overrides ?? {})
      ? { target: "converge-merge", payload: { pr: overrides?.connectorPr } }
      : { target: "converge-merge", payload: { pr: "open.pr" } };
  return {
    name: "no-literal converge",
    nodes: [
      { id: "open", kind: "agent", agent: { jobType: "senior:feature", prompt: "open a PR" }, emits },
      { id: "land", kind: "connector", connector },
      { id: "merged", kind: "wait", wait: { kind: "pr", target: overrides?.waitTarget ?? "open.pr", match: { prState: "merged" } } },
    ],
    edges: overrides?.edges ?? [
      { from: "open.pr", to: "land" },
      { from: "open.pr", to: "merged" },
    ],
  };
}

test("#548 a converge connector + pr-wait that reference a threaded `pr` fact validate", () => {
  assertEquals(validateDeliveryGraph(noLiteralConverge()), []);
});

test("#548 a LITERAL owner/repo#N PR on both the connector and the wait validates (no binding needed)", () => {
  const g = noLiteralConverge({ connectorPr: "acme/repo#12", waitTarget: "acme/repo#12", edges: [{ from: "open", to: "land" }, { from: "land", to: "merged" }] });
  assertEquals(validateDeliveryGraph(g), []);
});

test("#548 a PR reference that is NOT threaded by a fact edge is rejected (unbound-pr)", () => {
  // The connector/wait name `open.pr`, but the edges carry only a plain completion dependency — the
  // `pr` fact never flows in, so it can never late-bind.
  const g = noLiteralConverge({ edges: [{ from: "open", to: "land" }, { from: "land", to: "merged" }] });
  const errs = validateDeliveryGraph(g);
  const unbound = errs.filter((e) => e.code === "unbound-pr");
  assertEquals(unbound.length, 2, `both consumers are unbound: ${JSON.stringify(errs)}`);
  assert(unbound.some((e) => e.path === "nodes[1].connector.payload.pr"));
  assert(unbound.some((e) => e.path === "nodes[2].wait.target"));
});

test("#548 a PR reference to a non-`pr`-typed fact is rejected (unbound-pr)", () => {
  const g = noLiteralConverge({ openEmitsPr: false }); // `open` emits `pr` as a `url`, not `pr`
  const err = hasCode(validateDeliveryGraph(g), "unbound-pr");
  assert(err.message.includes("must reference a `pr`-typed fact") || err.message.includes('"url"'), err.message);
});

test("#548 a PR reference to an undeclared fact is rejected (unbound-pr)", () => {
  // `open` emits no facts, but the connector references `open.pr`.
  const g = {
    name: "undeclared ref",
    nodes: [
      { id: "open", kind: "agent", agent: { jobType: "j", prompt: "p" } },
      { id: "land", kind: "connector", connector: { target: "converge", payload: { pr: "open.pr" } } },
    ],
    edges: [{ from: "open", to: "land" }],
  };
  const err = hasCode(validateDeliveryGraph(g), "unbound-pr");
  assert(err.message.includes("does not declare"), err.message);
});

test("#548 a converge connector that OMITS payload.pr auto-binds a single threaded `pr` fact", () => {
  const g = {
    name: "omitted auto-bind",
    nodes: [
      { id: "open", kind: "agent", agent: { jobType: "senior:feature", prompt: "open" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "land", kind: "connector", connector: { target: "converge-merge" } },
    ],
    edges: [{ from: "open.pr", to: "land" }],
  };
  assertEquals(validateDeliveryGraph(g), []);
});

test("#548 a converge connector with NO PR at all is rejected (unbound-pr)", () => {
  const g = {
    name: "no pr",
    nodes: [
      { id: "open", kind: "agent", agent: { jobType: "j", prompt: "p" } },
      { id: "land", kind: "connector", connector: { target: "converge-merge" } },
    ],
    edges: [{ from: "open", to: "land" }],
  };
  const err = hasCode(validateDeliveryGraph(g), "unbound-pr");
  assert(err.message.includes("has no target PR"), err.message);
});

test("#548 a converge connector with MULTIPLE incoming `pr` facts is rejected as ambiguous (unbound-pr)", () => {
  const g = {
    name: "ambiguous pr",
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j", prompt: "p" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "b", kind: "agent", agent: { jobType: "j", prompt: "p" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "land", kind: "connector", connector: { target: "converge-merge" } },
    ],
    edges: [
      { from: "a.pr", to: "land" },
      { from: "b.pr", to: "land" },
    ],
  };
  const err = hasCode(validateDeliveryGraph(g), "unbound-pr");
  assert(err.message.includes("disambiguate"), err.message);
});

// Issue #858: the deterministic compile/lint-time guard for the partial-scope-close defect class.
// The field case (delivery graph `5e36636255ab`, node `i12`) paired a brief scoped to ONE of an
// issue's three acceptance criteria with "…open a PR that closes it", so the agent wrote `Closes #N`
// and the remainder was silently dropped. `validateDeliveryGraph` must now reject an `agent.prompt`
// that closes an issue WITHOUT an explicit full-scope acknowledgement marker.
test("#858 an agent prompt that closes an issue with NO full-scope marker is rejected (partial-scope-close)", () => {
  const g = {
    name: "partial close",
    nodes: [
      {
        id: "i12",
        kind: "agent",
        agent: {
          jobType: "senior:feature",
          // The exact field-case shape: scoped to one criterion, told to close the parent.
          prompt: "Implement criterion 1 of nanobpm/nano-supervisor#12 and open a PR that closes #12.",
        },
      },
    ],
    edges: [],
  };
  const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
  assertEquals(err.path, "nodes[0].agent.prompt");
});

test("#858 the closing-keyword families (closes/fixes/resolves, owner/repo#N, issue URL, and the pronoun form `closes it`) are all detected", () => {
  const closers = [
    "open a PR that closes #12",
    "this fixes nanobpm/nano-supervisor#12",
    "Resolves https://github.com/nanobpm/nano-supervisor/issues/12",
    "resolve #12 when done",
    // The LITERAL field case (delivery graph `5e36636255ab`, node `i12`): the issue is referenced by
    // name (`nano-supervisor#12`) and the closing verb uses the pronoun `it`, NOT a bare `#N`.
    "Implement nanobpm/nano-supervisor#12 and open a PR that closes it",
    "Implement #12 and close the issue",
  ];
  for (const prompt of closers) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

test("#858 a closing keyword WITH an explicit full-scope marker validates (the legitimate final closer)", () => {
  const ok = [
    "Implement nanobpm/nano-supervisor#12 — this brief delivers #12's full stated scope (every acceptance criterion) — and open a PR that closes #12.",
    "Own the whole issue: deliver every acceptance criterion of #12, then close #12.",
    "This slice covers the full scope of #12; open a PR with Closes #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The marker list must also recognise the NATURAL issue-anchored whole-scope paraphrases a planner
// writes when it genuinely scopes a slice to the whole issue — not only the exact phrases the
// contract happens to use verbatim. A legitimately full-scope closer phrased "the whole issue" /
// "all of #N" / "the entire issue" must NOT be rejected (the under-inclusive-marker false positive).
test("#858 a closing keyword WITH a natural issue-anchored whole-scope paraphrase validates", () => {
  const ok = [
    "Deliver the whole issue #12 and close it.",
    "Implement all of #12 and close it.",
    "Own the entire issue #12, then close it.",
    "This slice covers the complete issue #12; open a PR with Closes #12.",
    "Implement all of the issue #12 and resolve it.",
    "Deliver the whole of #12 and close it.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse guard: a bare adverb of completeness (`fully` / `completely` / `end-to-end` /
// `in full` / `in its entirety`) is NOT a full-scope marker, because it can modify a PARTIAL
// deliverable ("implement one criterion fully"). Only an issue-anchored whole-scope phrase licenses
// a closing keyword — a partial brief dressed in an adverb must still be rejected.
test("#858 a bare completeness adverb on a partial brief is STILL rejected (not a full-scope marker)", () => {
  const partials = [
    "Implement one criterion of #12 fully, then close #12.",
    "Do the parser slice of #12 completely; close #12.",
    "Implement part of #12 end-to-end and close it.",
    "This slice covers the login part of #12 in full; close it.",
    "Implement the backend portion of #12 in its entirety; close it.",
  ];
  for (const prompt of partials) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

test("#858 a non-closing reference (Part of / Refs) is NOT flagged, and a prompt with no issue ref is NOT flagged", () => {
  const ok = [
    "Implement criterion 1 of #12 and reference it as Part of #12.", // non-closing ref
    "Refs #12 — work on the first slice.",
    "un-draft + merge #B", // the WELL_FORMED prompt: `#B` is not a numeric issue ref
    "close the door behind you", // prose "close" with no issue ref
    "fix the bug in the parser", // closing verb but no issue ref
    "resolve conflicts in #12 merge", // closing verb not applied to the issue (intervening word)
    "closes the loop on #12 feedback", // closing verb not applied to the issue
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

test("#858 a non-agent node (human) carrying a closing keyword is NOT flagged — the guard is agent-scoped", () => {
  const g = {
    nodes: [{ id: "h", kind: "human", human: { prompt: "verify then close #12" } }],
    edges: [],
  };
  assertEquals(validateDeliveryGraph(g), []);
});

// Issue #858 (round-3 review): the full-scope acknowledgement must be TIED to the issue the brief
// closes, not accepted as a global substring anywhere in the prompt. Two bypass classes slip a
// partial-scope-close past a global-substring check and MUST be rejected:
//   (1) cross-issue — the marker acknowledges a DIFFERENT issue's scope than the one being closed
//       (e.g. acknowledge #11's full scope, but close #12);
//   (2) attributed-to-others — the whole-scope phrase assigns the scope to SIBLINGS/others, not to
//       this brief (e.g. "the full scope of #12 is handled by siblings; … close #12").
test("#858 a full-scope marker for a DIFFERENT issue than the one closed is rejected (cross-issue bypass)", () => {
  const bypasses = [
    // Marker anchored to #11, but the brief closes #12.
    "Acknowledge #11's full stated scope; implement criterion 1 of #12 and close #12.",
    "This covers the whole issue #11. Implement part of #12 and open a PR with Closes #12.",
    "Deliver every acceptance criterion of #11, then fix #12.",
    // SAME clause mixes a whole-scope marker for #11 with a partial reference to the closed #12 —
    // proximity anchoring must credit #11 (adjacent to the marker), not #12.
    "Covers the whole issue #11 and the parser part of #12. Closes #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

test("#858 a whole-scope phrase ATTRIBUTED to siblings/others does not licence a close (attribution bypass)", () => {
  const bypasses = [
    "The full scope of #12 is handled by siblings; implement criterion 1 and close #12.",
    "Every acceptance criterion of #12 is delivered by the other slices; do the parser part and close #12.",
    "The whole issue #12 is covered by sibling slices; implement criterion 2 and open a PR with Closes #12.",
    // Generic (un-numbered) marker attributed to others, single issue — still must not licence it.
    "The full scope is owned by another slice; implement part of #12 and close it.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-3 adversarial review): a whole-scope marker immediately followed by a
// PART-QUALIFIER scopes the acknowledgement DOWN to a part, so it must NOT licence a close. The
// marker-credit loop matched a bare substring, so "the whole issue's parser slice" / "all of #12's
// backend" / "every acceptance criterion's auth half" all credited the marker even though each
// describes a PARTIAL deliverable — the exact defect class the guard exists to catch. The occurrence
// is disqualified when the text right after the marker is `'s <part>` / `of <part>` (a possessive or
// partitive that narrows the whole to one slice).
test("#858 a whole-scope marker immediately qualified DOWN to a part is rejected (possessive/partitive bypass)", () => {
  const bypasses = [
    "Deliver the whole issue's parser slice. Closes #12.",
    "Implement all of #12's backend. Closes #12.",
    "Covers every acceptance criterion's auth half. Closes #12.",
    "Implement the complete issue's backend only. Closes #12.",
    "Deliver the whole issue's first half. Closes #12.",
    // Sibling-marker overlap: a prefix marker ("own the whole") ends before the connective "issue",
    // so the qualifier is not adjacent to THAT marker — the walk must see past the connective.
    "Own the whole issue #12's parser. Close it.",
    "Owns the whole issue's backend. Close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: the part-qualifier disqualifier must not over-fire on a legitimate whole-scope
// acknowledgement that merely has a part-word LATER in the clause (not immediately after the marker),
// or where the marker is at a clause boundary. A genuine full-scope closer must still validate.
test("#858 a whole-scope marker NOT immediately qualified down still validates", () => {
  const ok = [
    // Part-word appears later in the clause, NOT immediately after the marker.
    "Deliver the whole issue #12, including the parser slice, and close it.",
    // Marker at a clause boundary (next char is a delimiter / end).
    "Own the whole issue #12. Then close it.",
    "Implement all of #12 and close it.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse: a marker genuinely tied to the closed issue (anchored to it, or the sole issue the
// prompt references) and asserting THIS brief owns it must still validate — the target-association
// tightening must not regress the legitimate single-issue and issue-anchored closers.
test("#858 a full-scope marker tied to the closed issue still validates after the target-association tightening", () => {
  const ok = [
    // Anchored to the SAME issue that is closed.
    "Acknowledge #11 is out of scope; this brief delivers all of #12 and opens a PR with Closes #12.",
    // Generic marker, but the prompt references exactly one issue (#12) — unambiguous.
    "This slice covers the full stated scope; implement every acceptance criterion of #12 and close #12.",
    "Own the whole issue #12 — deliver every checkbox — then close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-4 review): issue identity must preserve the REPOSITORY, not collapse to the bare
// number. The accepted syntax includes `owner/repo#N` and issue URLs, and the validator supports
// cross-repository graphs, so an acknowledgement anchored to `owner/alpha#12` must NOT licence closing
// a DIFFERENT issue `owner/beta#12` — both used to become `12`. Each explicit-repo closing target
// requires its own repo-matched acknowledgement; a bare `#N` (the implicit node/run repo) is a third,
// distinct identity.
test("#858 a full-scope marker for one repo's issue does not licence closing a different repo's same-numbered issue (cross-repo collision)", () => {
  const bypasses = [
    // Acknowledge owner/alpha#12's full scope, but ALSO close owner/beta#12 (partial) — the collapse-to-12
    // bug credited beta from alpha's acknowledgement.
    "Deliver owner/alpha#12's full stated scope and close owner/alpha#12. Implement only criterion 1 of owner/beta#12 and close owner/beta#12.",
    // Marker anchored (after) to owner/alpha, close targets owner/beta.
    "Deliver the full scope of owner/alpha#12 and close owner/beta#12.",
    // A bare #12 acknowledgement must not licence closing an explicitly-qualified owner/alpha#12.
    "Deliver #12's full stated scope; implement part of owner/alpha#12 and close owner/alpha#12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: a repo-qualified marker genuinely tied to the SAME repo-qualified issue it closes must
// still validate — the repository-identity tightening must not regress a legitimate `owner/repo#N`
// closer, nor a bare `#N` closer (unchanged).
test("#858 a repo-qualified full-scope marker tied to the SAME repo-qualified issue it closes still validates", () => {
  const ok = [
    "Deliver owner/alpha#12's full stated scope and close owner/alpha#12.",
    "This slice delivers nanobpm/nano-supervisor#99's full stated scope; Closes nanobpm/nano-supervisor#99.",
    "Own the whole issue of owner/alpha#7 — every acceptance criterion — then close owner/alpha#7.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-4 review): a whole-scope phrase whose CLAUSE explicitly NEGATES or disclaims it
// ("this slice does NOT deliver the full scope of #12", "we won't cover every acceptance criterion")
// asserts the opposite of ownership, yet the bare `full scope` substring is still present. Such an
// occurrence must NOT licence a close — the negated clause reopens the exact partial-close bypass.
test("#858 a NEGATED/disclaimed full-scope acknowledgement does not licence a close (negation bypass)", () => {
  const bypasses = [
    "This slice does not deliver the full scope of #12; implement criterion 1 and close #12.",
    "We won't cover every acceptance criterion of #12 — just the parser. Close #12.",
    "This does not own the whole issue #12; close it.",
    "Implement part of #12; this is not the full scope of #12. Closes #12.",
    "Deliver everything other than the full scope of #12, then close #12.",
    // The "but"-as-exception idiom — a direct sibling of "other than"/"apart from": "all but X" /
    // "everything but X" mean "everything EXCEPT X", so the marker is disclaimed even though no
    // explicit negation token is present (adversarial review, issue #858 round 4).
    "Deliver all but the full scope of #12; close #12.",
    "This slice delivers everything but the full scope of #12. Closes #12.",
    "Implement all but one acceptance criterion of #12 — the full scope of #12 is NOT delivered here. Close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: the negation disqualifier must not over-fire on an AFFIRMATIVE whole-scope closer that
// merely contains an innocuous "no …" phrase ("with no gaps", "leaving nothing deferred") — those are
// not negations of the delivery. A genuine full-scope closer must still validate.
test("#858 an affirmative whole-scope closer with an innocuous 'no' phrase still validates (negation must not over-fire)", () => {
  const ok = [
    "Deliver the whole issue #12 with no gaps; close it.",
    "Own the whole issue #12, leaving nothing deferred, and close #12.",
    "This slice covers the full stated scope of #12 — no part is out of scope — then Closes #12.",
    // An affirmative "but" is NOT an exception disclaimer: "…, but split across two commits" and
    // "all but identical" do not disclaim the whole-scope marker in the same clause.
    "Deliver the full scope of #12, but split the work across two commits. Closes #12.",
    "Own the whole issue #12 — the plan is all but identical to the reference slice — then close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});


// Issue #858 (round-5 review, thread deliveryGraph.ts:453): a PART-QUALIFIER can narrow a whole-scope
// marker from EITHER side. The after-side was already caught (`the whole issue's parser`), but a PREFIX
// partitive ("half of every acceptance criterion of #12") slipped through — `every acceptance criterion`
// was credited to #12 while the preceding `half of` was never examined. Qualification must be detected
// on BOTH sides of the marker, so a prefix partitive disqualifies the occurrence just like a suffix one.
test("#858 a whole-scope marker narrowed by a PREFIX partitive is rejected (both-sides qualifier bypass)", () => {
  const bypasses = [
    "Implement half of every acceptance criterion of #12, then close #12.",
    "Deliver part of the whole issue #12 and close it.",
    "Cover some of every acceptance criterion of #12; Closes #12.",
    "Deliver a subset of every acceptance criterion of #12. Closes #12.",
    "Do a portion of the whole issue #12 and close #12.",
    "Ship a fraction of the full scope of #12 and close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: a whole-quantifier prefix ("all of" / "the whole of") is NOT a part-qualifier, and a
// marker merely preceded by an unrelated "… of …" phrase in the same clause must still validate.
test("#858 a whole-scope marker with a whole/benign prefix still validates (prefix-partitive must not over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12 and close #12.",
    "Implement all of #12 and close it.",
    "As part of the milestone, deliver the full scope of #12 and close #12.",
    "On behalf of the team, deliver every acceptance criterion of #12; Closes #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-5 review, thread deliveryGraph.ts:369): an EXCEPTION/REDIRECTION preposition
// (`without`, `rather than`, `other than`, `instead of`, …) negates the full-scope phrase only when it
// GOVERNS it — i.e. it sits BEFORE the marker. A TRAILING occurrence governs some OTHER phrase, so an
// affirmative closer with an unrelated trailing constraint ("the full scope of #12 WITHOUT regressions",
// "… RATHER THAN a piecemeal split") must NOT be read as scope negation and must still validate.
test("#858 an affirmative whole-scope closer with a TRAILING exception constraint still validates (negation must not over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12 without regressions; close #12.",
    "Deliver the full scope of #12 rather than a piecemeal split. Closes #12.",
    "Own the whole issue #12 instead of a thin vertical slice; close #12.",
    "Deliver every acceptance criterion of #12 with no feature left aside from the stretch goals noted elsewhere; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse of the above: a LEADING exception preposition that genuinely governs (negates) the
// marker must STILL disqualify — the trailing-is-benign fix must not reopen the leading-negation bypass.
test("#858 a LEADING exception preposition that governs the marker still disqualifies the close", () => {
  const bypasses = [
    "Deliver this slice without covering the full scope of #12; close #12.",
    "Implement #12's parser rather than the full scope of #12. Closes #12.",
    "Do the auth part instead of the whole issue #12 and close #12.",
    "Ship everything other than the full scope of #12, then close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-5 review, "Allow current-slice ownership in passive attribution",
// deliveryGraph.ts:354): a whole-scope phrase attributed to THIS slice ("delivered by this slice",
// "owned by the current slice") is an AFFIRMATIVE ownership assertion and must licence a close. Only
// attribution to SIBLINGS/OTHERS disqualifies. The old `<verb> by` alternative fired regardless of who
// followed `by`, wrongly rejecting first-person/current-slice passive phrasing.
test("#858 a whole-scope phrase attributed to THIS slice (passive self-ownership) still validates", () => {
  const ok = [
    "The full scope of #12 is delivered by this slice; close #12.",
    "Every acceptance criterion of #12 is covered by the current slice; Closes #12.",
    "The whole issue #12 is owned by me here; close it.",
    "The full stated scope of #12 is handled by this brief, so close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse: attribution to SIBLINGS/OTHERS (or a non-self team) must STILL disqualify — the
// self-ownership fix must not reopen the "handled by others" bypass.
test("#858 a whole-scope phrase attributed to OTHERS (incl. a non-self team) still disqualifies the close", () => {
  const bypasses = [
    "The full scope of #12 is handled by siblings; implement criterion 1 and close #12.",
    "Every acceptance criterion of #12 is delivered by the other slices; do the parser part and close #12.",
    "The full scope of #12 is delivered by the backend team; implement the UI and close #12.",
    "The whole issue #12 is owned by another slice; implement part and close it.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-5 review, "Support issue URLs in scope-anchor detection", deliveryGraph.ts:490):
// `issueRefsIn`/`closingTargets` parse issue URLs, but the whole-scope ANCHOR only recognised `#N` /
// `owner/repo#N`. So when a second issue reference made the sole-issue fallback unavailable, a
// URL-anchored full-scope acknowledgement was never credited and a legitimate closer was rejected.
test("#858 a full-scope marker anchored to an issue URL licences closing that URL's issue (multi-ref, no sole fallback)", () => {
  const ok = [
    "Deliver the full scope of https://github.com/acme/a/issues/12; note acme/b#7 is out of scope; close https://github.com/acme/a/issues/12.",
    "This brief covers the full scope of https://github.com/acme/a/issues/12 (acme/b#7 is handled elsewhere); Closes https://github.com/acme/a/issues/12.",
    // URL anchored AFTER the marker, with a second issue reference defeating the sole-issue fallback.
    "acme/b#7 is out of scope. The full scope of https://github.com/acme/a/issues/12 is delivered here; close https://github.com/acme/a/issues/12.",
    // URL anchored BEFORE the marker (possessive-style proximity): https://…/issues/12's full scope.
    "Deliver https://github.com/acme/a/issues/12's full scope; acme/b#7 is out of scope; close https://github.com/acme/a/issues/12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse: a URL-anchored acknowledgement for ONE issue must NOT licence closing a DIFFERENT
// issue (URL repo identity is preserved exactly like `owner/repo#N`).
test("#858 a full-scope marker anchored to one issue URL does not licence closing a different issue", () => {
  const bypasses = [
    "Deliver the full scope of https://github.com/acme/a/issues/12; implement part of acme/b#7 and close acme/b#7.",
    "Deliver the full scope of https://github.com/acme/a/issues/12 and close https://github.com/acme/b/issues/12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-5 adversarial review): the prefix-partitive guard required a literal `of` after the
// partitive, so the most common English partitive — `half the X` (NO `of`) — bypassed it: `half of the
// full scope` was caught but `half the full scope` was credited. The `of` is optional in English
// ("half the …", "part the …", "half my …"), so the qualifier must narrow the marker with or without it.
test("#858 a whole-scope marker narrowed by a prefix partitive with NO `of` is rejected (half-the bypass)", () => {
  const bypasses = [
    "Deliver half the full scope of #12; close #12.",
    "Deliver half the whole issue #12; close #12.",
    "Implement part the whole issue #12 and close it.",
    "Deliver half my full scope of #12; close #12.",
    "Cover half its full scope of #12. Closes #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: making the partitive `of` optional must not over-fire on a plain whole-scope marker, a
// whole-quantifier prefix, or a part-word used non-partitively earlier in the clause.
test("#858 a whole-scope marker with no partitive prefix still validates (optional-`of` must not over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12 and close #12.",
    "Implement all of #12 and close it.",
    "As part of the milestone, deliver the full scope of #12 and close #12.",
    // A part-word used NON-partitively (not governing the marker) must not disqualify.
    "Deliver the full scope of #12 from the halfway house; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-5 adversarial review): the self-exclusion lookahead added `our`/`us`/`my` to the
// self list, which opened an attribution-to-others hole — `delivered by OUR siblings` / `handled by OUR
// peers` were credited because the `<verb> by` alternative's lookahead failed on the leading `our` and
// the sibling/peer alternative didn't allow an intervening possessive. A possessive before a
// sibling/peer/other noun is still attribution to OTHERS, so it must disqualify.
test("#858 a whole-scope phrase attributed to OUR/THEIR siblings or peers does not licence a close (possessive attribution bypass)", () => {
  const bypasses = [
    "The full scope of #12 is delivered by our siblings; implement criterion 1 and close #12.",
    "The full scope of #12 is handled by our peers; implement criterion 1 and close #12.",
    "The full scope of #12 is delivered by our sibling slices; implement criterion 1 and close #12.",
    "The full scope of #12 is delivered by our other slices; implement criterion 1 and close #12.",
    "The full scope of #12 is delivered by their siblings; implement criterion 1 and close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: a possessive before a SELF noun ("our team", "our slice") is still self-ownership and
// must NOT be disqualified — the possessive allowance is scoped to the sibling/peer/other nouns only.
test("#858 a whole-scope phrase attributed to a SELF possessive (our team/slice) still validates", () => {
  const ok = [
    "The full scope of #12 is delivered by our team; close #12.",
    "The full scope of #12 is delivered by our slice; close #12.",
    "The full scope of #12 is delivered by this slice; close #12.",
    "The full scope of #12 is delivered by us; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-5 adversarial review): splitting `without` into a before-marker-only prefix check
// was a fail-open regression for a TRAILING delivery-negating `without` — `Deliver the full scope of #12
// WITHOUT COVERING the edge cases; close #12.` genuinely disclaims completeness yet was credited. The
// benign carve-out is `without <noun>` ("without regressions"); a trailing `without <delivery gerund>`
// (covering/delivering/finishing/implementing the scope) is still a disclaimer and must disqualify.
test("#858 a TRAILING `without <delivery gerund>` still disqualifies the close (trailing-negation regression)", () => {
  const bypasses = [
    "Deliver the full scope of #12 without covering the edge cases; close #12.",
    "Deliver the full scope of #12 without delivering the auth work; close #12.",
    "Deliver the full scope of #12 without finishing the parser; close #12.",
    "Deliver the full scope of #12 without implementing criterion 3; close #12.",
    "Deliver the full scope of #12 without completing the migration; close #12.",
    "Deliver the full scope of #12 without shipping the docs; close #12.",
    "Deliver the full scope of #12 without addressing the feedback; close #12.",
    // An adverb between `without` and the gerund still negates.
    "Deliver the full scope of #12 without fully covering the edge cases; close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: a trailing `without <noun>` (the benign carve-out the round-5 split was FOR) must still
// validate — only a trailing `without <delivery gerund>` negates, not every trailing `without`.
test("#858 a TRAILING `without <noun>` (benign constraint) still validates (gerund-only negation must not over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12 without regressions; close #12.",
    "Deliver the full scope of #12 without tests; close #12.",
    "Deliver the full scope of #12 without any regressions; close #12.",
    "Deliver the full scope of #12 without breaking changes; close #12.",
    "Deliver the full scope of #12 rather than a piecemeal split. Closes #12.",
    // A benign NOUN that merely looks like a delivery gerund ("a covering letter", "the building
    // blocks", "meeting notes") is an unrelated trailing constraint, NOT a scope disclaimer — the
    // article/determiner (or the noun sense) keeps it affirmative.
    "Deliver the full scope of #12 without a covering letter; close #12.",
    "Deliver the full scope of #12 without the building blocks; close #12.",
    "Deliver the full scope of #12 without meeting notes; close #12.",
    "Deliver the full scope of #12 without a finishing touch; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-6 review, thread deliveryGraph.ts:294): the closing-action/target grammar only
// accepted a closing verb directly adjacent to `#N`, a URL, or a pronoun — it MISSED the common
// explicit `issue #N` / `GitHub issue #N` noun phrase (`…open a PR that closes issue #12`). That still
// tells a partial node to close #12, so it must be detected (and its target extracted as #12).
test("#858 a partial brief that closes via an `issue #N` noun phrase is rejected (issue-#N closing form)", () => {
  const bypasses = [
    "Implement criterion 1 of #12 and open a PR that closes issue #12.",
    "Implement the parser part of #12; fixes GitHub issue #12.",
    "Do the auth slice of #12 and resolve issue #12.",
    // Plural `issues #N` noun phrase.
    "Implement one criterion of #12 and close issues #12.",
    // Repo-qualified noun-phrase target: acknowledge nothing, close owner/repo#12.
    "Implement part of owner/repo#12 and close issue owner/repo#12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: a FULL-scope closer phrased with the `issue #N` noun phrase must still validate — the
// new grammar must recognise the target so the marker's acknowledgement is correctly credited to it.
test("#858 a full-scope closer using the `issue #N` noun phrase still validates (issue-#N form must not over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12 and close issue #12.",
    "Own the whole issue #12, then open a PR that closes GitHub issue #12.",
    "This slice covers the full scope of owner/repo#12; resolve issue owner/repo#12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-6 review, thread deliveryGraph.ts:606): the core-negation check tested the marker's
// whole comma-bounded clause, so a negator governing an UNRELATED constraint coordinated onto the clause
// by `and` (`…full scope of #12 AND do not introduce regressions`) wrongly disqualified an affirmative
// full-scope closer. The check is now scoped to the marker's `and`-coordinated delivery assertion, so
// such a closer validates — while a negator in the marker's own segment still disqualifies.
test("#858 an affirmative closer whose `and`-coordinated constraint is negated still validates (unrelated-negation must not over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12 and do not introduce regressions; close #12.",
    "Deliver the full scope of #12 and never break the build; close #12.",
    "Own the whole issue #12 and do not add new dependencies, then close #12.",
    "Deliver every acceptance criterion of #12 and ensure it cannot be bypassed; close #12.",
    // The WITHOUT_DELIVERY disqualifier is scoped the same way: a trailing delivery gerund in an
    // `and`-coordinated sibling constraint governs that constraint, not the marker.
    "Deliver the full scope of #12 and refactor without breaking the build; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse of the above: a negator that GOVERNS the marker (in its own `and`-segment, or with no
// coordinator between it and the marker) must STILL disqualify — the assertion-scoping fix must not
// reopen the negation bypass. Likewise a `but without <gerund>` trailing disclaimer stays in-segment.
test("#858 a negator governing the marker still disqualifies after assertion-scoping (no reopened bypass)", () => {
  const bypasses = [
    "This slice does not deliver the full scope of #12 and close #12.",
    "Do the parser and never cover the full scope of #12; close #12.",
    "Deliver the full scope of #12 but without covering the auth; close #12.",
    "Implement one criterion and do not own the whole issue #12; close it.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-6 adversarial review, app/deliveryGraph.ts:666): the ATTRIBUTION disqualifier was
// still tested against the marker's WHOLE comma-bounded clause while its two negation siblings were
// scoped to the marker's `and`-coordinated delivery assertion — the SAME false-positive class round-6
// fixed for them. A legit full-scope closer carrying an UNRELATED `and`-coordinated attribution
// (`…full scope of #12 AND the regression suite is handled by another team`) was falsely flagged. The
// attribution check is now scoped to the delivery assertion too, so such a closer validates — while an
// attribution in the marker's OWN segment still disqualifies.
test("#858 an affirmative closer whose `and`-coordinated attribution is unrelated still validates (attribution scoped to the assertion)", () => {
  const ok = [
    "Deliver the full scope of #12 and the regression suite is handled by another team; close #12.",
    "Own the whole issue #12 and the docs are owned by a sibling slice, then close #12.",
    "Deliver every acceptance criterion of #12 and the migration is covered by our peers; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse: an attribution that GOVERNS the marker (in its own `and`-segment, or with no
// coordinator between it and the marker) must STILL disqualify — assertion-scoping the attribution
// check must not reopen the attribution bypass.
test("#858 an attribution governing the marker still disqualifies after assertion-scoping (no reopened bypass)", () => {
  const bypasses = [
    "The full scope of #12 is handled by siblings and close #12.",
    "The full scope of #12 is delivered by another team and close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-6 adversarial review, app/deliveryGraph.ts:671): scoping the core-negation check
// to the marker's `and`-segment opened a fail-open regression — a GENUINE disclaimer that sits AFTER
// the marker in an `and`-segment (`…full scope of #12 AND it is not fully delivered`) was shed from
// the segment and no longer disqualified, where the pre-round whole-clause test caught it. An
// after-marker negation that REFERENCES DELIVERY (a delivery verb / `it` referring back to the scope)
// still disclaims the marker and must disqualify — while an after-marker negation of an UNRELATED
// constraint (`…AND do not introduce regressions`) stays affirmative.
test("#858 an after-marker negation that references delivery still disqualifies (fail-open regression closed)", () => {
  const bypasses = [
    "Deliver the full scope of #12 and it is not fully delivered; close #12.",
    "Deliver the full scope of #12 and we cannot deliver the edge cases; close #12.",
    "Own the whole issue #12 and it is never fully covered, then close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-7 review, app/deliveryGraph.ts:298/342 — "Exclude negated closing actions"): the
// closing-action detector matched a closing verb even when it was DIRECTLY NEGATED, so a safe
// partial-slice brief that explicitly forbids the close (`Implement criterion 1 of #12. Do not close
// #12; use Part of #12.`) — which follows the partial-slice contract — was wrongly rejected as
// `partial-scope-close`, blocking a legitimate graph at compile/dispatch time. A directly-negated close
// (`do not close`, `don't close`, `never close`) is the OPPOSITE of the defect (a part-scope node told
// TO close), so it must not count as a closing action.
test("#858 a directly-negated close is not a partial-scope-close (safe partial-slice brief validates)", () => {
  const ok = [
    "Implement criterion 1 of nanobpm/nano-supervisor#12. Do not close #12; use Part of #12.",
    "Implement criterion 1 of #12. Don't close #12.",
    "Work on one slice of #12; never close #12 — that is the epic's job.",
    "Implement part of #12. Do not resolve #12. Do not fix #12.",
    "Scope: one criterion of #12. Do not simply close it; leave the parent open.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse: negating ONE close must not blind the guard to a DIFFERENT active close, and a
// double-negative idiom (`do not forget to close`) is still an active close instruction. Both must stay
// flagged — the negation refinement must not reopen the partial-scope-close bypass.
test("#858 a negated close must not mask a sibling active close (no reopened bypass)", () => {
  const bypasses = [
    // #34 is actively closed with no full-scope marker; the negated #12 must not suppress detection.
    "Implement criterion 1 of #12. Do not close #12, but close #34.",
    // "do not forget to close" INSTRUCTS the close — a double negative, still a partial-scope-close.
    "Implement criterion 1 of #12. Do not forget to close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-7 review, app/deliveryGraph.ts:378 — "Distinguish implementation methods from
// alternate ownership"): the broad `<completion verb> by <non-self>` attribution branch mistook an
// implementation METHOD (a gerund describing HOW the scope is delivered) for attribution to another
// owner, because the method word is not on the self allowlist. `The full scope of #12 is implemented by
// updating the parser; close #12.` was wrongly rejected. A `by <gerund>` means-clause is the slice's
// own method, not another actor, so it must stay a valid full-scope acknowledgement.
test("#858 a `by <implementation method>` gerund is the slice's own method, not attribution (validates)", () => {
  const ok = [
    "The full scope of #12 is implemented by updating the parser; close #12.",
    "Deliver the full scope of #12, satisfied by adding the missing migration; close #12.",
    "The whole issue #12 is delivered by carefully refactoring the module, then close #12.",
    "Own the full scope of #12, completed by wiring up the remaining handlers; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// The converse: attribution to another ACTOR (not a gerund method) must STILL disqualify — the
// gerund-method carve-out must not reopen the attribution bypass. A determiner before an `-ing` word
// (`by the training team`) makes it an actor noun phrase, not a method, so it still disqualifies.
test("#858 attribution to another actor still disqualifies after the gerund-method carve-out (no reopened bypass)", () => {
  const bypasses = [
    "The full scope of #12 is handled by siblings; close #12.",
    "The full scope of #12 is delivered by the other slices; close #12.",
    "The full scope of #12 is implemented by the platform team; close #12.",
    "The full scope of #12 is delivered by the training team; close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-8 adversarial review, app/deliveryGraph.ts:411 — "gerund-method lookahead fails
// open on a bare `-ing` noun actor"): the round-7 lookahead `(?!(?:\w+ly\s+)?\w+ing\b)` excluded ANY
// bare `-ing` word after `by`, so attribution to a real actor whose name ends in `-ing` (`owned by
// engineering`, `handled by marketing`, `covered by staffing`) no longer disqualified — a fail-OPEN
// regression vs. round-6 (no lookahead). The carve-out must exclude only a gerund that GOVERNS an
// object (a means-clause like `by updating the parser`), not a bare terminal `-ing` noun.
test("#858 a bare `-ing` noun actor still disqualifies after the gerund-method carve-out (no fail-open regression)", () => {
  const bypasses = [
    "The full scope of #12 is owned by engineering; close #12.",
    "The full scope of #12 is handled by marketing; close #12.",
    "The full scope of #12 is covered by staffing; close #12.",
    "The full scope of #12 is delivered by engineering; close #12.",
    "The full scope of #12 is owned by engineering and product; close #12.",
    "The full scope of #12 is handled by marketing or sales; close #12.",
    "The full scope of #12 is provided by consulting; close #12.",
    "The full scope of #12 is owned by engineering that reports to product; close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …while a genuine means-clause — a gerund GOVERNING an object — is still the slice's own method and
// must validate (the round-7 carve-out's intent, preserved).
test("#858 a gerund governing an object is still a method, not attribution (validates)", () => {
  const ok = [
    "The full scope of #12 is implemented by updating the parser; close #12.",
    "The full scope of #12 is satisfied by doing it; close #12.",
    "The full scope of #12 is addressed by filing tickets; close #12.",
    "The full scope of #12 is met by quietly shipping it; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-8 adversarial review, app/deliveryGraph.ts:361 — "NEGATED_CLOSE_PREFIX misses the
// `not to close` infinitive"): the negator→verb gap admitted only adverbs, so the `to` of the
// infinitive (`Remember not to close #12.`, `Be sure not to close #12.`) was not admitted and a brief
// that forbids the close this way was still rejected. The gap now admits an optional `to`.
test("#858 a `not to close` infinitive is a negated close, not a partial-scope-close (validates)", () => {
  const ok = [
    "Implement criterion 1 of #12. Remember not to close #12; use Part of #12.",
    "Implement one slice of #12. Be sure not to close #12.",
    "Implement criterion 1 of #12. Do not simply blindly close it.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// …and admitting `to` must not reopen the double-negative bypass: `do not forget to close` still
// INSTRUCTS the close (a verb sits between the negator and `to`), so it stays flagged.
test("#858 admitting `to` keeps `do not forget to close` an active close (no reopened bypass)", () => {
  const bypasses = [
    "Implement criterion 1 of #12. Do not forget to close #12.",
    "Implement criterion 1 of #12. Do not hesitate to close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-8 review, "Support optional colon after closing keywords", deliveryGraph.ts:301 and
// the mirrored target regex / scope-classify.md): GitHub also closes on the colon form (`Closes: #12`),
// but the prefilter and target regex required the issue target immediately after whitespace, so a
// partial brief using the colon form produced NO `partial-scope-close` error even though GitHub would
// close the issue. Both patterns now accept the optional colon.
test("#858 the colon closing form (`Closes: #12`) is detected as a partial-scope-close", () => {
  const bypasses = [
    "Implement criterion 1 of #12. Closes: #12.",
    "Implement the parser slice of #12. Fixes: #12.",
    "Do the UI part of nanobpm/nano-supervisor#12. Resolves: nanobpm/nano-supervisor#12.",
    "Implement one criterion of #12. Closes:#12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …and the colon form carrying a genuine full-scope acknowledgement still validates (the colon change
// must widen detection, not over-fire on a legitimate full-scope closer).
test("#858 the colon closing form with a full-scope acknowledgement validates", () => {
  const ok = [
    "Deliver the full scope of #12. Closes: #12.",
    "This slice owns the whole issue #12. Fixes: #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-8 review, app/deliveryGraph.ts:366 — "Distinguish additive not-just constructions
// from negation"): the negator gap admitted `just`/`only`, so an ADDITIVE `not just/only … ; also …`
// correlative (`Do not just close #12; also add a release note` — the close STILL happens) was treated as
// a negated close and the partial brief validated. The additive correlative now re-activates the close.
// (Round-8 adversarial review narrowed the trigger: the additive signal is the `also`/`as well`/`too`
// continuation, never a bare `but`, so these cases all carry an explicit additive word.)
test("#858 an additive `not just/only … ; also/but …` close is a partial-scope-close (not a negation)", () => {
  const bypasses = [
    "Implement criterion 1 of #12. Do not just close #12; also add a release note.",
    "Implement one slice of #12. Do not only close #12, but also update the docs.",
    "Do the parser part of #12. Don't just close #12; also open a follow-up.",
    "Implement part of #12. Do not only close #12 but also notify the team.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …but a genuine negated close with a merely/simply/just manner-adverb and NO additive continuation
// stays a safe partial-slice brief (the additive carve-out must not reopen the negated-close false
// positive the round-7 fix closed).
test("#858 a `not simply/just/merely close` with no additive continuation stays a safe negated close", () => {
  const ok = [
    "Scope: one criterion of #12. Do not simply close it; leave the parent open.",
    "Implement criterion 1 of #12. Do not just close #12.",
    "Implement one slice of #12. Do not merely close #12 — leave it open.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-8 review, app/deliveryGraph.ts:427 — "Detect active-voice sibling ownership
// attribution"): the attribution check only detected the PASSIVE `delivered by siblings`. An active-voice
// `Siblings deliver the full scope of #12; … close #12.` credited the marker even though siblings — not
// this node — own the scope, restoring the attribution bypass. Active-voice sibling/other ownership now
// disqualifies the marker too.
test("#858 active-voice sibling/other ownership disqualifies the full-scope marker (no attribution bypass)", () => {
  const bypasses = [
    "Siblings deliver the full scope of #12; implement criterion 1 and close #12.",
    "The other slices own every acceptance criterion of #12; do the parser part and close #12.",
    "Peers handle the full scope of #12; implement the UI and close #12.",
    "Another slice covers the whole issue #12; implement part and close it.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …while active-voice ownership by THIS slice is an affirmative assertion and must still validate (the
// active-voice check must fire only on OTHERS, never reopen a self-ownership false positive).
test("#858 active-voice self ownership still validates (active-voice check fires only on others)", () => {
  const ok = [
    "This slice delivers the full scope of #12; close #12.",
    "This brief covers every acceptance criterion of #12, so close #12.",
    "I own the whole issue #12; close it.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-8 adversarial review): the round-8 additive trigger admitted a BARE `but` as an
// additive continuation. A genuine CONTRASTIVE `but` after a negated close (`Do not just close it; but
// leave the parent open`) is a SAFE negated close — the `but` introduces a contrast, not an added action
// — yet it was re-activated and flagged, a FALSE-POSITIVE REGRESSION vs. round-7. The additive signal is
// the correlative `also`, never a bare `but`, so a bare `but` must NOT reinstate the close.
test("#858 a contrastive `but` after a negated close is NOT an additive continuation (no false positive)", () => {
  const ok = [
    "Scope: one criterion of #12. Do not just close it; but leave the parent open.",
    "Do not only close #12, but never reopen it.",
    "Implement one slice of #12. Do not just close #12; but do add a note.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// …while the correlative `not only X but ALSO Y` still instructs the close — the additive signal is the
// `also`, so requiring it keeps the cited bypass flagged without the bare-`but` false positive.
test("#858 the correlative `not only … but also …` close still flags (additive via `also`)", () => {
  const bypasses = [
    "Implement one slice of #12. Do not only close #12, but also update the docs.",
    "Implement criterion 1 of #12. Do not just close #12; but also add a release note.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-8 adversarial review): the correlative re-activation fired only on `just`/`only`, so
// the SAME additive construction with another manner adverb (`merely`/`simply`/`basically`) + an `also`
// continuation stayed a false negation and the partial close validated. The additive signal is the `also`
// continuation, not the specific adverb, so the correlative class now spans the manner-adverb family.
test("#858 an additive `not merely/simply/basically … ; also …` close is a partial-scope-close", () => {
  const bypasses = [
    "Implement criterion 1 of #12. Do not merely close #12; also add a note.",
    "Implement one slice of #12. Do not simply close #12; also update the docs.",
    "Do the parser part of #12. Do not basically close #12; also open a follow-up.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …while the synonymous additive continuation `as well` (in place of `also`) still instructs the close —
// `Do not just close #12; add a note as well.` performs the close AND adds a note. (A bare `too` is NOT
// treated as additive: it is also the intensifier `too risky/early`, which would over-fire on a safe
// negated close — a fail-closed tradeoff that keeps `too` a safe negation.)
test("#858 an additive `not just/only … ; … as well` close is a partial-scope-close", () => {
  const bypasses = [
    "Implement criterion 1 of #12. Do not just close #12; add a note as well.",
    "Implement one slice of #12. Do not only close #12; update the docs as well.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …and a bare `too` is the INTENSIFIER (`too risky`/`too early`) as often as the additive (`add a note
// too`), so it is deliberately NOT an additive trigger — a safe negated close followed by a `too <adj>`
// constraint stays a safe negated close (the additive widening must not over-fire on the intensifier).
test("#858 a `too <adjective>` intensifier after a negated close is NOT additive (no false positive)", () => {
  const ok = [
    "Implement criterion 1 of #12. Do not just close #12; it is too risky.",
    "Implement one slice of #12. Do not only close #12; it is too early to ship.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-8 adversarial review): the active-voice attribution subject allowlist omitted the
// common actor nouns, so an active-voice `The team / another team / the upstream slice delivers the full
// scope of #12` bypassed — asymmetric with the passive `handled by the team`, which already disqualifies.
test("#858 active-voice team/upstream-slice ownership disqualifies the full-scope marker", () => {
  const bypasses = [
    "The team delivers the full scope of #12; implement criterion 1 and close #12.",
    "Another team owns the whole issue #12; implement criterion 1 and close #12.",
    "The upstream slice delivers the full scope of #12; implement criterion 1 and close #12.",
    "Other teams handle every acceptance criterion of #12; do the parser part and close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-8 adversarial review): the colon fix admitted only a single optional colon, so a
// doubled colon (`Closes:: #12` / `Closes: : #12`) — which GitHub's trailing-colon trim still closes —
// was not detected and the partial close validated.
test("#858 the double-colon closing form (`Closes:: #12`) is detected as a partial-scope-close", () => {
  const bypasses = [
    "Implement criterion 1 of #12. Closes:: #12.",
    "Implement the parser slice of #12. Fixes: : #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-9 review, app/deliveryGraph.ts:660 — "Preserve subjects when splitting compound
// predicates"): `deliveryAssertionAround` splits the marker's clause at EVERY `and`, so a compound
// predicate (`Siblings plan and deliver the full scope of #12`) drops the segment containing the
// grammatical SUBJECT (`Siblings plan`) and leaves only `deliver the full scope…` in the assertion —
// `SCOPE_ACTIVE_VOICE_OTHERS` then cannot see the `Siblings` actor and the attribution bypass returns.
// A compound predicate shares ONE subject across both verbs, so the subject must be retained when the
// post-`and` segment is a bare verb phrase (no new subject of its own).
test("#858 a compound-predicate subject is retained for active-voice attribution (no bypass)", () => {
  const bypasses = [
    "Siblings plan and deliver the full scope of #12; implement criterion 1 and close #12.",
    "The other slices design and own the whole issue #12; implement part and close it.",
    "Peers build and handle the full scope of #12; implement the UI and close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …while an `and` that coordinates an INDEPENDENT constraint (its own subject + verb) still splits the
// assertion, so a disqualifier governing that OTHER constraint does not disqualify the marker (the
// round-6 scoping guarantee is preserved — only a shared-subject compound predicate retains the subject).
test("#858 an independent `and`-coordinated constraint still splits the assertion (no over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12 and the regression suite is handled by another team; close #12.",
    "Deliver the full scope of #12 and do not introduce regressions; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-9 review, app/deliveryGraph.ts:478 — "Treat our team as self-ownership in active
// voice"): the others-subject pattern admitted an optional `our` before `team`, so `Our team delivers the
// full scope of #12` was classified as EXTERNAL ownership and rejected — even though the passive
// equivalent `delivered by our team` is explicitly treated as valid SELF-ownership. `our team` is the
// current slice, so it must NOT disqualify; `the/another/other team` still do.
test("#858 active-voice `our team` is self-ownership and validates (active check fires only on others)", () => {
  const ok = [
    "Our team delivers the full scope of #12; close #12.",
    "Our team owns the whole issue #12; close it.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// …while `the team` / `another team` / `other teams` (no self-possessive) remain OTHERS and still
// disqualify — the self-carve-out is only for the `our`-possessive self-reference.
test("#858 active-voice `the/another/other team` still disqualifies (not self)", () => {
  const bypasses = [
    "The team delivers the full scope of #12; implement criterion 1 and close #12.",
    "Another team delivers the full scope of #12; implement criterion 1 and close #12.",
    "Other teams deliver the full scope of #12; implement criterion 1 and close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-9 review, "Previously missed", app/deliveryGraph.ts:303 — "Recognize possessive
// pronouns in closing targets"): the closing grammar accepted `it`/`the issue`/`that issue`/`this issue`
// but not the POSSESSIVE `its issue`, so `…open a PR that closes its issue.` produced no
// `partial-scope-close`. The possessive-pronoun form is now an (unresolved/pronoun) closing target in
// both the prefilter and `CLOSING_TARGET_PATTERN`.
test("#858 the possessive-pronoun close (`closes its issue`) is detected as a partial-scope-close", () => {
  const bypasses = [
    "Implement criterion 1 of #12 and open a PR that closes its issue.",
    "Implement the parser slice of #12; a follow-up PR resolves its issue.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …while a full-scope marker still licenses the possessive-pronoun close (the new target is only a
// detection widening — the legitimate final closer that owns the whole scope still validates).
test("#858 a full-scope marker licenses the `closes its issue` form (no false positive)", () => {
  const ok = [
    "Deliver the full scope of #12 and open a PR that closes its issue.",
    "This slice covers every acceptance criterion of #12; the PR resolves its issue.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-9 adversarial review, app/deliveryGraph.ts:715): the compound-predicate
// subject-retention heuristic (`COMPOUND_PREDICATE_LEAD`) admits an ADVERB-LED continuation
// (`(?:\w+ly\s+)?`), so `deliveryAssertionAround` correctly retains the subject for `Siblings plan and
// carefully deliver the full scope of #12` — but the retained assertion then failed
// `SCOPE_ACTIVE_VOICE_OTHERS`, whose verb had to sit within `(?:\w+\s+){0,2}?` of the subject and so
// could not reach across the `and carefully` coordinator gap. The exact active-voice attribution bypass
// the compound-predicate fix exists to close still worked the moment one adverb was inserted. The
// subject-to-verb window now also spans a coordinator (`and`/`or`/`then`) plus adverbs.
test("#858 an adverb-led compound predicate still attributes the scope to its others-subject", () => {
  const bypasses = [
    "Siblings plan and carefully deliver the full scope of #12; implement criterion 1 and close #12.",
    "The other slices design and quickly own the whole issue #12; implement part and close it.",
    "Peers build and then handle the full scope of #12; implement the UI and close #12.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// …while widening that window must NOT over-fire onto an affirmative SELF assertion that merely has a
// coordinator+adverb before its verb, nor re-admit an independent `and`-coordinated constraint (the
// round-6 scoping guarantee).
test("#858 the widened subject-to-verb window does not over-fire on self or independent constraints", () => {
  const ok = [
    "This slice plans and carefully delivers the full scope of #12; close #12.",
    "We design and then implement every acceptance criterion of #12; close #12.",
    "Deliver the full scope of #12 and the regression suite is carefully maintained by another team; close #12.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// Issue #858 (round-9 adversarial review, app/deliveryGraph.ts:482): the `our team` self-carve-out
// restructured the team alternative to REQUIRE a determiner (`(?:(?:the|their|another|other)\s+)teams?`),
// so the previously-flagged BARE `Team delivers the full scope of #12` / `Teams deliver …` (no
// determiner) regressed to validating — a fail-open regression vs. the round-entry code, whose optional
// determiner `(?:(?:the|our|their)\s+)?` still covered the bare form. The determiner is optional again
// but now excludes `our` specifically, so bare `team`/`teams` is others-attribution while `our team`
// stays self-ownership.
test("#858 active-voice BARE `team`/`teams` (no determiner) still disqualifies (not self)", () => {
  const bypasses = [
    "Team delivers the full scope of #12; implement criterion 1 and close #12.",
    "Teams deliver the full scope of #12; implement criterion 1 and close #12.",
    "Team owns the whole issue #12; implement part and close it.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// Issue #858 (round-10 review, app/deliveryGraph.ts:303 — "Handle issue-first and passive closing
// directives"): the closing grammar recognised only VERB-BEFORE-OBJECT forms (`close #12`,
// `closes issue #12`), so a partial brief that phrases the SAME instruction with the issue as the
// SUBJECT of a passive/participial close — `Implement criterion 1 of #12 and ensure issue #12 is
// closed by the PR` — produced no error and validated. That is still a direct instruction to close
// the issue from a part-scope node, so the issue-first/passive form must be detected (and its target
// extracted) exactly like the active form.
test("#858 a partial brief that closes via an issue-first/passive directive is rejected (passive closing form)", () => {
  const bypasses = [
    // The cited case.
    "Implement criterion 1 of #12 and ensure issue #12 is closed by the PR.",
    // Bare-#N subject, auxiliaries, and the `get`-passive.
    "Implement criterion 1 of #12; #12 is closed by the PR.",
    "Implement criterion 1 of #12; #12 will be closed by the PR.",
    "Implement criterion 1 of #12; make sure #12 gets closed.",
    // Participial directive with no auxiliary.
    "Implement criterion 1 of #12; see #12 closed.",
    "Implement criterion 1 of #12 and mark #12 as resolved.",
    "Implement criterion 1 of #12; with #12 closed by the PR.",
    // Pronoun / `the issue` subjects and the other verb families.
    "Implement criterion 1 of #12; the issue is closed by the PR.",
    "Implement criterion 1 of #12; it is closed by the PR.",
    "Implement criterion 1 of #12; issue #12 is fixed by the PR.",
    "Implement criterion 1 of #12; GitHub issue #12 is resolved by the PR.",
    // Repo-qualified and URL subjects attribute the close to THAT issue.
    "Implement criterion 1 of owner/repo#12; issue owner/repo#12 is closed by the PR.",
    "Implement criterion 1 of #12; the issue at https://github.com/o/r/issues/12 is closed by the PR.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// The converse: the passive arm's subject is an issue REFERENCE, never a bare noun, so a benign
// passive about a non-issue subject must NOT be read as a closing directive — and a negated passive
// close (a safe partial-slice brief that forbids the close) must not over-fire either.
test("#858 a benign or negated passive does not over-fire the issue-first close detection (validates)", () => {
  const ok = [
    // Benign passives about a non-issue subject.
    "Implement criterion 1 of #12; the door is closed by the latch.",
    "Implement criterion 1 of #12; the PR is closed by the merge queue.",
    "Implement criterion 1 of #12; the ticket status is closed by automation.",
    "Implement criterion 1 of #12; the milestone is closed by the bot.",
    "Implement criterion 1 of #12; the window is fixed by the frame.",
    "Implement criterion 1 of #12; the door gets closed.",
    "Work on #12; the loop is closed by the feedback.",
    // A directly-negated passive close is a SAFE partial-slice brief, not a partial-scope-close.
    "Implement criterion 1 of #12 and ensure issue #12 is not closed by the PR.",
    "Implement criterion 1 of #12; issue #12 will not be closed by the PR.",
    "Implement criterion 1 of #12; the issue is never closed by this PR.",
    "Implement criterion 1 of #12; #12 isn't closed by this PR.",
    "Implement criterion 1 of #12; ensure the issue is not closed yet.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});

// A negator in an UNRELATED earlier clause must not mask an ACTIVE passive close — the passive
// negation check reads only the match's own auxiliary window, so a preceding `do not …` cannot
// suppress detection of a real close.
test("#858 an unrelated earlier negation does not mask an active passive close (no reopened bypass)", () => {
  const bypasses = [
    "Implement criterion 1 of #12; do not introduce regressions; issue #12 is closed by the PR.",
  ];
  for (const prompt of bypasses) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    const err = hasCode(validateDeliveryGraph(g), "partial-scope-close");
    assertEquals(err.path, "nodes[0].agent.prompt", `expected rejection for: ${prompt}`);
  }
});

// A FULL-scope closer phrased with the passive/issue-first form must still validate — the new grammar
// must recognise the target so the marker's acknowledgement is correctly credited to it.
test("#858 a full-scope closer using the issue-first/passive form still validates (must not over-fire)", () => {
  const ok = [
    "Deliver the full scope of #12; issue #12 is closed by this PR.",
    "Deliver the full scope of #12; #12 is closed by this PR.",
    "Deliver the full scope of #12; #12 gets closed by this PR.",
    "Deliver the full scope of owner/repo#12; issue owner/repo#12 is closed by this PR.",
  ];
  for (const prompt of ok) {
    const g = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j", prompt } }], edges: [] };
    assertEquals(validateDeliveryGraph(g), [], `expected no errors for: ${prompt}`);
  }
});
