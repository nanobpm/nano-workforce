// nano-workforce — the pure, side-effect-free SEMANTIC validator for an agent-authored delivery
// graph (ADR 0005, slice S0). The `DeliveryGraph` SHAPE is validated at the edge by the openapi
// schema (`openapi.yaml` → generated `DeliveryGraph` contract); this module validates the semantics
// the JSON Schema CANNOT express and that a compiler/runner must be able to trust before it does
// anything:
//
//   • unknown `kind` — a node whose `kind` is not in the CLOSED allowlist (the trust boundary,
//     Decision 1/2). Defensive because the body arrives untyped from a request.
//   • duplicate node id — two nodes sharing an id, which would make every edge to it ambiguous.
//   • dangling edge — an edge endpoint (`from`/`to`) that names no node in the graph.
//   • bad `from` reference — a qualified `<nodeId>.<fact>` whose fact is not declared in that node's
//     typed `emits[]` (Decision 3/4 — binds are validated, not stringly).
//   • cycle — the edge set must be a DAG (discovered-fact dependencies flow forward only).
//
// It is modelled on the epic-set validator `validateEpicSet` (app/plan.ts): a PURE in-memory walk
// that runs BEFORE any side effect. Unlike `validateEpicSet` (which throws at the first offending
// edge), this COLLECTS every error and returns them, so a co-designing agent gets ONE actionable,
// path-qualified list per compile attempt (the S1 compiler surfaces them as `{ ok:false, errors }`).
// Every error carries a JSON-path-qualified `path` (`nodes[2].kind`, `edges[1].from`, …) so the
// caller can point the author straight at the offending input.

/** The CLOSED node-kind allowlist (ADR 0005 Decision 2) — the trust boundary. Extensible only by a
 * deliberate ADR/PR (add the openapi variant + a case here), never by a graph author. Kept as the
 * single source of truth for "which kinds are legal" so the validator and any future compiler agree. */
export const DELIVERY_NODE_KINDS = ["agent", "wait", "human", "connector"] as const;

/** A node's `kind`, narrowed to the closed allowlist. */
export type DeliveryNodeKind = (typeof DELIVERY_NODE_KINDS)[number];

/** The CLOSED emitted-fact type allowlist (ADR 0005 Decision 3/4) — mirrors the `DeliveryFact.type`
 * enum in `openapi.yaml`. Kept as the single source of truth so the semantic validator rejects an
 * untyped/unknown fact type even when the OpenAPI shape validator is bypassed (a directly-invoked
 * delegate), since later compilation/execution steps rely on this allowlist. */
export const DELIVERY_FACT_TYPES = ["string", "number", "boolean", "artifact", "version", "url"] as const;

/** An emitted fact's declared `type`, narrowed to the closed allowlist. */
export type DeliveryFactType = (typeof DELIVERY_FACT_TYPES)[number];

/** The SCALAR emitted-fact types a guarded edge's `when` may reference (ADR 0005 S7). A guard is an
 * equality test `fact == literal`, so only a scalar (single-valued, comparable) fact can be guarded —
 * `artifact`/`version`/`url` are compound/opaque handles and are rejected as guard subjects. Kept as
 * the single source of truth so the validator and the compiler agree on what is guardable. */
export const DELIVERY_GUARD_SCALAR_TYPES = ["string", "number", "boolean"] as const;

/** A guardable scalar fact type, narrowed from the closed emitted-fact allowlist. */
export type DeliveryGuardScalarType = (typeof DELIVERY_GUARD_SCALAR_TYPES)[number];

/** True when `type` is a guardable SCALAR (`string`/`number`/`boolean`) — the closed set a `when`
 * guard may reference. */
export function isDeliveryGuardScalarType(type: unknown): type is DeliveryGuardScalarType {
  if (typeof type !== "string") return false;
  for (const t of DELIVERY_GUARD_SCALAR_TYPES) if (t === type) return true;
  return false;
}

/** A machine-readable classification of a semantic failure, so a caller can branch on the error
 * class (unknown-kind / dangling / cycle / bad-`from`) without string-matching the message. */
export type DeliveryGraphErrorCode =
  | "empty-graph"
  | "invalid-graph-name"
  | "too-many-nodes"
  | "too-many-edges"
  | "too-many-emits"
  | "missing-id"
  | "invalid-id"
  | "duplicate-id"
  | "unknown-kind"
  | "missing-config"
  | "missing-required-field"
  | "duplicate-fact"
  | "invalid-fact-name"
  | "invalid-fact-type"
  | "invalid-edges"
  | "dangling-edge"
  | "bad-from"
  | "self-edge"
  | "cycle"
  | "guard-missing-equals"
  | "guard-missing-when"
  | "guard-default-conflict"
  | "bad-when"
  | "guard-type-mismatch"
  | "mixed-fan-out"
  | "multiple-defaults"
  | "non-exhaustive-split"
  | "exclusive-merge-parity";

/** A single semantic validation failure. `path` is a JSON-path-qualified pointer at the offending
 * input (`nodes[2].kind`, `edges[1].from`, `nodes[0].emits[1].name`), `message` is human-actionable,
 * and `code` is the stable error class. Shaped so the S1 compiler can forward it verbatim as one of
 * its `{ ok:false, errors:[{ path, message }] }` entries. */
export interface DeliveryGraphError {
  readonly path: string;
  readonly message: string;
  readonly code: DeliveryGraphErrorCode;
}

/** Narrow an untyped value to a plain object so its fields can be read as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `kind` is a member of the closed allowlist. */
function isDeliveryNodeKind(kind: unknown): kind is DeliveryNodeKind {
  if (typeof kind !== "string") return false;
  for (const k of DELIVERY_NODE_KINDS) if (k === kind) return true;
  return false;
}

