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

/** A machine-readable classification of a semantic failure, so a caller can branch on the error
 * class (unknown-kind / dangling / cycle / bad-`from`) without string-matching the message. */
export type DeliveryGraphErrorCode =
  | "empty-graph"
  | "missing-id"
  | "invalid-id"
  | "duplicate-id"
  | "unknown-kind"
  | "missing-config"
  | "duplicate-fact"
  | "invalid-fact-name"
  | "invalid-fact-type"
  | "invalid-edges"
  | "dangling-edge"
  | "bad-from"
  | "self-edge"
  | "cycle";

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
const FACT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A node `id` must match openapi's `DeliveryNodeCommon.id` `^[A-Za-z_][A-Za-z0-9_.-]*$` and stay
 * within its 128-char cap. Re-enforced here INDEPENDENTLY of the OpenAPI shape gate because later
 * compile/render steps trust these ids: an id with whitespace, a leading digit, or an over-long value
 * could otherwise pass semantic validation (a bypassed shape gate — a direct delegate call, a test)
 * and then break id-based compilation/rendering downstream. Unlike a fact name, an id MAY contain
 * dots/hyphens — `resolveFrom` splits a qualified `from` on the LAST dot, so a dotted id stays
 * resolvable while dot-free fact names keep `<nodeId>.<fact>` unambiguous. */
const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NODE_ID_MAX_LENGTH = 128;

/** The per-kind config key a node of the given kind must carry (`agent` → `agent`, etc.). */
const CONFIG_KEY: Record<DeliveryNodeKind, string> = {
  agent: "agent",
  wait: "wait",
  human: "human",
  connector: "connector",
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
  }

  // Pass 1: node ids + kinds + per-kind config + declared facts. Build the id → declared-facts map
  // used to resolve edge `from` references in pass 2.
  const nodeFacts = new Map<string, Set<string>>();
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
      if (!isRecord(rawNode[CONFIG_KEY[kind]])) {
        errors.push({
          path: `${path}.${CONFIG_KEY[kind]}`,
          message: `${kind} node is missing its required \`${CONFIG_KEY[kind]}\` config`,
          code: "missing-config",
        });
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
    if (rawNode.emits !== undefined) {
      if (!Array.isArray(rawNode.emits)) {
        errors.push({
          path: `${path}.emits`,
          message: "`emits` must be an array of typed fact declarations",
          code: "missing-config",
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
          if (!FACT_NAME_PATTERN.test(rawFact.name)) {
            // A fact name must be a dot-free identifier (openapi's `DeliveryFact.name` pattern) so a
            // qualified edge `from` "<nodeId>.<fact>" resolves unambiguously — enforced here too, in
            // case the OpenAPI shape gate is bypassed.
            errors.push({
              path: `${path}.emits[${j}].name`,
              message:
                `emitted fact name "${rawFact.name}" must be a bare identifier ` +
                "(`^[A-Za-z_][A-Za-z0-9_]*$`, no dots) so qualified edge `from` references stay unambiguous",
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
          }
          facts.add(rawFact.name);
        });
      }
    }
    if (typeof id === "string" && id.length > 0 && !nodeFacts.has(id)) {
      nodeFacts.set(id, facts);
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
  }
  // consumer (`to`) → set of upstream node ids (`from`'s node) — the dependency direction.
  const adjacency = new Map<string, Set<string>>();
  edges.forEach((rawEdge, i) => {
    const path = `edges[${i}]`;
    if (!isRecord(rawEdge)) {
      errors.push({ path, message: "each edge must be an object with `from` and `to`", code: "dangling-edge" });
      return;
    }
    const from = rawEdge.from;
    const to = rawEdge.to;
    if (typeof from !== "string" || from.length === 0) {
      errors.push({ path: `${path}.from`, message: "edge is missing a string `from`", code: "dangling-edge" });
    }
    if (typeof to !== "string" || to.length === 0) {
      errors.push({ path: `${path}.to`, message: "edge is missing a string `to`", code: "dangling-edge" });
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
    }
  });

  collectCycle(adjacency, errors);
  return errors;
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
