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

test("credential-in-job-type: a PASSWORDLESS userinfo token (`senior:feature //token@host`, no colon) is REJECTED — a bearer/OAuth token riding the userinfo is a credential too, and a routing key never contains `//…@` at all (#778 review push-back — thread readiness.ts:1170)", () => {
  const errors = validateDeliveryGraph({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature //tok3n@host" } }],
    edges: [],
  });
  const err = hasCode(errors, "credential-in-job-type");
  assert(!err.message.includes("tok3n"), `the credential-in-job-type message must redact the passwordless token, got: ${err.message}`);
});

test("#778 redactConnectorValue: an EMBEDDED `//user:pass@host` credential after a non-URL prefix (a `parsePrTarget` value like `prefix //user:pass@host#42`) is redacted, not echoed verbatim, while the meaningful `#42` PR ref and opaque `#`/`?` tokens survive (#778 review — thread deliveryGraph.ts:162/566)", () => {
  const out = redactConnectorValue("prefix //user:pass@host#42");
  assert(!out.includes("user:pass"), `an embedded credential must be redacted even without a URL prefix: ${out}`);
  assert(out.includes("//***@host"), `the userinfo collapses to the redaction marker: ${out}`);
  assert(out.includes("#42"), `the meaningful PR ref must survive (opaque-token behaviour): ${out}`);
  // A passwordless `//token@host` bearer token embedded after a prefix is redacted too.
  const bearer = redactConnectorValue("route //tok3n@host now");
  assert(!bearer.includes("tok3n") && bearer.includes("//***@host"), `a passwordless embedded token must be redacted: ${bearer}`);
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