/** True when `type` is a member of the closed emitted-fact type allowlist. */
function isDeliveryFactType(type: unknown): type is DeliveryFactType {
  if (typeof type !== "string") return false;
  for (const t of DELIVERY_FACT_TYPES) if (t === type) return true;
  return false;
}

/** A fact `name` must be a bare identifier (no dots) — mirrors openapi's `DeliveryFact.name`
 * `^[A-Za-z_][A-Za-z0-9_]*$`. `resolveFrom` RELIES on fact names being dot-free (a node id MAY
 * contain dots) to disambiguate a qualified edge `from`, so the semantic validator re-enforces the
 * pattern INDEPENDENTLY of the OpenAPI shape gate: if that gate is bypassed (a direct delegate call,
 * a test, a future internal use), a dotted fact name could otherwise make `<nodeId>.<fact>` resolution
 * ambiguous and quietly build the wrong DAG — undermining the trust boundary this validator exists to
 * hold. */
export const FACT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const FACT_NAME_MAX_LENGTH = 128;

/** A node `id` must match openapi's `DeliveryNodeCommon.id` `^[A-Za-z_][A-Za-z0-9_.-]*$` and stay
 * within its 128-char cap. Re-enforced here INDEPENDENTLY of the OpenAPI shape gate because later
 * compile/render steps trust these ids: an id with whitespace, a leading digit, or an over-long value
 * could otherwise pass semantic validation (a bypassed shape gate — a direct delegate call, a test)
 * and then break id-based compilation/rendering downstream. Unlike a fact name, an id MAY contain
 * dots/hyphens — `resolveFrom` splits a qualified `from` on the LAST dot, so a dotted id stays
 * resolvable while dot-free fact names keep `<nodeId>.<fact>` unambiguous. */
const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NODE_ID_MAX_LENGTH = 128;

/** The graph's optional top-level `name` must match openapi's `DeliveryGraph.name` `maxLength: 255`.
 * Re-enforced here INDEPENDENTLY of the OpenAPI shape gate because later steps trust it: the compiler
 * feeds `graph.name` straight into `escapeXml(processName)` / `escapeMermaid`, so a NON-STRING name
 * (`.replace` is not a function) THROWS out of the compiler — a bypassed shape gate (a direct delegate
 * call, or a JSON-string body like the library import door's `graphJson`, where the OpenAPI schema
 * never touches the parsed value) would otherwise surface as an unhandled fault mapped to a 400 with
 * NO path-qualified `errors`, and an over-long name would be persisted despite violating the contract.
 * Validating it here turns both into a clean, path-qualified `invalid-graph-name` failure. Length is
 * counted by Unicode CODE POINT (`[...name].length`), matching openapi/JSON-Schema `maxLength`
 * semantics — NOT JS `String.length`, which counts UTF-16 code units and would reject an in-contract
 * name of ≤255 astral characters (e.g. emoji) as over-long. */
const GRAPH_NAME_MAX_LENGTH = 255;

/** Whole-graph fan-out caps mirroring openapi's `DeliveryGraph` array bounds (`nodes.maxItems: 256`,
 * `edges.maxItems: 1024`) and `DeliveryNodeCommon.emits.maxItems: 32`. Re-enforced here INDEPENDENTLY
 * of the OpenAPI shape gate because a bypassed gate (a direct delegate call, or a JSON-string body
 * like the library import/save doors' `graphJson`, where the schema never touches the parsed value)
 * would otherwise let an oversized-but-compilable graph reach the layout/compiler and be persisted —
 * both violating the declared contract and exposing the import path to avoidable CPU/memory growth. */
const GRAPH_MAX_NODES = 256;
const GRAPH_MAX_EDGES = 1024;
const NODE_MAX_EMITS = 32;

/** The per-kind config key a node of the given kind must carry (`agent` → `agent`, etc.). */
const CONFIG_KEY: Record<DeliveryNodeKind, string> = {
  agent: "agent",
  wait: "wait",
  human: "human",
  connector: "connector",
};

/** The REQUIRED non-empty-string fields inside each kind's per-kind config object, mirroring the
 * `required` lists in openapi (`DeliveryNodeAgent.agent.jobType`, the `ReadinessProbe.kind`/`target`
 * a `wait` reuses, `DeliveryNodeConnector.connector.target`). Re-enforced here INDEPENDENTLY of the
 * OpenAPI shape gate so that, when that gate is bypassed (a direct delegate call, a test, a future
 * internal use), a config object present-but-missing its required fields (e.g. `{ kind:"agent",
 * agent:{} }`) is rejected with an actionable error rather than passing semantic validation and
 * crashing a downstream compiler/runner that assumes those fields exist. `human` has no required
 * config field (its config is optional). Kept as the single source of truth so this list and openapi
 * agree. NOTE: field PRESENCE + non-emptiness is enforced here, not the `ReadinessProbe.kind` enum —
 * that enum evolves per slice (S2 adds `pr`), so enumerating it here would drift; the enum stays
 * owned by the shape gate / `app/readiness.ts`. */
const REQUIRED_CONFIG_FIELDS: Record<DeliveryNodeKind, readonly string[]> = {
  agent: ["jobType"],
  wait: ["kind", "target"],
  human: [],
  connector: ["target"],
};

