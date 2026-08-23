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
