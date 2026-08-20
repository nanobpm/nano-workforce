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

import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";

/** The CLOSED node-kind allowlist (ADR 0005 Decision 2) — the trust boundary. Extensible only by a
 * deliberate ADR/PR (add the openapi variant + a case here), never by a graph author. Kept as the
 * single source of truth for "which kinds are legal" so the validator and any future compiler agree. */
export const DELIVERY_NODE_KINDS = ["agent", "wait", "human", "connector"] as const;

/** A node's `kind`, narrowed to the closed allowlist. */
export type DeliveryNodeKind = (typeof DELIVERY_NODE_KINDS)[number];

/** A machine-readable classification of a semantic failure, so a caller can branch on the error
 * class (unknown-kind / dangling / cycle / bad-`from`) without string-matching the message. */
export type DeliveryGraphErrorCode =
  | "empty-graph"
  | "missing-id"
  | "duplicate-id"
  | "unknown-kind"
  | "missing-config"
  | "duplicate-fact"
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
 * return the whole string as the (unresolvable) node id so the caller reports it against `from`. */
function resolveFrom(from: string, nodeIds: ReadonlySet<string>): { nodeId: string; fact?: string } {
  if (nodeIds.has(from)) return { nodeId: from };
  const dot = from.lastIndexOf(".");
  if (dot > 0 && dot < from.length - 1) {
    const nodeId = from.slice(0, dot);
    if (nodeIds.has(nodeId)) return { nodeId, fact: from.slice(dot + 1) };
  }
  return { nodeId: from };
}

/**
 * Pure, side-effect-free SEMANTIC validation of a delivery graph (ADR 0005 slice S0). Accepts the
 * graph as `unknown` because it arrives from an untyped request body — every field is read
 * defensively, so a malformed input maps to a clean {@link DeliveryGraphError} (never an uncaught
 * TypeError). Returns EVERY error found (empty array ⇒ the graph is semantically valid), each
 * path-qualified. Run this BEFORE any compile/deploy so a cycle, dangling edge, unknown kind, or
 * unresolvable fact reference is rejected with nothing started.
 */
export function validateDeliveryGraph(graph: DeliveryGraph | unknown): DeliveryGraphError[] {
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
    } else if (nodeFacts.has(id)) {
      errors.push({
        path: `${path}.id`,
        message: `duplicate node id "${id}" — every node id must be unique in the graph`,
        code: "duplicate-id",
      });
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
    } else if (!isRecord(rawNode[CONFIG_KEY[kind]]) && kind !== "human") {
      // Every kind but `human` REQUIRES its per-kind config object; `human` config is optional
      // (formKey/prompt both resolve to a generic fallback in S3).
      errors.push({
        path: `${path}.${CONFIG_KEY[kind]}`,
        message: `${kind} node is missing its required \`${CONFIG_KEY[kind]}\` config`,
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
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const nodeIds: ReadonlySet<string> = new Set(nodeFacts.keys());
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

    const { nodeId, fact } = resolveFrom(from, nodeIds);
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