/** Resolve an edge `from` endpoint against the known node set. A node id MAY itself contain dots (the
 * openapi id pattern allows them) while a fact name (an identifier) cannot, so resolution is
 * disambiguated by the node set rather than by naive splitting: (1) if the WHOLE string is a node id
 * it is a bare completion-fact reference (`nodeId`, no fact); (2) else split at the LAST dot and, if
 * the prefix is a node id, it is a qualified `<nodeId>.<fact>` reference; (3) else it is dangling —
 * return the whole string as the (unresolvable) node id so the caller reports it against `from`.
 * When BOTH interpretations resolve — the whole string is a node id AND its last-dot prefix is a
 * node that emits the suffix as a fact — the reference is genuinely ambiguous; surface it via
 * `ambiguousWith` so the caller rejects it (`bad-from`) rather than silently choosing the whole-node
 * reading and producing an unintended DAG. */
function resolveFrom(
  from: string,
  nodeFacts: ReadonlyMap<string, ReadonlySet<string>>,
): { nodeId: string; fact?: string; ambiguousWith?: { nodeId: string; fact: string } } {
  const dot = from.lastIndexOf(".");
  const split =
    dot > 0 && dot < from.length - 1 ? { prefix: from.slice(0, dot), suffix: from.slice(dot + 1) } : undefined;
  if (nodeFacts.has(from)) {
    if (split !== undefined && nodeFacts.get(split.prefix)?.has(split.suffix)) {
      return { nodeId: from, ambiguousWith: { nodeId: split.prefix, fact: split.suffix } };
    }
    return { nodeId: from };
  }
  if (split !== undefined && nodeFacts.has(split.prefix)) return { nodeId: split.prefix, fact: split.suffix };
  return { nodeId: from };
}

/**
 * Pure, side-effect-free SEMANTIC validation of a delivery graph (ADR 0005 slice S0). Accepts the
 * graph as `unknown` because it arrives from an untyped request body — every field is read
 * defensively, so a malformed input maps to a clean {@link DeliveryGraphError} (never an uncaught
 * TypeError). Returns every error found (empty array ⇒ the graph is semantically valid), each
 * path-qualified — one entry per offending node/edge/fact, except cycle detection, which reports at
 * most ONE cycle per call to keep the output actionable (fix it and re-validate to surface the next).
 * Run this BEFORE any compile/deploy so a cycle, dangling edge, unknown kind, or unresolvable fact
 * reference is rejected with nothing started.
 */
export function validateDeliveryGraph(graph: unknown): DeliveryGraphError[] {
  const errors: DeliveryGraphError[] = [];

  if (!isRecord(graph) || !Array.isArray(graph.nodes)) {
    return [
      {
        path: "nodes",
        message: "delivery graph must be an object with a `nodes` array",
        code: "empty-graph",
      },
    ];
  }
  const nodes = graph.nodes;
  if (nodes.length === 0) {
    errors.push({
      path: "nodes",
      message: "delivery graph is empty — declare at least one node",
      code: "empty-graph",
    });
  } else if (nodes.length > GRAPH_MAX_NODES) {
    errors.push({
      path: "nodes",
      message: `delivery graph has too many nodes (${nodes.length}) — the limit is ${GRAPH_MAX_NODES}`,
      code: "too-many-nodes",
    });
  }

  // Top-level `name` (optional): mirror openapi's `DeliveryGraph.name` `maxLength: 255`, INDEPENDENTLY
  // of the shape gate — a non-string name would otherwise throw out of the compiler's `escapeXml`, and
  // an over-long one would be persisted despite violating the contract (see GRAPH_NAME_MAX_LENGTH).
  if (graph.name !== undefined) {
    if (typeof graph.name !== "string") {
      errors.push({
        path: "name",
        message: "delivery graph `name` must be a string",
        code: "invalid-graph-name",
      });
    } else if ([...graph.name].length > GRAPH_NAME_MAX_LENGTH) {
      errors.push({
        path: "name",
        message: `delivery graph \`name\` must be \u2264 ${GRAPH_NAME_MAX_LENGTH} characters`,
        code: "invalid-graph-name",
      });
    }
  }

  // Pass 1: node ids + kinds + per-kind config + declared facts. Build the id → declared-facts map
  // used to resolve edge `from` references in pass 2, plus the id → (fact → declared type) map guard
  // validation (pass 3) reads to enforce that a `when` references a SCALAR fact.
  const nodeFacts = new Map<string, Set<string>>();
  const nodeFactTypes = new Map<string, Map<string, DeliveryFactType>>();
  nodes.forEach((rawNode, i) => {
    const path = `nodes[${i}]`;
    if (!isRecord(rawNode)) {
      errors.push({ path, message: "each node must be an object", code: "missing-config" });
      return;
    }
    const id = rawNode.id;
    if (typeof id !== "string" || id.length === 0) {
      errors.push({ path: `${path}.id`, message: "node is missing a string `id`", code: "missing-id" });
    } else {
      if (id.length > NODE_ID_MAX_LENGTH || !NODE_ID_PATTERN.test(id)) {
        // Mirror openapi's `DeliveryNodeCommon.id` pattern/length so an invalid id can't slip past a
        // bypassed shape gate and break id-based compilation/rendering in a later slice.
        errors.push({
          path: `${path}.id`,
          message:
            `node id "${id}" must be a bare identifier (\`^[A-Za-z_][A-Za-z0-9_.-]*$\`, ` +
            `\u2264 ${NODE_ID_MAX_LENGTH} chars) so downstream id-based compilation stays safe`,
          code: "invalid-id",
        });
      }
      if (nodeFacts.has(id)) {
        errors.push({
          path: `${path}.id`,
          message: `duplicate node id "${id}" — every node id must be unique in the graph`,
          code: "duplicate-id",
        });
      }
    }

    const kind = rawNode.kind;
    if (!isDeliveryNodeKind(kind)) {
      errors.push({
        path: `${path}.kind`,
        message:
          `unknown node kind ${JSON.stringify(kind)} — must be one of ` +
          `${DELIVERY_NODE_KINDS.join(", ")} (the closed vocabulary is the trust boundary)`,
        code: "unknown-kind",
      });
    } else if (kind !== "human") {
      // Every kind but `human` REQUIRES its per-kind config object.
      const configKey = CONFIG_KEY[kind];
      const config = rawNode[configKey];
      if (!isRecord(config)) {
        errors.push({
          path: `${path}.${configKey}`,
          message: `${kind} node is missing its required \`${configKey}\` config`,
          code: "missing-config",
        });
      } else {
        // The config object is present — re-enforce the fields openapi marks REQUIRED (a bypassed
        // shape gate could otherwise let `{ kind:"agent", agent:{} }` through and crash a downstream
        // compiler/runner that trusts those fields exist).
        for (const field of REQUIRED_CONFIG_FIELDS[kind]) {
          const value = config[field];
          if (typeof value !== "string" || value.length === 0) {
            errors.push({
              path: `${path}.${configKey}.${field}`,
              message: `${kind} node's \`${configKey}.${field}\` is required and must be a non-empty string`,
              code: "missing-required-field",
            });
          }
        }
      }
    } else if (rawNode.human !== undefined && !isRecord(rawNode.human)) {
      // `human` config is OPTIONAL (formKey/prompt both resolve to a generic fallback in S3), but
      // when PRESENT it must be a plain object so later slices can safely read `human.formKey` /
      // `human.prompt` — a string/array/null `human` would crash them downstream.
      errors.push({
        path: `${path}.human`,
        message: "`human` config, when present, must be an object",
        code: "missing-config",
      });
    }

    // Collect + validate this node's typed emitted facts (uniqueness within the node). Registered
    // under the id even when other fields are invalid, so downstream edge resolution is best-effort.
    const facts = new Set<string>();
    const factTypes = new Map<string, DeliveryFactType>();
    if (rawNode.emits !== undefined) {
      if (!Array.isArray(rawNode.emits)) {
        errors.push({
          path: `${path}.emits`,
          message: "`emits` must be an array of typed fact declarations",
          code: "missing-config",
        });
      } else if (rawNode.emits.length > NODE_MAX_EMITS) {
        errors.push({
          path: `${path}.emits`,
          message: `node declares too many emitted facts (${rawNode.emits.length}) — the limit is ${NODE_MAX_EMITS}`,
          code: "too-many-emits",
        });
      } else {
        rawNode.emits.forEach((rawFact, j) => {
          if (!isRecord(rawFact) || typeof rawFact.name !== "string" || rawFact.name.length === 0) {
            errors.push({
              path: `${path}.emits[${j}].name`,
              message: "each emitted fact needs a non-empty string `name`",
              code: "missing-config",
            });
            return;
          }
          if (facts.has(rawFact.name)) {
            errors.push({
              path: `${path}.emits[${j}].name`,
              message: `duplicate emitted fact "${rawFact.name}" on node "${String(id)}"`,
              code: "duplicate-fact",
            });
            return;
          }
          if (rawFact.name.length > FACT_NAME_MAX_LENGTH || !FACT_NAME_PATTERN.test(rawFact.name)) {
            // A fact name must be a dot-free identifier within openapi's 128-char cap (openapi's
            // `DeliveryFact.name` `pattern` + `maxLength`) so a qualified edge `from`
            // "<nodeId>.<fact>" resolves unambiguously and a later step trusting the cap can't be
            // overrun — enforced here too, in case the OpenAPI shape gate is bypassed.
            errors.push({
              path: `${path}.emits[${j}].name`,
              message:
                `emitted fact name "${rawFact.name}" must be a bare identifier ` +
                "(`^[A-Za-z_][A-Za-z0-9_]*$`, no dots) of " +
                `\u2264 ${FACT_NAME_MAX_LENGTH} chars so qualified edge \`from\` references stay unambiguous`,
              code: "invalid-fact-name",
            });
            return;
          }
          if (!isDeliveryFactType(rawFact.type)) {
            // emits are TYPED (Decision 3/4). An invalid/missing `type` must be rejected even when the
            // OpenAPI shape validator is bypassed, or a later step reading the type allowlist breaks.
            errors.push({
              path: `${path}.emits[${j}].type`,
              message:
                `emitted fact "${rawFact.name}" has an invalid \`type\` — must be one of ` +
                `${DELIVERY_FACT_TYPES.join(", ")}`,
              code: "invalid-fact-type",
            });
          } else {
            factTypes.set(rawFact.name, rawFact.type);
          }
          facts.add(rawFact.name);
        });
      }
    }
    if (typeof id === "string" && id.length > 0 && !nodeFacts.has(id)) {
      nodeFacts.set(id, facts);
      nodeFactTypes.set(id, factTypes);
    }
  });

  // Pass 2: edges. Resolve each endpoint against the node set and each qualified `from` against the
  // upstream node's declared facts, and build the adjacency for the cycle check.
  const edges: readonly unknown[] = Array.isArray(graph.edges) ? graph.edges : [];
  if (graph.edges !== undefined && !Array.isArray(graph.edges)) {
    // A non-array `edges` must not be silently treated as "no edges" — that would let a malformed
    // body pass semantic validation when the OpenAPI shape validator is bypassed. This is a
    // shape/type error (not an endpoint-resolution failure), so it carries `invalid-edges` — callers
    // branching on error codes must distinguish "edges isn't a list" from a genuine dangling endpoint.
    errors.push({
      path: "edges",
      message: "`edges`, when present, must be an array of `{ from, to }` dependency edges",
      code: "invalid-edges",
    });
  } else if (edges.length > GRAPH_MAX_EDGES) {
    // Re-enforce openapi's `edges.maxItems: 1024` INDEPENDENTLY of the bypassed shape gate, so an
    // oversized-but-compilable graph cannot reach the layout/compiler and be persisted.
    errors.push({
      path: "edges",
      message: `delivery graph has too many edges (${edges.length}) — the limit is ${GRAPH_MAX_EDGES}`,
      code: "too-many-edges",
    });
  }
  // consumer (`to`) → set of upstream node ids (`from`'s node) — the dependency direction.
  const adjacency = new Map<string, Set<string>>();
  // Resolved, well-formed edges captured for the guard/topology pass (pass 3). Only edges whose BOTH
  // endpoints resolve are kept — a dangling/self edge is already reported and must not reach pass 3.
  const guardEdges: {
    index: number;
    fromNode: string;
    to: string;
    when?: unknown;
    equals?: unknown;
    hasWhen: boolean;
    hasEquals: boolean;
    isDefault: boolean;
  }[] = [];
  edges.forEach((rawEdge, i) => {
    const path = `edges[${i}]`;
    // A non-object entry or a missing/empty `from`/`to` is an edge *shape* error, not an
    // endpoint-resolution failure — so it carries `invalid-edges` (like the non-array `edges` case
    // above), reserving `dangling-edge` for a well-formed endpoint that names no node/fact.
    if (!isRecord(rawEdge)) {
      errors.push({ path, message: "each edge must be an object with `from` and `to`", code: "invalid-edges" });
      return;
    }
    const from = rawEdge.from;
    const to = rawEdge.to;
    if (typeof from !== "string" || from.length === 0) {
      errors.push({ path: `${path}.from`, message: "edge is missing a string `from`", code: "invalid-edges" });
    }
    if (typeof to !== "string" || to.length === 0) {
      errors.push({ path: `${path}.to`, message: "edge is missing a string `to`", code: "invalid-edges" });
    }
    if (typeof from !== "string" || typeof to !== "string" || from.length === 0 || to.length === 0) {
      return;
    }

    if (!nodeFacts.has(to)) {
      errors.push({
        path: `${path}.to`,
        message: `edge \`to\` "${to}" names no node in the graph`,
        code: "dangling-edge",
      });
    }

    const { nodeId, fact, ambiguousWith } = resolveFrom(from, nodeFacts);
    if (ambiguousWith !== undefined) {
      errors.push({
        path: `${path}.from`,
        message:
          `edge \`from\` "${from}" is ambiguous — it names both node "${from}" (a completion ` +
          `dependency) and fact "${ambiguousWith.fact}" of node "${ambiguousWith.nodeId}"; rename ` +
          "a node id or choose a different fact to disambiguate",
        code: "bad-from",
      });
    }
    const upstreamFacts = nodeFacts.get(nodeId);
    if (upstreamFacts === undefined) {
      errors.push({
        path: `${path}.from`,
        message: `edge \`from\` "${from}" names no node in the graph`,
        code: "dangling-edge",
      });
    } else if (fact !== undefined && !upstreamFacts.has(fact)) {
      errors.push({
        path: `${path}.from`,
        message:
          `edge \`from\` "${from}" references fact "${fact}" that node "${nodeId}" does not ` +
          "declare in its `emits[]`",
        code: "bad-from",
      });
    }

    if (nodeId === to) {
      errors.push({
        path,
        message: `node "${to}" cannot depend on itself`,
        code: "self-edge",
      });
      return;
    }

    // Only wire the cycle graph for edges whose endpoints both resolve — a dangling edge is already
    // reported and must not crash the walk.
    if (nodeFacts.has(to) && upstreamFacts !== undefined) {
      const ups = adjacency.get(to) ?? new Set<string>();
      ups.add(nodeId);
      adjacency.set(to, ups);
      guardEdges.push({
        index: i,
        fromNode: nodeId,
        to,
        when: rawEdge.when,
        equals: rawEdge.equals,
        hasWhen: rawEdge.when !== undefined,
        hasEquals: rawEdge.equals !== undefined,
        isDefault: rawEdge.default === true,
      });
    }
  });

  collectCycle(adjacency, errors);
  // Pass 3: guard (S7) semantics — only when the graph is otherwise structurally sound (every edge
  // resolved, no cycle). A malformed base graph is reported first; guard analysis assumes a DAG.
  if (errors.length === 0) {
    validateGuardedEdges(guardEdges, nodeFactTypes, errors);
  }
  return errors;
}

/** True when a guard `equals` literal's JSON type matches the referenced fact's declared scalar type. */
function equalsMatchesFactType(equals: unknown, factType: DeliveryGuardScalarType): boolean {
  switch (factType) {
    case "string":
      return typeof equals === "string";
    case "number":
      return typeof equals === "number";
    case "boolean":
      return typeof equals === "boolean";
  }
}

/** Pass 3 — validate the S7 guarded-edge (exclusive-split) semantics over the already-resolved edge
 * set (ADR 0005 S7). Enforces, per edge: `when`⇔`equals` presence, `when`/`default` mutual exclusion,
 * and that a `when` references a DECLARED SCALAR fact of its own producer whose type matches `equals`.
 * Then, per split node: no fan-out that MIXES guarded and unconditional out-edges, at most one
 * `default`, and exhaustiveness (a guarded split must carry a `default` unless it fully covers a
 * boolean fact). Finally, the exclusive-MERGE parity the compiler relies on: a fan-in must be either
 * a pure parallel join (all producers unconditional) or a clean exclusive merge (all producers on the
 * branches of one split that reconverges here) — never a mix (a parallel AND-join fed by a conditional
 * branch would deadlock; an exclusive merge fed by an always-firing producer would double-fire). */
function validateGuardedEdges(
  guardEdges: {
    index: number;
    fromNode: string;
    to: string;
    when?: unknown;
    equals?: unknown;
    hasWhen: boolean;
    hasEquals: boolean;
    isDefault: boolean;
  }[],
  nodeFactTypes: ReadonlyMap<string, ReadonlyMap<string, DeliveryFactType>>,
  errors: DeliveryGraphError[],
): void {
  const nodeFacts = new Map<string, Set<string>>();
  for (const [id, facts] of nodeFactTypes) nodeFacts.set(id, new Set(facts.keys()));

  // Per-edge guard shape + reference validation. `guardFactType` is cached per edge for the split-level
  // exhaustiveness check below.
  const guardFactTypeByIndex = new Map<number, DeliveryGuardScalarType>();
  for (const e of guardEdges) {
    const path = `edges[${e.index}]`;
    if (e.isDefault && (e.hasWhen || e.hasEquals)) {
      errors.push({
        path,
        message: "a `default` edge cannot also carry `when`/`equals` — a default is the unguarded else-branch",
        code: "guard-default-conflict",
      });
      continue;
    }
    if (e.hasWhen && !e.hasEquals) {
      errors.push({
        path: `${path}.equals`,
        message: "a guarded edge with `when` requires an `equals` literal to compare the fact against",
        code: "guard-missing-equals",
      });
      continue;
    }
    if (e.hasEquals && !e.hasWhen) {
      errors.push({
        path: `${path}.when`,
        message: "`equals` is only meaningful with a `when` guard reference — add `when` or drop `equals`",
        code: "guard-missing-when",
      });
      continue;
    }
    if (!e.hasWhen) continue; // plain or default edge — nothing more to check here.

    const whenStr = e.when;
    if (typeof whenStr !== "string" || whenStr.length === 0) {
      errors.push({ path: `${path}.when`, message: "`when` must be a `<nodeId>.<fact>` string", code: "bad-when" });
      continue;
    }
    const { nodeId: whenNode, fact: whenFact } = resolveFrom(whenStr, nodeFacts);
    if (whenFact === undefined) {
      errors.push({
        path: `${path}.when`,
        message: `guard \`when\` "${whenStr}" must be a qualified \`<nodeId>.<fact>\` reference to a declared fact`,
        code: "bad-when",
      });
      continue;
    }
    if (whenNode !== e.fromNode) {
      errors.push({
        path: `${path}.when`,
        message:
          `guard \`when\` "${whenStr}" must reference a fact of this edge's producer "${e.fromNode}" ` +
          `(the exclusive-split point), not "${whenNode}"`,
        code: "bad-when",
      });
      continue;
    }
    const factType = nodeFactTypes.get(whenNode)?.get(whenFact);
    if (factType === undefined || !isDeliveryGuardScalarType(factType)) {
      errors.push({
        path: `${path}.when`,
        message:
          `guard \`when\` "${whenStr}" must reference a declared SCALAR fact ` +
          `(${DELIVERY_GUARD_SCALAR_TYPES.join(", ")}) of "${whenNode}"`,
        code: "bad-when",
      });
      continue;
    }
    if (!equalsMatchesFactType(e.equals, factType)) {
      errors.push({
        path: `${path}.equals`,
        message:
          `guard \`equals\` for "${whenStr}" must be a ${factType} to match the fact's declared type`,
        code: "guard-type-mismatch",
      });
      continue;
    }
    guardFactTypeByIndex.set(e.index, factType);
  }

  // Group out-edges by producer node to check fan-out shape (mixing / defaults / exhaustiveness).
  const outByNode = new Map<string, typeof guardEdges>();
  for (const e of guardEdges) {
    const list = outByNode.get(e.fromNode) ?? [];
    list.push(e);
    outByNode.set(e.fromNode, list);
  }
  const splitNodes = new Set<string>();
  for (const [node, outs] of outByNode) {
    const guarded = outs.filter((e) => e.hasWhen && !e.isDefault);
    const defaults = outs.filter((e) => e.isDefault);
    const plain = outs.filter((e) => !e.hasWhen && !e.isDefault);
    const isSplit = guarded.length > 0 || defaults.length > 0;
    if (!isSplit) continue;
    // Only a GUARDED (`when`) fan-out to >=2 DISTINCT downstream targets is an exclusive split for
    // topology. A lone `default: true` edge (no guarded sibling) always fires, and a node whose
    // guarded + `default` edges all converge on ONE downstream node has no real fan-out — that node
    // fires whenever its producer does. Adding either here would spuriously mark downstream
    // nodes/leaves conditional and trip false exclusive-merge parity (or misselect the End join). The
    // per-node mixing/exhaustiveness checks below still run for any `default` fan-out (they gate on
    // `isSplit`); only the topology set is guard-derived and fan-out-shaped.
    const branchTargets = new Set([...guarded, ...defaults].map((e) => e.to));
    if (guarded.length > 0 && branchTargets.size > 1) splitNodes.add(node);

    if (plain.length > 0) {
      // No mixing: a node is a fork (all edges unconditional) OR an XOR-split (all edges guarded/
      // default), never both — a plain edge always fires and would break exclusive-branch selection.
      errors.push({
        path: `edges[${plain[0].index}]`,
        message:
          `node "${node}" mixes guarded/default out-edges with an unconditional one — a split node's ` +
          "out-edges must ALL be guarded (`when`) or `default`",
        code: "mixed-fan-out",
      });
    }
    if (defaults.length > 1) {
      errors.push({
        path: `edges[${defaults[1].index}]`,
        message: `node "${node}" has more than one \`default\` out-edge — at most one else-branch per split`,
        code: "multiple-defaults",
      });
    }

    // Exhaustiveness: a guarded split must carry a `default`, UNLESS it fully covers a single boolean
    // fact (both `true` and `false` guarded) — the only value domain equality guards can exhaust.
    if (defaults.length === 0) {
      const guardFactTypes = new Set(guarded.map((e) => guardFactTypeByIndex.get(e.index)));
      const booleanFacts = new Set(
        guarded.filter((e) => guardFactTypeByIndex.get(e.index) === "boolean").map((e) => String(e.when)),
      );
      let exhaustive = false;
      if (guardFactTypes.size === 1 && booleanFacts.size === 1) {
        const covered = new Set(guarded.map((e) => e.equals));
        exhaustive = covered.has(true) && covered.has(false);
      }
      if (!exhaustive) {
        errors.push({
          path: `edges[${guarded[0]?.index ?? outs[0].index}]`,
          message:
            `guarded split "${node}" is not exhaustive — add a \`default\` else-branch (or cover both ` +
            "values of a boolean fact) so no runtime value strands the token",
          code: "non-exhaustive-split",
        });
      }
    }
  }

  // Exclusive-merge parity. An edge is CONDITIONAL if it leaves a split (a guarded/default branch) or
  // its producer is itself only conditionally reached; both are computed from the split set + forward
  // reachability. A fan-in must be uniformly conditional (a clean exclusive merge) or uniformly
  // unconditional (a parallel join) — a mix is the deadlock/double-fire shape the compiler cannot wire.
  const forwardAdj = new Map<string, string[]>();
  const allNodes = new Set<string>();
  for (const [id] of nodeFactTypes) allNodes.add(id);
  for (const e of guardEdges) {
    allNodes.add(e.fromNode);
    allNodes.add(e.to);
    const list = forwardAdj.get(e.fromNode) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    forwardAdj.set(e.fromNode, list);
  }
  const topo = analyzeExclusiveTopology([...allNodes], forwardAdj, splitNodes);

  // producers per consumer (node id), from resolved edges.
  const producersByNode = new Map<string, Set<string>>();
  for (const e of guardEdges) {
    const set = producersByNode.get(e.to) ?? new Set<string>();
    set.add(e.fromNode);
    producersByNode.set(e.to, set);
  }
  const edgeConditional = (fromNode: string): boolean => splitNodes.has(fromNode) || topo.conditional.has(fromNode);

  for (const [node, producers] of producersByNode) {
    if (producers.size < 2) continue;
    const conditional = [...producers].filter(edgeConditional);
    const unconditional = [...producers].filter((p) => !edgeConditional(p));
    if (conditional.length > 0 && unconditional.length > 0) {
      errors.push({
        path: "edges",
        message:
          `node "${node}" joins a conditional (exclusive-split) branch with an always-firing branch — ` +
          "a parallel AND-join here deadlocks (the untaken branch never arrives). Route both through " +
          "one exclusive split so they re-converge as an exclusive merge",
        code: "exclusive-merge-parity",
      });
    } else if (conditional.length === producers.size && !topo.mergeNodes.has(node)) {
      errors.push({
        path: "edges",
        message:
          `node "${node}" merges conditional branches that do not re-converge from a single exclusive ` +
          "split — its incoming branches are not provably mutually exclusive, so it cannot merge safely",
        code: "exclusive-merge-parity",
      });
    }
  }

  // Same parity, now for the implicit End sink: the compiler joins every LEAF (a node with no
  // out-edge) at the process End. A leaf is conditional iff it may not fire on a given run
  // (`topo.conditional`). A leaf set that MIXES a conditional tail with an always-firing one is the
  // exact deadlock/double-fire shape the End gateway cannot wire — a parallel AND-join waits forever
  // for the untaken branch, an exclusive merge double-fires when both arrive — so reject it here (this
  // is the invariant the compiler's End-gateway selection relies on).
  const leaves = [...allNodes].filter((n) => (forwardAdj.get(n)?.length ?? 0) === 0);
  if (leaves.length > 1) {
    const conditionalLeaves = leaves.filter((n) => topo.conditional.has(n));
    if (conditionalLeaves.length > 0 && conditionalLeaves.length < leaves.length) {
      errors.push({
        path: "edges",
        message:
          "the graph's terminal nodes mix a conditional (exclusive-split) tail with an always-firing " +
          "tail — the End sink would deadlock as a parallel join (the untaken branch never arrives) or " +
          "double-fire as an exclusive merge. Route the conditional tails so they re-converge before the end",
        code: "exclusive-merge-parity",
      });
    }
  }
}

/** Depth-first cycle detection over the consumer(`to`)→producer(`from`) graph. Pushes ONE
 * {@link DeliveryGraphError} naming the offending cycle (the "reject at the offending edge"
 * guarantee) — a pure in-memory walk, no I/O. Reports at most one cycle so the message stays
 * actionable; the author fixes it and re-validates to surface any next one. */
function collectCycle(adjacency: Map<string, Set<string>>, errors: DeliveryGraphError[]): void {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  let reported = false;
  const visit = (node: string, stack: string[]): void => {
    if (reported) return;
    state.set(node, VISITING);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (reported) break;
      const s = state.get(next);
      if (s === VISITING) {
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next];
        errors.push({
          path: "edges",
          message: `dependency cycle detected: ${cycle.join(" → ")} — the graph must be a DAG`,
          code: "cycle",
        });
        reported = true;
        return;
      }
      if (s !== DONE) visit(next, stack);
    }
    stack.pop();
    state.set(node, DONE);
  };
  for (const node of adjacency.keys()) {
    if (reported) break;
    if (state.get(node) !== DONE) visit(node, []);
  }
}

/** The exclusive-split topology derived from a graph's node-level forward adjacency and its set of
 * exclusive-split node ids (ADR 0005 S7). This is the SINGLE canonical analysis both the semantic
 * validator (parity enforcement) and the S1 compiler (gateway-type selection) consume, so the two
 * never drift on which fan-in is an exclusive merge vs a parallel join:
 *
 *   • `mergeNodes` — nodes where ≥2 DISTINCT branch targets of the SAME split re-converge (following
 *     edges forward). These fan-ins must compile to an exclusive/OR merge (first-token-proceeds), not
 *     a parallel AND-join, which would deadlock waiting for the untaken branch.
 *   • `conditional` — nodes that MAY NOT execute on a given run: reachable from some split's branch
 *     target and not yet re-established as always-firing by a re-convergence merge (a merge node and
 *     everything downstream of it is guaranteed again — exactly one branch always reaches the merge).
 *
 * Pure and deterministic — set iteration order does not affect membership, and callers sort before
 * emitting. */
export interface ExclusiveTopology {
  readonly mergeNodes: ReadonlySet<string>;
  readonly conditional: ReadonlySet<string>;
}

export function analyzeExclusiveTopology(
  nodeIds: readonly string[],
  forwardAdj: ReadonlyMap<string, readonly string[]>,
  splitNodes: ReadonlySet<string>,
): ExclusiveTopology {
  const reachFrom = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n === undefined || seen.has(n)) continue;
      seen.add(n);
      for (const next of forwardAdj.get(n) ?? []) if (!seen.has(next)) stack.push(next);
    }
    return seen;
  };

  const mergeNodes = new Set<string>();
  const splitDownstream = new Set<string>();
  for (const split of splitNodes) {
    const branchTargets = forwardAdj.get(split) ?? [];
    const reachCount = new Map<string, number>();
    for (const target of branchTargets) {
      const reach = reachFrom(target);
      for (const n of reach) {
        splitDownstream.add(n);
        reachCount.set(n, (reachCount.get(n) ?? 0) + 1);
      }
    }
    for (const [n, count] of reachCount) if (count >= 2) mergeNodes.add(n);
  }

  // A merge node (and everything reachable from it) is guaranteed to fire again — exactly one branch of
  // the split always reaches the merge — so it is NOT conditional even though it sits downstream of a
  // split. Subtract that closure from the raw split-downstream set.
  const guaranteedAgain = new Set<string>();
  for (const merge of mergeNodes) for (const n of reachFrom(merge)) guaranteedAgain.add(n);

  const conditional = new Set<string>();
  for (const n of splitDownstream) if (!guaranteedAgain.has(n)) conditional.add(n);

  // `nodeIds` participates only to keep the surface honest (every referenced node is known); the sets
  // above are already complete over the reachable graph.
  void nodeIds;
  return { mergeNodes, conditional };
}

/** Build the `nodeId → declared-fact-names` map for a graph that has ALREADY passed
 * {@link validateDeliveryGraph} (every id/emit is well-formed by then). This is the same map the
 * validator builds internally for edge resolution; exported so a downstream consumer (the S1
 * compiler) derives it from ONE canonical place rather than re-deriving — and thus resolves edge
 * `from` endpoints identically (no drift). Nodes without a valid string id, and duplicate ids, are
 * skipped exactly as the validator does (first id wins). */
export function deliveryNodeFacts(graph: DeliveryGraphLike): Map<string, Set<string>> {
  const nodeFacts = new Map<string, Set<string>>();
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  for (const rawNode of nodes) {
    if (!isRecord(rawNode)) continue;
    const id = rawNode.id;
    if (typeof id !== "string" || id.length === 0 || nodeFacts.has(id)) continue;
    const facts = new Set<string>();
    if (Array.isArray(rawNode.emits)) {
      for (const rawFact of rawNode.emits) {
        if (isRecord(rawFact) && typeof rawFact.name === "string" && rawFact.name.length > 0) {
          facts.add(rawFact.name);
        }
      }
    }
    nodeFacts.set(id, facts);
  }
  return nodeFacts;
}

/** The minimal read surface {@link deliveryNodeFacts} / {@link resolveDeliveryFrom} need — a graph
 * with a `nodes` array. Kept structural so both the untyped request body and the generated
 * `DeliveryGraph` type satisfy it. */
export interface DeliveryGraphLike {
  readonly nodes?: unknown;
}

/** Resolve an edge `from` endpoint (`<nodeId>` or `<nodeId>.<fact>`) against a graph's node/fact map,
 * for a graph that has ALREADY passed {@link validateDeliveryGraph} (so the reference is known
 * resolvable and unambiguous). Returns the upstream `nodeId` and, when the `from` was qualified, the
 * referenced `fact`. Shares the exact disambiguation rule the validator uses (a node id may contain
 * dots; a fact name cannot), so the compiler builds the SAME DAG the validator checked — no drift. */
export function resolveDeliveryFrom(
  from: string,
  nodeFacts: ReadonlyMap<string, ReadonlySet<string>>,
): { nodeId: string; fact?: string } {
  const { nodeId, fact } = resolveFrom(from, nodeFacts);
  return fact !== undefined ? { nodeId, fact } : { nodeId };
}
