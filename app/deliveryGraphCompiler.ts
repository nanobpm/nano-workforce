// nano-workforce — the TRUSTED, DETERMINISTIC compiler for an agent-authored delivery graph
// (ADR 0005, slice S1). It is the fast, safe INNER LOOP a co-designing agent hammers: given an
// agent-authored `DeliveryGraph` (the JSON contract from slice S0), it VALIDATES (the pure
// `validateDeliveryGraph` semantic check), then COMPILES it to a native artifact, and RENDERS a
// preview — but it NEVER deploys or dispatches anything (Decision 5/6: `compile` and `start` are
// SEPARATE doors; there is deliberately no `dryRun` flag on the start door). Being side-effect-free,
// it is callable repeatedly while the agent iterates JSON → compile → fix.
//
// Two invariants make it TRUSTED (Decision 1/2 — the closed node vocabulary is the trust boundary):
//
//   • It is human-written and DETERMINISTIC: the same input JSON always produces byte-identical
//     output (BPMN, diagram, resolved graph). Nodes/edges are sorted by id and every generated id is
//     assigned positionally, so there is no map-iteration or timestamp nondeterminism.
//   • It only ever instantiates ALLOWLISTED node kinds. The `compileNode` switch is exhaustive over
//     the closed `DeliveryNodeKind` union with a `never` default, so the compiler CANNOT emit a
//     construct for a non-allowlisted kind — a new kind fails `tsc` until it is deliberately handled.
//     `validateDeliveryGraph` is the runtime guard (an unknown kind is rejected before compilation);
//     the exhaustive switch is the compile-time guarantee.
//
// Compile-to-native (the first cut, Decision 6): each node maps to an engine-native call
// activity / sub-process (a `wait` reuses the real `readiness-gate`; `agent`/`connector` target
// forward-declared bodies S4 binds) and each edge becomes a native sequence flow, with explicit
// parallel gateways for genuine fan-out (>1 downstream) and fan-in (>1 upstream). This slice targets
// the WIRING/SHAPE — the concrete node bodies land in S4.

import { layoutBpmn } from "@nanobpm/urban";
import type {
  CompileDeliveryGraphErrors,
  CompileDeliveryGraphResult,
  DeliveryFact,
  DeliveryGraph,
  DeliveryHumanStop,
  DeliveryNode,
  DeliverySideEffect,
  ResolvedDeliveryEdge,
  ResolvedDeliveryNode,
} from "../nano-generated/api-io.d.ts";
import { TRANSCRIPT_URL_BASE_VAR, TRANSCRIPT_URL_VAR } from "./agentic/transcript-url.ts";
import { DELIVERY_CONNECTOR_TASK_TYPE } from "./deliveryConnector.ts";
import {
  analyzeExclusiveTopology,
  type DeliveryGraphError,
  deliveryNodeFacts,
  resolveDeliveryFrom,
  validateDeliveryGraph,
} from "./deliveryGraph.ts";
import { DELIVERY_HUMAN_ELEMENT, GENERIC_HUMAN_FORM } from "./deliveryHuman.ts";

/** The engine-native BODY every node kind delegates to (Decision 2 — the graph SCHEDULES, it does not
 * re-implement execution). Each node compiles to an EMBEDDED `bpmn:subProcess` (call activities are a
 * no-op on the pinned WASM engine — the child is never instantiated — so, like the rest of the
 * codebase, `plan-fanout`'s `readiness-preflight` included, delegation is an inlined subProcess that
 * shares the parent variable scope). The inner task delegates to a real, already-registered worker /
 * user-task body:
 *   • `agent`     → the `senior:*` job the node names (the implementation-task body).
 *   • `wait`      → the `pr.readiness-probe` service task (the reusable ReadinessProbe poll gate; the
 *                   `pr` kind is S2). Polling its own target is what makes an unrelated upstream event
 *                   unable to falsely resolve the wait (#274/S2 concurrency-correctness).
 *   • `human`     → the S3 scheduled user-task + generic form + SLA (`delivery-human-task__<el>`,
 *                   recognised by the `isDeliveryHumanElement` convention so it routes through the ONE
 *                   canonical completer and the Tasks inbox).
 *   • `connector` → the `pr.delivery-connector` dedupe stub (forward-declared; real I/O deferred per
 *                   the ADR non-goals — but a real, idempotent node).
 * Kept as the single source of truth so the compiler, the resolved-preview and the runner agree on
 * the delegation target each node names. */
const DELEGATE_TASK_TYPE: Record<Exclude<DeliveryNode["kind"], "agent" | "human">, string> = {
  wait: "pr.readiness-probe",
  connector: DELIVERY_CONNECTOR_TASK_TYPE,
};

/** The BPMN `bpmn:process` id of the compiled one-shot definition (S1). Stable across compiles of the
 * same graph — the pure S1 preview always emits this base id. The S4 runner (`deliveryRunner.ts`)
 * derives a CONTENT-ADDRESSED deploy id from it (`delivery-graph-<sha>`), so re-deploying the same
 * graph is idempotent and stale definitions are GC-identifiable; exported here as the single source of
 * truth so the runner never hardcodes the literal it substitutes. */
export const DELIVERY_GRAPH_PROCESS_ID = "delivery-graph";

/** The BPMN element id a `human` node's inlined user task carries. One user task per human node (the
 * compiled one-shot inlines each), so the id is per-node (`delivery-human-task__<element>`) — the
 * `isDeliveryHumanElement` convention (single source of truth in `deliveryHuman.ts`) is what keeps it
 * recognised by `ESCALATION_TASK_ELEMENTS` / the Tasks inbox despite the per-node suffix. */
function humanTaskElement(element: string): string {
  return `${DELIVERY_HUMAN_ELEMENT}__${element}`;
}

/** The BPMN element id a service node's bounded-timeout escalation user task carries — same
 * human-completable convention as a human node, so a stalled `agent`/`wait`/`connector` escalates onto
 * the Tasks inbox and is answerable by a human OR an agent (ADR 0046). */
function escalationTaskElement(element: string): string {
  return `${DELIVERY_HUMAN_ELEMENT}__${element}__esc`;
}

/** The BPMN element id an `agent` node's PRODUCER-CONTRACT escalation user task carries (issue #731) —
 * distinct from the `__esc` timeout twin so a node can carry both a bounded-timeout escalation AND a
 * post-completion contract-gate escalation without an id collision. Same human-completable convention
 * (`delivery-human-task__…` → recognised by `isDeliveryHumanElement`, routed onto the Tasks inbox), so
 * a producer that finishes without doing its job escalates AT that node and is answerable by a human
 * OR an agent. */
function contractEscalationTaskElement(element: string): string {
  return `${DELIVERY_HUMAN_ELEMENT}__${element}__contract`;
}

/** The self-reported completion statuses an `agent` node's job may return that count as a TERMINAL
 * SUCCESS and are allowed to route their result onward (issue #731). Everything else — the pathological
 * `in_progress` an agent that delegated/returned-before-finishing reports (instance 10746), a `blocked`/
 * `failed`/`escalated` give-up, or any unrecognised free-formed status — fails the producer status gate
 * and escalates AT the node instead of threading an incomplete result into a downstream consumer. An
 * ABSENT/null status passes the gate (a status-less completion — an older fleet worker or a bare test
 * stub — is not itself the failure mode; the required-emit gate still catches a missing data fact).
 * Sorted for the compiler's byte-identical-output determinism. */
const AGENT_TERMINAL_SUCCESS_STATUSES: readonly string[] = ["done", "opened", "skipped"];

/** A never-reached exhaustiveness guard: `compileNode`'s `switch` covers every allowlisted kind, so
 * the closed union narrows to `never` here. If a future kind is added to the vocabulary without a
 * compiler arm, `tsc` flags this call — the compile-time half of the trust bound. */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unreachable — non-allowlisted delivery node kind ${JSON.stringify(value)}`);
}

/** Escape a string for use as XML text / attribute content. Deterministic and total. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape a string for XML ELEMENT TEXT content while KEEPING literal double-quotes — the convention
 * every authored `<bpmn:conditionExpression>` FEEL uses (e.g. `=status = "converged"`). Only `&`, `<`,
 * `>` are entity-escaped (required for text-node well-formedness); quotes stay literal so a FEEL string
 * literal survives to the engine. Safe because the compiler grafts DI onto its own semantic XML without
 * re-serializing it, so these text nodes are never round-tripped/normalized. Deterministic and total. */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render a `name=value` XML attribute, choosing the delimiter so FEEL string literals survive the
 * WASM engine's deploy path. That path does NOT decode `&#34;`/`&quot;` entities before FEEL parsing,
 * so a FEEL expression containing a string literal MUST use a SINGLE-QUOTE attribute delimiter with
 * literal double-quotes inside (verified empirically — an entity-escaped `"` silently yields no value,
 * not an incident). When the value has no `"`, the ordinary double-quote form (with full entity
 * escaping) is used. Deterministic. */
function attr(name: string, value: string): string {
  if (value.includes('"')) {
    const inner = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
    return `${name}='${inner}'`;
  }
  return `${name}="${escapeXml(value)}"`;
}

/** Escape a string for use inside a mermaid quoted label. Mermaid uses `#` HTML-entity escapes; a
 * double quote inside a `"…"` label must become `#quot;` so the label stays well-formed. */
function escapeMermaid(value: string): string {
  return value.replace(/"/g, "#quot;").replace(/\n/g, " ");
}

/** A node's typed emits, normalised to a stable array (absent → `[]`). */
function normaliseEmits(node: DeliveryNode): DeliveryFact[] {
  return Array.isArray(node.emits) ? node.emits.map((f) => ({ ...f })) : [];
}

/** Locale-independent, byte-stable string ordering: compares by UTF-16 code unit, so the sort is
 * identical across host locales (unlike `localeCompare`, whose collation varies by runtime locale for
 * non-ASCII ids). This keeps the compiler's "byte-identical across environments" determinism guarantee
 * strict. Returns -1 / 0 / 1. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The engine variable a producer node's OUTPUT mapping reads to publish a declared emitted `fact`
 * (S4 late-binding). Each node kind's real body exposes the observed value under a canonical name:
 *   • `wait` (readiness-gate) — a `mergedSha` fact reads the merge oid; a `prCount` fact reads the
 *     epic-match `prCount` bind (how many slice PRs a `wait[epic]` landed); an `artifact` fact reads
 *     the `resolvedArtifact` bind (mirroring the `capability`/`pr` probe binds); anything else reads
 *     the probe's `detail`.
 *   • `human` (delivery-human) — an `artifact` fact reads `humanEmitArtifact`; anything else reads
 *     `humanEmitValue` (the generic typed-emit form's captured value).
 *   • `agent`/`connector` — the body's job worker returns the value under the fact's own name.
 * Deterministic and total over the closed kind set. */
function factSourceVar(kind: DeliveryNode["kind"], fact: DeliveryFact): string {
  switch (kind) {
    case "wait":
      return fact.name === "mergedSha"
        ? "mergedSha"
        : fact.name === "prCount"
          ? "prCount"
          : fact.type === "artifact"
            ? "resolvedArtifact"
            : "detail";
    case "human":
      return fact.type === "artifact" ? "humanEmitArtifact" : "humanEmitValue";
    case "agent":
    case "connector":
      return fact.name;
    default:
      return assertNever(kind, "factSourceVar");
  }
}

/** A FEEL string literal (raw, with literal double-quotes). XML-attribute escaping and delimiter
 * choice are handled by `attr` at emit time — do NOT pre-escape here, or the quote is hidden from
 * `attr`'s single-quote-delimiter heuristic and gets double-encoded. */
function feelStr(value: string): string {
  return JSON.stringify(value);
}

/** Render a guard `equals` literal (S7) as its FEEL form — a string becomes a `"…"` literal, a number
 * its decimal, a boolean `true`/`false`. `undefined` renders as `""` so it can double as a stable sort
 * key for edges without a guard. Deterministic and total over the `string|number|boolean` scalar set. */
function feelLiteral(value: string | number | boolean | undefined): string {
  if (typeof value === "string") return feelStr(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

/** The FEEL predicate a guarded edge (S7) contributes to its exclusive-split flow condition — e.g.
 * `n0_result = "breaking"` — comparing the producer's published `<element>_<fact>` variable to the
 * edge's `equals` literal. `when` names `<fromNode>.<fact>` (validated: a scalar fact of this edge's
 * producer), so the variable is `<producerElement>_<fact>`. Returns `undefined` for a plain or default
 * edge (no `when`). Deterministic. */
function guardConditionPart(
  edge: ResolvedDeliveryEdge,
  elementById: ReadonlyMap<string, string>,
  nodeFacts: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (edge.when === undefined || edge.default === true) return undefined;
  const { fact } = resolveDeliveryFrom(edge.when, nodeFacts);
  if (fact === undefined) return undefined;
  const producerElement = elementById.get(edge.fromNode) ?? edge.fromNode;
  return `${producerElement}_${fact} = ${feelLiteral(edge.equals)}`;
}

/** One sequence flow in the compiled process — `source`/`target` are element ids, `name` an optional
 * (fact / guard) label. `condition` is a FEEL boolean guard rendered as a `<bpmn:conditionExpression>`
 * child (S7 guarded edge); `isDefault` marks the exclusive split's default (else) flow, whose id the
 * split gateway carries as its `default` attribute. */
interface Flow {
  id: string;
  source: string;
  target: string;
  name?: string;
  condition?: string;
  isDefault?: boolean;
}

/** One late-binding input a consumer node receives (S4): the producer node's business id, the
 * referenced emitted fact name, and the flat parent variable (`<producerElement>_<fact>`) the
 * producer's output mapping publishes the observed value into. */
interface BoundInput {
  fromNode: string;
  fact: string;
  producerElement: string;
}

/** A compiled node's structural fixtures: its own BPMN `element` id, and — when it has >1 downstream
 * or >1 upstream — the fork/join gateway that fans its flow out/in. `entry` is the id upstream flows
 * target (the join, else the element); `exit` is the id downstream flows leave from (the fork, else
 * the element). `forkExclusive`/`joinExclusive` select an EXCLUSIVE gateway (S7): a guarded-split
 * source forks on an `exclusiveGateway` (data-based branch), and a fan-in reconverging exclusive
 * branches joins on an `exclusiveGateway` (first-token-proceeds) rather than a parallel AND-join. */
interface NodeWiring {
  node: DeliveryNode;
  element: string;
  forkGateway?: string;
  joinGateway?: string;
  forkExclusive: boolean;
  joinExclusive: boolean;
  entry: string;
  exit: string;
}

/** Fetch a key that MUST be present (every node id was registered in the map above). Returns the
 * value without a type assertion, throwing on the impossible missing case. */
function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`compileDeliveryGraph: missing map entry for ${String(key)}`);
  return value;
}

/** The compiler result BEFORE diagram-interchange layout: everything the generated
 * `CompileDeliveryGraphResult` carries EXCEPT the laid-out `bpmn`, plus the `semanticBpmn` (the
 * pre-layout, DI-less BPMN). `compileDeliveryGraphSemantic` produces this cheaply (no
 * `layoutBpmn`); `compileDeliveryGraph` layers the CPU-bound DI layout on top. Because the DI is
 * DERIVED deterministically from `semanticBpmn`, `semanticBpmn` is the canonical content of a graph —
 * the source `deliveryGraphDigest` content-addresses (issue #716). */
export interface CompiledDeliveryGraphSemantic {
  ok: true;
  /** A human-readable mermaid `flowchart` of the resolved graph. */
  diagram: string;
  /** The compiled one-shot BPMN process definition WITHOUT diagram interchange — the canonical,
   * layout-independent content of the graph. Deterministic: same input graph → byte-identical XML. */
  semanticBpmn: string;
  resolved: CompileDeliveryGraphResult["resolved"];
  humanNodes: CompileDeliveryGraphResult["humanNodes"];
  sideEffects: CompileDeliveryGraphResult["sideEffects"];
}

/** A fully-compiled graph — the generated wire result (`diagram`, laid-out `bpmn`, …) PLUS the
 * pre-layout `semanticBpmn` the content digest is taken over. */
export type CompiledDeliveryGraph = CompileDeliveryGraphResult & { semanticBpmn: string };

/**
 * Validate + compile a delivery graph into a PURE preview WITHOUT the CPU-bound diagram-interchange
 * layout (issue #716). Returns `{ ok:true, diagram, semanticBpmn, resolved, humanNodes, sideEffects }`
 * for a well-formed graph, or `{ ok:false, errors }` (each error path-qualified) for a malformed one.
 * NEVER deploys, dispatches, or mutates anything — safe to call repeatedly. Deterministic: identical
 * input JSON yields byte-identical output.
 *
 * This is the fast path the agent-facing compile/stage doors (`compileDeliveryGraph` /
 * `sequenceIssues` → `compileAndStageDeliveryGraph`) take: staging needs only the content digest (taken
 * over `semanticBpmn`), the mermaid `diagram`, and the resolved model — NOT the laid-out `bpmn`. Skipping
 * `layoutBpmn` (`bpmn-auto-layout`, superlinear in node/edge count — minutes on a 256-node/1024-edge
 * graph) keeps a cold MCP tool call well under the client's per-call timeout instead of tripping a
 * `-32001` that poisons the stateful session (#715). The laid-out `bpmn` is generated lazily, only at the
 * OPERATOR's preview/dispatch time (`previewProposalBpmn` / `dispatchDeliveryGraph`), which is a cockpit
 * action, not an MCP call, and so is not timeout-bound.
 */
export async function compileDeliveryGraphSemantic(
  graph: unknown,
): Promise<CompiledDeliveryGraphSemantic | CompileDeliveryGraphErrors> {
  const validationErrors: DeliveryGraphError[] = validateDeliveryGraph(graph);
  if (validationErrors.length > 0) {
    // Forward every semantic failure verbatim as a wire `{ path, message }` (the stable `code` stays
    // server-side). Nothing is compiled — the agent fixes the exact offending input and re-compiles.
    return { ok: false, errors: validationErrors.map(({ path, message }) => ({ path, message })) };
  }

  // The graph passed the OpenAPI `DeliveryGraph` SHAPE gate (the runtime edge for the typed agent
  // door; `validateDeliveryGraphShape` in the shared text-ingress for the graphJson-string doors) and
  // the semantic validator, so it is safe to narrow to the typed contract. Every field below is
  // well-formed by construction.
  // biome-ignore lint/plugin: validated external body narrowed to its contract after validateDeliveryGraph
  const typed = graph as DeliveryGraph;
  const nodes = [...typed.nodes].sort((a, b) => byCodeUnit(a.id, b.id));
  const edges = Array.isArray(typed.edges) ? typed.edges : [];

  // Resolve every edge's `from` endpoint against the SAME node/fact map the validator checked (shared
  // helper — no drift), then sort edges deterministically by (consumer, producer, fact). Guard fields
  // (`when`/`equals`/`default`, S7) are carried through verbatim so the preview and the compiled
  // gateway conditions derive from one resolved edge.
  const nodeFacts = deliveryNodeFacts(typed);
  const resolvedEdges: ResolvedDeliveryEdge[] = edges
    .map((edge) => {
      const { nodeId, fact } = resolveDeliveryFrom(edge.from, nodeFacts);
      let resolved: ResolvedDeliveryEdge = { from: edge.from, to: edge.to, fromNode: nodeId };
      if (fact !== undefined) resolved = { ...resolved, fromFact: fact };
      if (edge.when !== undefined) resolved = { ...resolved, when: edge.when };
      if (edge.equals !== undefined) resolved = { ...resolved, equals: edge.equals };
      if (edge.default === true) resolved = { ...resolved, default: true };
      return resolved;
    })
    .sort(
      (a, b) =>
        byCodeUnit(a.to, b.to) ||
        byCodeUnit(a.fromNode, b.fromNode) ||
        byCodeUnit(a.fromFact ?? "", b.fromFact ?? "") ||
        byCodeUnit(a.when ?? "", b.when ?? "") ||
        byCodeUnit(feelLiteral(a.equals), feelLiteral(b.equals)),
    );

  // Per-node producer/consumer adjacency (by node id), each sorted + de-duplicated for determinism.
  const producersById = new Map<string, string[]>();
  const consumersById = new Map<string, string[]>();
  for (const node of nodes) {
    producersById.set(node.id, []);
    consumersById.set(node.id, []);
  }
  for (const edge of resolvedEdges) {
    pushUnique(producersById.get(edge.to), edge.fromNode);
    pushUnique(consumersById.get(edge.fromNode), edge.to);
  }
  for (const list of producersById.values()) list.sort(byCodeUnit);
  for (const list of consumersById.values()) list.sort(byCodeUnit);

  // Exclusive-split topology (S7): a node with a GUARDED (`when`) out-edge is an exclusive split; a
  // fan-in that re-converges a split's branches is an exclusive merge. Derived from the ONE shared
  // `analyzeExclusiveTopology` the validator also uses, so gateway-type selection never drifts from the
  // parity the validator enforced. A lone `default: true` edge (no guarded sibling) always fires and is
  // NOT a split; and a node whose guarded + `default` edges all converge on ONE downstream target has
  // no real fan-out either — mirror the validator: key off a guarded `when` fanning to >=2 DISTINCT
  // downstream targets only.
  const splitNodes = new Set<string>();
  const guardedNodes = new Set<string>();
  const branchTargetsByNode = new Map<string, Set<string>>();
  for (const edge of resolvedEdges) {
    const guarded = edge.when !== undefined && edge.default !== true;
    if (!guarded && edge.default !== true) continue;
    if (guarded) guardedNodes.add(edge.fromNode);
    const targets = branchTargetsByNode.get(edge.fromNode) ?? new Set<string>();
    targets.add(edge.to);
    branchTargetsByNode.set(edge.fromNode, targets);
  }
  for (const node of guardedNodes) {
    if ((branchTargetsByNode.get(node)?.size ?? 0) > 1) splitNodes.add(node);
  }
  const forwardAdj = new Map<string, string[]>();
  for (const node of nodes) forwardAdj.set(node.id, [...(consumersById.get(node.id) ?? [])]);
  const topology = analyzeExclusiveTopology(
    nodes.map((n) => n.id),
    forwardAdj,
    splitNodes,
  );

  // Assign the deterministic BPMN element id per node (`n0`, `n1`, … in sorted order) plus the
  // fork/join gateway ids any fan-out/fan-in node needs: a PARALLEL fork/join is `gwf<i>`/`gwj<i>`; an
  // EXCLUSIVE split/merge (S7) is `gwx<i>`/`gwm<i>`. Each id space has its own positional counter so the
  // scheme stays deterministic and non-colliding.
  const elementById = new Map<string, string>();
  const wirings: NodeWiring[] = [];
  const wiringById = new Map<string, NodeWiring>();
  let forkSeq = 0;
  let joinSeq = 0;
  let splitSeq = 0;
  let mergeSeq = 0;
  nodes.forEach((node, i) => {
    const element = `n${i}`;
    elementById.set(node.id, element);
    const consumers = consumersById.get(node.id) ?? [];
    const producers = producersById.get(node.id) ?? [];
    const forkExclusive = splitNodes.has(node.id);
    // A fan-in is an EXCLUSIVE merge (first-token-proceeds) iff EVERY incoming branch is conditional —
    // a split's own guarded/default out-edge, or a producer only conditionally reached. This is the
    // SAME parity predicate the validator enforces (`edgeConditional`), so gateway-type selection never
    // drifts from it. Deriving `joinExclusive` from `mergeNodes` alone over-fires: `analyzeExclusive
    // Topology` marks every node reachable from >=2 branch targets as a merge, including nodes DOWNSTREAM
    // of the real re-convergence — so a post-merge node that ALSO joins an independent always-firing
    // producer would wrongly compile to an exclusive merge instead of the parallel AND-join both the
    // validator and the semantics demand.
    const joinExclusive =
      producers.length > 1 &&
      producers.every((p) => splitNodes.has(p) || topology.conditional.has(p));
    const forkGateway =
      consumers.length > 1 ? (forkExclusive ? `gwx${splitSeq++}` : `gwf${forkSeq++}`) : undefined;
    const joinGateway =
      producers.length > 1 ? (joinExclusive ? `gwm${mergeSeq++}` : `gwj${joinSeq++}`) : undefined;
    const wiring: NodeWiring = {
      node,
      element,
      forkGateway,
      joinGateway,
      forkExclusive: forkGateway !== undefined && forkExclusive,
      joinExclusive: joinGateway !== undefined && joinExclusive,
      entry: joinGateway ?? element,
      exit: forkGateway ?? element,
    };
    wirings.push(wiring);
    wiringById.set(node.id, wiring);
  });

  const roots = nodes.filter((n) => (producersById.get(n.id) ?? []).length === 0);
  const leaves = nodes.filter((n) => (consumersById.get(n.id) ?? []).length === 0);
  const startForkGateway = roots.length > 1 ? "gwf_start" : undefined;
  // The End sink is an exclusive merge when its leaves are mutually-exclusive branch tails (only one
  // fires per run); a parallel AND-join there would deadlock on the untaken branch. The validator has
  // already rejected a leaf set that MIXES conditional and always-firing tails.
  const endExclusive = leaves.length > 1 && leaves.some((n) => topology.conditional.has(n.id));
  const endJoinGateway = leaves.length > 1 ? (endExclusive ? "gwm_end" : "gwj_end") : undefined;

  // ── Build the flow list in a DETERMINISTIC order, then assign `f0…` ids positionally ────────────
  const flows: Omit<Flow, "id">[] = [];
  // 1. Start → root(s).
  if (roots.length === 1) {
    flows.push({ source: "Start", target: mustGet(wiringById, roots[0].id).entry });
  } else if (roots.length > 1) {
    flows.push({ source: "Start", target: "gwf_start" });
    for (const root of roots) {
      flows.push({ source: "gwf_start", target: mustGet(wiringById, root.id).entry });
    }
  }
  // 2. Structural fork flows (node → its fork gateway).
  for (const w of wirings) if (w.forkGateway) flows.push({ source: w.element, target: w.forkGateway });
  // 3. Structural join flows (join gateway → node).
  for (const w of wirings) if (w.joinGateway) flows.push({ source: w.joinGateway, target: w.element });
  // 4. Edge flows: producer.exit → consumer.entry, labelled with the referenced fact(s) when
  //    qualified. Collapse edges sharing the same (fromNode → to) endpoints into ONE sequence flow:
  //    `producersById`/`consumersById` (hence the fork/join gateways) are de-duplicated by node id, so
  //    two fact-qualified edges between the same pair (e.g. `a.x -> b` and `a.y -> b`) would otherwise
  //    emit parallel flows between endpoints with no diverging gateway — invalid BPMN that schedules
  //    the consumer more than once. `resolvedEdges` is already sorted by (to, fromNode, fromFact), so
  //    same-endpoint edges are contiguous and their fact labels accumulate in deterministic order. For
  //    a guarded split (S7) the collapsed flow carries the OR of its guard conditions (or is the split
  //    default); the producer's exit is its exclusive gateway.
  const collapsedEdges: { fromNode: string; to: string; facts: string[]; conditions: string[]; isDefault: boolean }[] =
    [];
  for (const edge of resolvedEdges) {
    const last = collapsedEdges[collapsedEdges.length - 1];
    const guardPart = guardConditionPart(edge, elementById, nodeFacts);
    if (last && last.fromNode === edge.fromNode && last.to === edge.to) {
      if (edge.fromFact !== undefined && !last.facts.includes(edge.fromFact)) last.facts.push(edge.fromFact);
      if (edge.default === true) last.isDefault = true;
      if (guardPart !== undefined && !last.conditions.includes(guardPart)) last.conditions.push(guardPart);
    } else {
      collapsedEdges.push({
        fromNode: edge.fromNode,
        to: edge.to,
        facts: edge.fromFact !== undefined ? [edge.fromFact] : [],
        conditions: guardPart !== undefined ? [guardPart] : [],
        isDefault: edge.default === true,
      });
    }
  }
  for (const edge of collapsedEdges) {
    const producer = mustGet(wiringById, edge.fromNode);
    const consumer = mustGet(wiringById, edge.to);
    let flow: Omit<Flow, "id"> = { source: producer.exit, target: consumer.entry };
    // A guard LABEL for the diagram/preview: the fact name(s), else the rendered condition / "default".
    const label =
      edge.facts.length > 0
        ? edge.facts.join(", ")
        : edge.isDefault
          ? "default"
          : edge.conditions.length > 0
            ? edge.conditions.join(" or ")
            : undefined;
    if (label !== undefined) flow = { ...flow, name: label };
    if (edge.isDefault) {
      flow = { ...flow, isDefault: true };
    } else if (edge.conditions.length > 0) {
      flow = { ...flow, condition: `=${edge.conditions.join(" or ")}` };
    }
    flows.push(flow);
  }
  // 5. Leaf(s) → End.
  if (leaves.length === 1) {
    flows.push({ source: mustGet(wiringById, leaves[0].id).exit, target: "End" });
  } else if (leaves.length > 1) {
    const endGateway = endExclusive ? "gwm_end" : "gwj_end";
    for (const leaf of leaves) {
      flows.push({ source: mustGet(wiringById, leaf.id).exit, target: endGateway });
    }
    flows.push({ source: endGateway, target: "End" });
  }
  const numberedFlows: Flow[] = flows.map((f, i) => ({ id: `f${i}`, ...f }));

  // Per-consumer late-binding inputs (S4): for every FACT-QUALIFIED edge, the consumer node receives
  // the producer's emitted fact as a `boundFacts` list entry (`{from,name,value}`), threaded from the
  // flat `<producerElement>_<fact>` variable the producer's output mapping publishes. Grouped by the
  // consumer's element id and sorted (producer element, then fact) for determinism.
  const boundInputsByElement = new Map<string, BoundInput[]>();
  for (const edge of resolvedEdges) {
    if (edge.fromFact === undefined) continue;
    const consumerEl = mustGet(elementById, edge.to);
    const producerEl = mustGet(elementById, edge.fromNode);
    const list = boundInputsByElement.get(consumerEl) ?? [];
    list.push({ fromNode: edge.fromNode, fact: edge.fromFact, producerElement: producerEl });
    boundInputsByElement.set(consumerEl, list);
  }
  for (const list of boundInputsByElement.values()) {
    list.sort((a, b) => byCodeUnit(a.producerElement, b.producerElement) || byCodeUnit(a.fact, b.fact));
  }

  // Producer-side required-emit gate (issue #731): the set of a producer's declared emit names that are
  // consumed as a REQUIRED DATA DEPENDENCY downstream — i.e. threaded on a FACT-QUALIFIED edge
  // (`from: "<node>.<fact>"`) into a consumer's connector `payload`/probe `target`. This is the SAME
  // `<producerElement>_<fact>` wiring `boundInputsByElement` derives, keyed by the PRODUCER element so a
  // node can gate its own completion on populating every fact a sibling depends on. A ROUTING emit
  // (referenced only by an edge `when` guard, never as a fact-qualified `from`) is deliberately absent
  // here — those stay optional (omit ⇒ default branch). Grouped and sorted for determinism.
  const requiredEmitsByElement = new Map<string, Set<string>>();
  for (const edge of resolvedEdges) {
    if (edge.fromFact === undefined) continue;
    const producerEl = mustGet(elementById, edge.fromNode);
    const set = requiredEmitsByElement.get(producerEl) ?? new Set<string>();
    set.add(edge.fromFact);
    requiredEmitsByElement.set(producerEl, set);
  }

  const semanticBpmn = renderBpmn(typed, wirings, numberedFlows, startForkGateway, endJoinGateway, boundInputsByElement, requiredEmitsByElement);
  const diagram = renderMermaid(typed, wirings, resolvedEdges, elementById);
  const resolved = buildResolved(typed, wirings, resolvedEdges, producersById);
  const humanNodes = buildHumanNodes(nodes);
  const sideEffects = buildSideEffects(nodes);

  return { ok: true, diagram, semanticBpmn, resolved, humanNodes, sideEffects };
}

/**
 * Validate + compile a delivery graph into a PURE preview INCLUDING diagram interchange (ADR 0005
 * slice S1). Returns the generated `CompileDeliveryGraphResult` shape (`diagram`, laid-out `bpmn`,
 * `resolved`, `humanNodes`, `sideEffects`) PLUS the pre-layout `semanticBpmn`, or `{ ok:false, errors }`
 * for a malformed graph. NEVER deploys, dispatches, or mutates anything. Deterministic: identical input
 * JSON yields byte-identical output.
 *
 * ASYNC because the final step attaches DIAGRAM INTERCHANGE (`bpmndi:BPMNDiagram`) via the toolkit
 * autolayout (`layoutBpmn` — `bpmn-auto-layout`), the SAME pass every AUTHORED process gets from
 * `npm run layout` (`scripts/layout-bpmn.ts`). This is the one BPMN in the system generated at
 * runtime, so without this it was the only one shipping DI-less — unrenderable in the process
 * explorer (#440). `layoutBpmn` is itself deterministic given identical semantic input, so
 * "same JSON → byte-identical XML" still holds with the diagram included.
 *
 * Callers that only need the content digest / preview (the agent-facing compile+STAGE doors) should
 * use the cheaper {@link compileDeliveryGraphSemantic} instead — layout here is CPU-bound and
 * superlinear (issue #716), so it belongs only on the operator's preview/dispatch/deploy paths that
 * genuinely render or run the BPMN.
 */
export async function compileDeliveryGraph(
  graph: unknown,
): Promise<CompiledDeliveryGraph | CompileDeliveryGraphErrors> {
  const semantic = await compileDeliveryGraphSemantic(graph);
  if (!semantic.ok) return semantic;
  const bpmn = await layoutDeliveryDiagram(semantic.semanticBpmn);
  return { ...semantic, bpmn };
}

/** Attach diagram interchange (`bpmndi:BPMNDiagram`) to the semantic-only compiled BPMN via the
 * toolkit autolayout — the SAME `layoutBpmn` (`bpmn-auto-layout`) pass `npm run layout` runs over
 * every authored process (`scripts/layout-bpmn.ts`), so there is ONE layout source, not two. Without
 * it, a compiled/running delivery graph rendered positionless in the process explorer (#440).
 *
 * We do NOT return `layoutBpmn`'s serialized output directly: its moddle round-trip re-serializes the
 * semantic model, and in doing so normalizes attribute quoting — a single-quote-delimited attribute
 * with literal double-quotes inside becomes a double-quoted attribute with `&#34;` entities. The
 * compiler deliberately emits FEEL string literals (`boundFacts`) with SINGLE-quote delimiters because
 * the WASM engine deploy path does NOT decode those entities before FEEL parsing (see `attr`), so a
 * round-trip would silently blank every late-bound fact. Instead we keep the compiler's carefully
 * encoded semantic XML BYTE-FOR-BYTE and graft only the computed `<bpmndi:BPMNDiagram>` block(s) onto
 * it — the diagram references element ids `layoutBpmn` leaves untouched, so the graft is sound.
 *
 * `bpmn-auto-layout` is a real runtime dependency of `@nanobpm/urban` (which re-exports `layoutBpmn`),
 * but the toolkit no-ops layout (semantic model unchanged, no DI) when it is somehow absent. That
 * silent no-op is exactly the DI-less bug this fixes, so we FAIL LOUD if the pass produced no diagram.
 * Deterministic given identical input, preserving the compiler's "same JSON → byte-identical XML". */
async function layoutDeliveryDiagram(semanticBpmn: string): Promise<string> {
  const laidOut = await layoutBpmn(semanticBpmn);
  const start = laidOut.indexOf("<bpmndi:BPMNDiagram");
  const endTag = "</bpmndi:BPMNDiagram>";
  const end = laidOut.lastIndexOf(endTag);
  if (start === -1 || end === -1) {
    throw new Error(
      "compileDeliveryGraph: layoutBpmn produced no bpmndi:BPMNDiagram, so the compiled graph would " +
        "deploy DI-less and render positionless in the process explorer (#440). This usually means the " +
        "`bpmn-auto-layout` toolkit peer is missing (the toolkit then silently no-ops layout), but it " +
        "can also indicate a change in `layoutBpmn` output (different namespace prefix/serialization) or " +
        "an internal layout failure returning semantic-only XML. Ensure `bpmn-auto-layout` is installed " +
        "as a runtime dependency and that `layoutBpmn` still emits a `<bpmndi:BPMNDiagram>` block.",
    );
  }
  const diagram = laidOut.slice(start, end + endTag.length);
  const closing = "</bpmn:definitions>";
  const insertAt = semanticBpmn.lastIndexOf(closing);
  if (insertAt === -1) {
    throw new Error("compileDeliveryGraph: compiled BPMN has no </bpmn:definitions> to graft DI into");
  }
  return `${semanticBpmn.slice(0, insertAt)}  ${diagram}\n${semanticBpmn.slice(insertAt)}`;
}

/** Push `value` into `list` (may be undefined for a dangling target, already reported by the
 * validator) only when not already present — keeps adjacency de-duplicated. */
function pushUnique(list: string[] | undefined, value: string): void {
  if (list && !list.includes(value)) list.push(value);
}

/** Build the resolved/normalised graph — nodes (sorted) with their compiled element id, engine-native
 * called element, typed emits, and sorted `dependsOn`; plus the resolved, sorted edges. */
function buildResolved(
  graph: DeliveryGraph,
  wirings: readonly NodeWiring[],
  edges: readonly ResolvedDeliveryEdge[],
  producersById: ReadonlyMap<string, string[]>,
): CompileDeliveryGraphResult["resolved"] {
  const nodes: ResolvedDeliveryNode[] = wirings.map((w) => {
    const base: ResolvedDeliveryNode = {
      id: w.node.id,
      kind: w.node.kind,
      element: w.element,
      emits: normaliseEmits(w.node),
      dependsOn: [...(producersById.get(w.node.id) ?? [])],
      calledElement: delegateTarget(w.node, w.element),
    };
    return base;
  });
  const resolved: CompileDeliveryGraphResult["resolved"] = { nodes, edges: [...edges] };
  return graph.name !== undefined ? { name: graph.name, ...resolved } : resolved;
}

/** The engine-native delegation target a node's inlined subProcess drives — its job `taskType`
 * (`agent` → the named `senior:*` job; `wait` → `pr.readiness-probe`; `connector` →
 * `pr.delivery-connector`) or, for a `human` node, its per-node user-task element id. Surfaced on the
 * resolved preview so a co-designing agent sees exactly which worker/user-task each node fans out to.
 * Deterministic and total over the closed kind set. */
function delegateTarget(node: DeliveryNode, element: string): string {
  switch (node.kind) {
    case "agent":
      return node.agent.jobType;
    case "human":
      return humanTaskElement(element);
    case "wait":
    case "connector":
      return DELEGATE_TASK_TYPE[node.kind];
    default:
      return assertNever(node, "delegateTarget");
  }
}

/** Extract the human STOP-points (sorted by id) — where the graph pauses for a person/agent, with the
 * instruction, optional attached form, and the typed facts the node will emit. */
function buildHumanNodes(nodes: readonly DeliveryNode[]): DeliveryHumanStop[] {
  const stops: DeliveryHumanStop[] = [];
  for (const node of nodes) {
    if (node.kind !== "human") continue;
    const stop: DeliveryHumanStop = { nodeId: node.id, emits: normaliseEmits(node) };
    const withPrompt = node.human?.prompt !== undefined ? { ...stop, prompt: node.human.prompt } : stop;
    stops.push(node.human?.formKey !== undefined ? { ...withPrompt, formKey: node.human.formKey } : withPrompt);
  }
  return stops;
}

/** Extract the SIDE EFFECTS (sorted by id) the compiled graph will perform — `agent` job runs and
 * `connector` outbound actions. `wait` gates are read-only and `human` stops are surfaced separately,
 * so neither is a side effect. */
function buildSideEffects(nodes: readonly DeliveryNode[]): DeliverySideEffect[] {
  const effects: DeliverySideEffect[] = [];
  for (const node of nodes) {
    if (node.kind === "agent") {
      effects.push({
        nodeId: node.id,
        kind: "agent",
        description: `runs agent job \`${node.agent.jobType}\``,
      });
    } else if (node.kind === "connector") {
      const effect: DeliverySideEffect = {
        nodeId: node.id,
        kind: "connector",
        description: `invokes connector target \`${node.connector.target}\``,
      };
      effects.push(
        node.connector.dedupeKey !== undefined ? { ...effect, dedupeKey: node.connector.dedupeKey } : effect,
      );
    }
  }
  return effects;
}

/** Render the compiled one-shot BPMN process definition (compile-to-native). Deterministic — element
 * order is fixed (start, gateways, nodes sorted, end) and every id is positional. */
function renderBpmn(
  graph: DeliveryGraph,
  wirings: readonly NodeWiring[],
  flows: readonly Flow[],
  startForkGateway: string | undefined,
  endJoinGateway: string | undefined,
  boundInputsByElement: ReadonlyMap<string, BoundInput[]>,
  requiredEmitsByElement: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  // Precompute incoming/outgoing flow-id maps once (single pass over flows) so BPMN rendering stays
  // linear in the number of flows instead of O(elements * flows) from repeated full-array filtering.
  // Insertion order is preserved, matching the previous per-element filter order.
  const incomingById = new Map<string, string[]>();
  const outgoingById = new Map<string, string[]>();
  const appendTo = (map: Map<string, string[]>, key: string, id: string): void => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const f of flows) {
    appendTo(incomingById, f.target, f.id);
    appendTo(outgoingById, f.source, f.id);
  }
  const incoming = (elementId: string): string[] => incomingById.get(elementId) ?? [];
  const outgoing = (elementId: string): string[] => outgoingById.get(elementId) ?? [];
  const refs = (tag: string, ids: readonly string[]): string =>
    ids.map((id) => `      <bpmn:${tag}>${id}</bpmn:${tag}>`).join("\n");

  // The default (else) flow id per exclusive-split gateway (S7) — the flow the gateway names in its
  // `default` attribute so an unmatched runtime value takes the else-branch instead of erroring.
  const defaultFlowBySource = new Map<string, string>();
  for (const f of flows) if (f.isDefault) defaultFlowBySource.set(f.source, f.id);

  // Render a diverging/converging gateway. `exclusive` picks `exclusiveGateway` (data-based XOR split /
  // first-token merge, S7) over the parallel AND fork/join; a diverging exclusive gateway carries its
  // `default` flow id when one exists.
  const gateway = (id: string, exclusive: boolean, name: string): string[] => {
    const tag = exclusive ? "exclusiveGateway" : "parallelGateway";
    const def = defaultFlowBySource.get(id);
    const defAttr = def !== undefined ? ` default="${def}"` : "";
    return [
      `    <bpmn:${tag} id="${id}"${defAttr} name="${escapeXml(name)}">`,
      refs("incoming", incoming(id)),
      refs("outgoing", outgoing(id)),
      `    </bpmn:${tag}>`,
    ];
  };

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
      'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ' +
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" ' +
      'id="Definitions_delivery_graph" targetNamespace="http://nanobpm.io/nano-workforce">',
  );
  const processName = graph.name ?? "Delivery graph";
  lines.push(`  <bpmn:process id="${DELIVERY_GRAPH_PROCESS_ID}" name="${escapeXml(processName)}" isExecutable="true">`);

  // Start event.
  lines.push('    <bpmn:startEvent id="Start" name="Graph opened">');
  lines.push(refs("outgoing", outgoing("Start")));
  lines.push("    </bpmn:startEvent>");

  // Start fork gateway (fan-out to multiple roots) — always a PARALLEL fork: Start unconditionally
  // activates every independent root.
  if (startForkGateway) {
    lines.push(...gateway(startForkGateway, false, "fan out to roots"));
  }

  // Node elements (sorted), each preceded by its join gateway and followed by its fork gateway. An
  // exclusive split's fork (S7) is an `exclusiveGateway` with guard conditions on its out-flows; an
  // exclusive-merge's join is a first-token `exclusiveGateway`.
  for (const w of wirings) {
    if (w.joinGateway) {
      lines.push(...gateway(w.joinGateway, w.joinExclusive, `join into ${w.node.id}`));
    }
    lines.push(
      renderNodeElement(
        w,
        incoming(w.element),
        outgoing(w.element),
        boundInputsByElement.get(w.element) ?? [],
        requiredEmitsByElement.get(w.element) ?? new Set<string>(),
      ),
    );
    if (w.forkGateway) {
      lines.push(...gateway(w.forkGateway, w.forkExclusive, `fan out of ${w.node.id}`));
    }
  }

  // End join gateway (fan-in from multiple leaves) + end event. Exclusive when the leaves are
  // mutually-exclusive branch tails (S7), else a parallel AND-join.
  if (endJoinGateway) {
    lines.push(...gateway(endJoinGateway, endJoinGateway.startsWith("gwm"), "join leaves"));
  }
  lines.push('    <bpmn:endEvent id="End" name="Graph complete">');
  lines.push(refs("incoming", incoming("End")));
  lines.push("    </bpmn:endEvent>");

  // Sequence flows. A guarded flow (S7) carries a `<bpmn:conditionExpression>` FEEL child; the default
  // flow is unconditional (the gateway names it). Condition text uses LITERAL double-quotes for FEEL
  // string literals (the authored-BPMN convention, e.g. `=status = "converged"`) — text content is not
  // subject to the attribute entity-decoding hazard, and the compiler grafts DI without re-serializing
  // this XML, so the literal quotes survive to deploy.
  for (const f of flows) {
    const nameAttr = f.name !== undefined ? ` name="${escapeXml(f.name)}"` : "";
    if (f.condition !== undefined) {
      lines.push(
        `    <bpmn:sequenceFlow id="${f.id}"${nameAttr} sourceRef="${f.source}" targetRef="${f.target}">` +
          `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${escapeXmlText(f.condition)}</bpmn:conditionExpression>` +
          "</bpmn:sequenceFlow>",
      );
    } else {
      lines.push(
        `    <bpmn:sequenceFlow id="${f.id}"${nameAttr} sourceRef="${f.source}" targetRef="${f.target}" />`,
      );
    }
  }

  lines.push("  </bpmn:process>");
  lines.push("</bpmn:definitions>");
  // Drop empty ref lines (nodes/events with no incoming or outgoing) so the output stays clean.
  return `${lines.filter((l) => l.length > 0).join("\n")}\n`;
}

/** Render one node as an EMBEDDED `bpmn:subProcess` — the engine-native delegation unit (Decision 2).
 * Call activities are a no-op on the pinned WASM engine (the child is never instantiated), so — like
 * `plan-fanout`'s `readiness-preflight` — every node inlines a subProcess that shares the parent
 * variable scope. A single outer in/out keeps the compiler's fan-out/fan-in topology clean; the
 * subProcess's own `zeebe:ioMapping` (a) seeds the body its config from `nodeInputs.<element>` (runner-
 * set), (b) threads late-binding `boundFacts` from upstream producers' emitted-fact variables, and (c)
 * publishes this node's declared emits into flat `<element>_<fact>` variables a downstream consumer
 * binds. Every node is bounded (a timeout escalates onto a human-completable user task) and resumable
 * (engine-persisted). The `switch` is EXHAUSTIVE over the closed kind union — the compile-time trust
 * bound. */
function renderNodeElement(
  w: NodeWiring,
  incoming: readonly string[],
  outgoing: readonly string[],
  boundInputs: readonly BoundInput[],
  requiredEmits: ReadonlySet<string>,
): string {
  const el = w.element;
  const name = escapeXml(`${w.node.kind}: ${w.node.id}`);
  const flowRefs = [
    ...incoming.map((id) => `      <bpmn:incoming>${id}</bpmn:incoming>`),
    ...outgoing.map((id) => `      <bpmn:outgoing>${id}</bpmn:outgoing>`),
  ];
  const io = ioMappingLines(w, boundInputs);
  const inner = innerBodyLines(w, requiredEmits);
  const lines = [
    `    <bpmn:subProcess id="${el}" name="${name}">`,
    ...flowRefs,
    "      <bpmn:extensionElements>",
    ...io,
    "      </bpmn:extensionElements>",
    ...inner,
    "    </bpmn:subProcess>",
  ];
  return lines.join("\n");
}

/** The subProcess `<zeebe:ioMapping>` lines (8-space indented, inside `extensionElements`). Inputs
 * pull the body's config from `nodeInputs.<element>` (runner-seeded) plus any late-binding
 * `boundFacts`; outputs publish the node's declared emits into flat `<element>_<fact>` variables.
 * Deterministic — fixed input/output order, positional fact targets. FEEL sources go through `attr`
 * (single-quote delimiter) so embedded string literals survive the engine's deploy path. */
function ioMappingLines(w: NodeWiring, boundInputs: readonly BoundInput[]): string[] {
  const el = w.element;
  const node = w.node;
  const inputs: { source: string; target: string }[] = [];
  const outputs: { source: string; target: string }[] = [];
  const cfg = (field: string): string => `=nodeInputs.${el}.${field}`;
  const guarded = (src: string): string => `=if (is defined(${src})) then ${src} else null`;

  switch (node.kind) {
    case "agent":
      inputs.push({ source: cfg("jobType"), target: "jobType" });
      inputs.push({ source: cfg("appendPrompt"), target: "appendPrompt" });
      inputs.push({ source: cfg("timeout"), target: "nodeTimeout" });
      // Stage 0 transcript correlation (#543): seed the transcript URL base so the completing fleet
      // worker can append its own jobKey-scoped stream and emit `transcriptUrl` (below). `transcriptUrlBase`
      // is a top-level launch variable (deliveryRunner) — guarded so a hand-seeded instance without it
      // threads null rather than raising a FEEL error.
      inputs.push({ source: guarded(TRANSCRIPT_URL_BASE_VAR), target: TRANSCRIPT_URL_BASE_VAR });
      break;
    case "wait": {
      inputs.push({ source: cfg("gateKey"), target: "gateKey" });
      // #548 late-binding: when the authored probe `target` is a `<node>.<fact>` reference to an
      // upstream emitted fact threaded on an incoming edge, rewrite the seeded probe's `target` to the
      // OBSERVED value via FEEL `context put`, so the canonical `agent → connector[converge-merge] →
      // wait[pr, merged]` shape polls the PR the agent opened with NO hardcoded literal. A plain literal
      // target (a real `owner/repo#N` is never `<node>.<fact>`-shaped) can't match a bound ref, so it
      // passes through unchanged. Guarded (`is defined`) so an as-yet-unobserved fact keeps the
      // authored value rather than raising a FEEL error.
      const boundTarget = boundInputs.find((b) => `${b.fromNode}.${b.fact}` === node.wait.target);
      if (boundTarget) {
        const varName = `${boundTarget.producerElement}_${boundTarget.fact}`;
        const probeRef = cfg("probe").slice(1);
        inputs.push({
          source: `=context put(${probeRef}, "target", if (is defined(${varName})) then ${varName} else ${probeRef}.target)`,
          target: "probe",
        });
      } else {
        inputs.push({ source: cfg("probe"), target: "probe" });
      }
      inputs.push({ source: cfg("probeTimeout"), target: "probeTimeout" });
      inputs.push({ source: cfg("probePollEvery"), target: "probePollEvery" });
      break;
    }
    case "human":
      inputs.push({ source: cfg("escalationSlaTimeout"), target: "escalationSlaTimeout" });
      inputs.push({ source: cfg("escalationAssignee"), target: "escalationAssignee" });
      // Seed the authored instruction + node identity + emit context so the generic human form renders
      // "now do X", names the parked node, and labels/hides its emit field (issue #499). `emits` is the
      // single source of truth; the emit label/mode are derived from it in FEEL here (no duplicate seed).
      inputs.push({ source: cfg("prompt"), target: "prompt" });
      inputs.push({ source: cfg("nodeId"), target: "nodeId" });
      inputs.push({ source: `=if count(${cfg("emits").slice(1)}) = 0 then "none" else "typed"`, target: "emitMode" });
      inputs.push({
        source: `=string join(for _e in ${cfg("emits").slice(1)} return _e.name + " (" + _e.type + ")", ", ")`,
        target: "emitLabel",
      });
      break;
    case "connector":
      inputs.push({ source: cfg("target"), target: "target" });
      inputs.push({ source: cfg("dedupeKey"), target: "dedupeKey" });
      inputs.push({ source: cfg("payload"), target: "payload" });
      inputs.push({ source: cfg("timeout"), target: "nodeTimeout" });
      break;
    default:
      return assertNever(node, "ioMappingLines");
  }

  // Late-binding: a deterministic FEEL list literal of the upstream producers' emitted facts, keyed
  // exactly as the edge references them (`<producerNode>.<fact>`), read from the flat parent variable
  // each producer publishes. Guarded so an as-yet-unobserved fact threads as null, not a FEEL error.
  if (boundInputs.length > 0) {
    const entries = boundInputs.map((b) => {
      const varName = `${b.producerElement}_${b.fact}`;
      return `{from: ${feelStr(b.fromNode)}, name: ${feelStr(b.fact)}, value: if (is defined(${varName})) then ${varName} else null}`;
    });
    inputs.push({ source: `=[${entries.join(", ")}]`, target: "boundFacts" });
  }

  // Outputs: publish each declared emit into `<element>_<fact>` for a downstream consumer to bind.
  for (const fact of normaliseEmits(node)) {
    outputs.push({ source: guarded(factSourceVar(node.kind, fact)), target: `${el}_${fact.name}` });
  }

  // Stage 0 transcript correlation (#543): propagate the completing worker's `transcriptUrl` (built
  // from the seeded base + its jobKey) up to the process-instance scope, where Nano Explorer's
  // variables panel renders it as the link from this run to the agent's transcript. Guarded so a job
  // completed without it (an older fleet worker) threads null instead of raising a FEEL error.
  if (node.kind === "agent") {
    outputs.push({ source: guarded(TRANSCRIPT_URL_VAR), target: TRANSCRIPT_URL_VAR });
  }

  const lines: string[] = ["        <zeebe:ioMapping>"];
  for (const i of inputs) lines.push(`          <zeebe:input ${attr("source", i.source)} target="${i.target}" />`);
  for (const o of outputs) lines.push(`          <zeebe:output ${attr("source", o.source)} target="${o.target}" />`);
  lines.push("        </zeebe:ioMapping>");
  return lines;
}

/** The inner flow of a node's subProcess (6-space indented). `agent`/`connector` delegate to a job
 * worker; `wait` polls the ReadinessProbe gate (blocking until its target is observed ready — polling
 * its OWN target is what makes an unrelated upstream event unable to falsely resolve it); `human` is
 * the S3 scheduled user-task + generic form + SLA. Each is a single-entry / single-exit subgraph with
 * a bounded timeout that escalates onto a human-completable user task (or, for `human`, records an
 * escalated outcome). */
function innerBodyLines(w: NodeWiring, requiredEmits: ReadonlySet<string>): string[] {
  const el = w.element;
  const node = w.node;
  switch (node.kind) {
    case "agent": {
      // Issue #731: an `agent` node gates its own completion on a producer contract — a terminal-success
      // self-reported `status` AND a non-null value for every declared emit a downstream consumer binds
      // as a required data dependency. A broken producer (returns `in_progress`, or omits a required
      // emit) escalates AT this node instead of threading an incomplete result onward.
      const contractGate = { requiredEmits: normaliseEmits(node).filter((f) => requiredEmits.has(f.name)) };
      return serviceBodyLines(el, node.id, attr("type", node.agent.jobType), [], node.agent.jobType, contractGate);
    }
    case "connector":
      return serviceBodyLines(el, node.id, `type="${DELEGATE_TASK_TYPE.connector}"`, [], `connector → ${node.connector.target}`);
    case "wait":
      return waitBodyLines(el, node);
    case "human":
      return humanBodyLines(el, node.id);
    default:
      return assertNever(node, "innerBodyLines");
  }
}

/** `agent`/`connector` body: `start → serviceTask → end`, with a bounded `=nodeTimeout` boundary that
 * escalates the stalled node onto a human-completable user task. `taskDefAttr` is the pre-rendered
 * `type="…"` attribute; `taskProps` are optional `<zeebe:property>` envelope lines; `descriptor`
 * names the stalled work (job type / connector target) for the escalation task's context line (#499). */
/** The FEEL boolean an `agent` node's producer-contract gate (issue #731) evaluates on its `_gate`
 * exclusive split's SUCCESS flow: the completion proceeds onward only when the self-reported `status`
 * is a terminal success (or absent/null) AND every required-data-dependency emit is populated non-null.
 * Reads the job's returned variables from the subProcess scope (the emit source var for an agent fact
 * is the fact's own name — see {@link factSourceVar}). When it is false the split's DEFAULT flow routes
 * to the contract-escalation task instead. */
function agentContractProceedCondition(requiredEmits: readonly DeliveryFact[]): string {
  const statusList = `[${AGENT_TERMINAL_SUCCESS_STATUSES.map((s) => feelStr(s)).join(", ")}]`;
  const statusOk = `(not(is defined(status)) or status = null or list contains(${statusList}, status))`;
  const emitClauses = requiredEmits.map((f) => `(is defined(${f.name}) and ${f.name} != null)`);
  return `=${[statusOk, ...emitClauses].join(" and ")}`;
}

/** The read-only context line seeded onto an `agent` node's producer-contract escalation (issue #731),
 * so the human/agent unsticking it sees WHY it parked — the node, its job type, the actual reported
 * status, and, per required emit, whether it arrived. Turns the instance-10746 failure (a silent null
 * thread + two mis-attributed CONSUMER incidents) into one correctly-attributed PRODUCER escalation. */
function agentContractContextFeel(nodeId: string, descriptor: string, requiredEmits: readonly DeliveryFact[]): string {
  const statuses = AGENT_TERMINAL_SUCCESS_STATUSES.join("/");
  const head = feelStr(
    `Node ${nodeId} (${descriptor}) completed but did not satisfy its producer contract — a producer must ` +
      `self-report a terminal-success status (${statuses}) and populate every emit a downstream node requires ` +
      "before its result routes onward. Reported status=",
  );
  let feel = `=${head} + (if (is defined(status)) then string(status) else "(none)") + "."`;
  for (const f of requiredEmits) {
    const present = `(is defined(${f.name}) and ${f.name} != null)`;
    feel += ` + " Required emit '${f.name}': " + (if ${present} then "present" else "MISSING (null)") + "."`;
  }
  return feel;
}

/** `agent`/`connector` body: `start → serviceTask → end`, with a bounded `=nodeTimeout` boundary that
 * escalates the stalled node onto a human-completable user task. `taskDefAttr` is the pre-rendered
 * `type="…"` attribute; `taskProps` are optional `<zeebe:property>` envelope lines; `descriptor`
 * names the stalled work (job type / connector target) for the escalation task's context line (#499).
 *
 * `contractGate` (agent only, issue #731) inserts a PRODUCER post-condition between the task and the
 * end: an exclusive split whose SUCCESS flow ({@link agentContractProceedCondition}) proceeds only on a
 * terminal-success `status` AND non-null required emits, and whose DEFAULT flow parks a broken producer
 * on a SECOND (contract) escalation task — distinct from the `__esc` timeout twin. That escalation is
 * RESUMABLE with the node's required emits (a human/agent supplies the missing fact, which the
 * subProcess output mapping then publishes as `<el>_<fact>`), mirroring the #514 Defect-B wait resume.
 * Omitted for a `connector` (no self-reported status contract), whose body stays `task → end`. */
function serviceBodyLines(
  el: string,
  nodeId: string,
  taskDefAttr: string,
  taskProps: readonly string[],
  descriptor: string,
  contractGate?: { requiredEmits: readonly DeliveryFact[] },
): string[] {
  const esc = escalationTaskElement(el);
  const taskExt =
    taskProps.length > 0
      ? [
          "        <bpmn:extensionElements>",
          `          <zeebe:taskDefinition ${taskDefAttr} />`,
          "          <zeebe:properties>",
          ...taskProps,
          "          </zeebe:properties>",
          "        </bpmn:extensionElements>",
        ]
      : [
          "        <bpmn:extensionElements>",
          `          <zeebe:taskDefinition ${taskDefAttr} />`,
          "        </bpmn:extensionElements>",
        ];
  const timeoutEscalation = escalationTaskLines(
    esc,
    nodeId,
    [`${el}_i2`],
    `${el}_i3`,
    escalationContextFeel(
      nodeId,
      descriptor,
      "nodeTimeout",
      "; in-flight work may already exist — check for a draft PR or partial state before retrying or reassigning.",
    ),
  );
  const head = [
    `      <bpmn:startEvent id="${el}_start"><bpmn:outgoing>${el}_i0</bpmn:outgoing></bpmn:startEvent>`,
    `      <bpmn:serviceTask id="${el}_task" name="${escapeXml(nodeId)}">`,
    ...taskExt,
    `        <bpmn:incoming>${el}_i0</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i1</bpmn:outgoing>`,
    "      </bpmn:serviceTask>",
    `      <bpmn:boundaryEvent id="${el}_be" name="Node timed out" attachedToRef="${el}_task">`,
    `        <bpmn:outgoing>${el}_i2</bpmn:outgoing>`,
    `        <bpmn:timerEventDefinition id="${el}_ted"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=nodeTimeout</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "      </bpmn:boundaryEvent>",
    ...timeoutEscalation,
  ];

  if (contractGate === undefined) {
    return [
      ...head,
      `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${el}_i1</bpmn:incoming><bpmn:incoming>${el}_i3</bpmn:incoming></bpmn:endEvent>`,
      flow(`${el}_i0`, `${el}_start`, `${el}_task`),
      flow(`${el}_i1`, `${el}_task`, `${el}_end`),
      flow(`${el}_i2`, `${el}_be`, esc),
      flow(`${el}_i3`, esc, `${el}_end`),
    ];
  }

  // Producer-contract gate (issue #731): task → gate → (proceed | contract-escalation) → end.
  const contractEsc = contractEscalationTaskElement(el);
  const emits = contractGate.requiredEmits;
  const proceedCondition = agentContractProceedCondition(emits);
  const contractEscalation = escalationTaskLines(
    contractEsc,
    nodeId,
    [`${el}_g1`],
    `${el}_g2`,
    agentContractContextFeel(nodeId, descriptor, emits),
    // Resumable when the producer owes a required emit: a human/agent supplies the missing fact, which
    // the subProcess output ioMapping then publishes as `<el>_<fact>` (agent emit source = fact name),
    // so the downstream consumer late-binds a real value instead of the null that poisoned it (#731).
    emits.length > 0 ? { resume: { kind: "agent" as const, emits } } : undefined,
  );
  return [
    ...head,
    `      <bpmn:exclusiveGateway id="${el}_gate" name="producer contract met?" default="${el}_g1">`,
    `        <bpmn:incoming>${el}_i1</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_g0</bpmn:outgoing>`,
    `        <bpmn:outgoing>${el}_g1</bpmn:outgoing>`,
    "      </bpmn:exclusiveGateway>",
    ...contractEscalation,
    `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${el}_g0</bpmn:incoming><bpmn:incoming>${el}_i3</bpmn:incoming><bpmn:incoming>${el}_g2</bpmn:incoming></bpmn:endEvent>`,
    flow(`${el}_i0`, `${el}_start`, `${el}_task`),
    flow(`${el}_i1`, `${el}_task`, `${el}_gate`),
    `      <bpmn:sequenceFlow id="${el}_g0" name="contract met" sourceRef="${el}_gate" targetRef="${el}_end"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${proceedCondition}</bpmn:conditionExpression></bpmn:sequenceFlow>`,
    `      <bpmn:sequenceFlow id="${el}_g1" name="contract broken" sourceRef="${el}_gate" targetRef="${contractEsc}" />`,
    flow(`${el}_g2`, contractEsc, `${el}_end`),
    flow(`${el}_i2`, `${el}_be`, esc),
    flow(`${el}_i3`, esc, `${el}_end`),
  ];
}

/** `wait` body: `start → pr.readiness-probe (poll) → ready? → end`, escalating on not-ready or on the
 * `=probeTimeout` engine bound. The probe polls its OWN target, so an unrelated upstream event can
 * never flip it to ready (#274/S2 concurrency-correctness); the `pr` kind (S2) binds `mergedSha`. */
function waitBodyLines(el: string, node: Extract<DeliveryNode, { kind: "wait" }>): string[] {
  const nodeId = node.id;
  const esc = escalationTaskElement(el);
  const emits = normaliseEmits(node);
  // `onTimeout` routing (#462): `escalate` (default) parks the not-ready-at-boundary token on a
  // human-completable escalation task; `continue` proceeds past the gate as not-ready WITHOUT a human
  // stop (a documented sharp edge — the downstream side-effecting node then runs without the awaited
  // fact). `fail` is rejected earlier at validation (blocked on engine terminate-end, #978), so it
  // never reaches here.
  const continueOnTimeout = node.wait?.onTimeout === "continue";
  // Defect A: read-only probe diagnostics seeded onto the escalation task so the operator/agent can
  // tell a genuine "not published yet" from a transient false-negative — the probe's last detail, the
  // resolved target/match, and a compact summary of the candidate releases the probe observed.
  const diagnosticInputs = [
    { source: "=if (is defined(detail)) then detail else null", target: "probeDetail" },
    { source: "=if (is defined(observed)) then observed else null", target: "observedReleases" },
    { source: `=if (is defined(probe.target)) then probe.target else nodeInputs.${el}.probe.target`, target: "probeTarget" },
    { source: `=nodeInputs.${el}.probe.match`, target: "probeMatch" },
  ];
  return [
    `      <bpmn:startEvent id="${el}_start"><bpmn:outgoing>${el}_i0</bpmn:outgoing></bpmn:startEvent>`,
    `      <bpmn:subProcess id="${el}_probeLoop" name="Probe readiness loop: ${escapeXml(nodeId)}">`,
    "        <bpmn:extensionElements>",
    "          <zeebe:ioMapping>",
    '            <zeebe:output source="=ready" target="ready" />',
    '            <zeebe:output source="=if (is defined(detail)) then detail else null" target="detail" />',
    '            <zeebe:output source="=if (is defined(resolvedArtifact)) then resolvedArtifact else null" target="resolvedArtifact" />',
    '            <zeebe:output source="=if (is defined(mergedSha)) then mergedSha else null" target="mergedSha" />',
    '            <zeebe:output source="=if (is defined(prCount)) then prCount else null" target="prCount" />',
    '            <zeebe:output source="=if (is defined(observed)) then observed else null" target="observed" />',
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i0</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i1</bpmn:outgoing>`,
    `        <bpmn:startEvent id="${el}_loopStart"><bpmn:outgoing>${el}_li0</bpmn:outgoing></bpmn:startEvent>`,
    `        <bpmn:serviceTask id="${el}_task" name="Probe readiness: ${escapeXml(nodeId)}">`,
    "          <bpmn:extensionElements>",
    `            <zeebe:taskDefinition type="${DELEGATE_TASK_TYPE.wait}" />`,
    "            <zeebe:properties>",
    '              <zeebe:property name="io.nanobpm.dataEnvelope.in" value="ReadinessProbeIn" />',
    '              <zeebe:property name="io.nanobpm.dataEnvelope.out" value="ReadinessProbeOut" />',
    "            </zeebe:properties>",
    "          </bpmn:extensionElements>",
    `          <bpmn:incoming>${el}_li0</bpmn:incoming>`,
    `          <bpmn:incoming>${el}_li4</bpmn:incoming>`,
    `          <bpmn:outgoing>${el}_li1</bpmn:outgoing>`,
    "        </bpmn:serviceTask>",
    `        <bpmn:exclusiveGateway id="${el}_gw" name="ready?" default="${el}_li3">`,
    `          <bpmn:incoming>${el}_li1</bpmn:incoming>`,
    `          <bpmn:outgoing>${el}_li2</bpmn:outgoing>`,
    `          <bpmn:outgoing>${el}_li3</bpmn:outgoing>`,
    "        </bpmn:exclusiveGateway>",
    `        <bpmn:intermediateCatchEvent id="${el}_waitPoll" name="Wait poll interval">`,
    `          <bpmn:incoming>${el}_li3</bpmn:incoming>`,
    `          <bpmn:outgoing>${el}_li4</bpmn:outgoing>`,
    `          <bpmn:timerEventDefinition id="${el}_pollTed"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=probePollEvery</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "        </bpmn:intermediateCatchEvent>",
    `        <bpmn:endEvent id="${el}_loopEnd"><bpmn:incoming>${el}_li2</bpmn:incoming></bpmn:endEvent>`,
    flow(`${el}_li0`, `${el}_loopStart`, `${el}_task`),
    flow(`${el}_li1`, `${el}_task`, `${el}_gw`),
    `      <bpmn:sequenceFlow id="${el}_li2" name="ready" sourceRef="${el}_gw" targetRef="${el}_loopEnd"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=ready = true</bpmn:conditionExpression></bpmn:sequenceFlow>`,
    `        <bpmn:sequenceFlow id="${el}_li3" name="not ready" sourceRef="${el}_gw" targetRef="${el}_waitPoll" />`,
    flow(`${el}_li4`, `${el}_waitPoll`, `${el}_task`),
    "      </bpmn:subProcess>",
    `      <bpmn:boundaryEvent id="${el}_be" name="Gate timed out" attachedToRef="${el}_probeLoop">`,
    `        <bpmn:outgoing>${el}_i2</bpmn:outgoing>`,
    `        <bpmn:timerEventDefinition id="${el}_ted"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=probeTimeout</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "      </bpmn:boundaryEvent>",
    `      <bpmn:serviceTask id="${el}_lastAttempt" name="Probe readiness at boundary: ${escapeXml(nodeId)}">`,
    "        <bpmn:extensionElements>",
    `          <zeebe:taskDefinition type="${DELEGATE_TASK_TYPE.wait}" />`,
    "          <zeebe:properties>",
    '            <zeebe:property name="io.nanobpm.dataEnvelope.in" value="ReadinessProbeIn" />',
    '            <zeebe:property name="io.nanobpm.dataEnvelope.out" value="ReadinessProbeOut" />',
    "          </zeebe:properties>",
    "          <zeebe:ioMapping>",
    '            <zeebe:input source="=true" target="lastAttempt" />',
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i2</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i6</bpmn:outgoing>`,
    "      </bpmn:serviceTask>",
    `      <bpmn:exclusiveGateway id="${el}_lastGw" name="ready after boundary?" default="${el}_i4">`,
    `        <bpmn:incoming>${el}_i6</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i7</bpmn:outgoing>`,
    `        <bpmn:outgoing>${el}_i4</bpmn:outgoing>`,
    "      </bpmn:exclusiveGateway>",
    ...(continueOnTimeout
      ? []
      : escalationTaskLines(
          esc,
          nodeId,
          [`${el}_i4`],
          `${el}_i5`,
          waitEscalationContextFeel(nodeId),
          { resume: { kind: node.kind, emits }, diagnosticInputs },
        )),
    // On `continue`, the not-ready-at-boundary branch (`_i4`) proceeds straight to the node end (no
    // human stop, no `_i5` escalation-return flow); on `escalate` it parks on the escalation task,
    // which returns via `_i5`.
    `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${el}_i1</bpmn:incoming>${continueOnTimeout ? `<bpmn:incoming>${el}_i4</bpmn:incoming>` : `<bpmn:incoming>${el}_i5</bpmn:incoming>`}<bpmn:incoming>${el}_i7</bpmn:incoming></bpmn:endEvent>`,
    flow(`${el}_i0`, `${el}_start`, `${el}_probeLoop`),
    flow(`${el}_i1`, `${el}_probeLoop`, `${el}_end`),
    flow(`${el}_i2`, `${el}_be`, `${el}_lastAttempt`),
    flow(`${el}_i6`, `${el}_lastAttempt`, `${el}_lastGw`),
    `      <bpmn:sequenceFlow id="${el}_i7" name="ready" sourceRef="${el}_lastGw" targetRef="${el}_end"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=ready = true</bpmn:conditionExpression></bpmn:sequenceFlow>`,
    `      <bpmn:sequenceFlow id="${el}_i4" name="not ready" sourceRef="${el}_lastGw" targetRef="${continueOnTimeout ? `${el}_end` : esc}" />`,
    ...(continueOnTimeout ? [] : [flow(`${el}_i5`, esc, `${el}_end`)]),
  ];
}

/** `human` body: the S3 scheduled user-task (`delivery-human-task__<el>`) + generic form + assignment
 * + SLA. On completion the form's captured typed value is output (`humanEmitValue`/`humanEmitArtifact`
 * — the subProcess ioMapping then publishes it as the node's fact); on SLA expiry the node records an
 * `escalated` outcome and settles (bounded — the graph cannot silently wedge). Mirrors the standalone
 * `delivery-human.bpmn` shape, reusing the S3 form + emit-var contract (`deliveryHuman.ts`). */
function humanBodyLines(el: string, nodeId: string): string[] {
  const task = humanTaskElement(el);
  const assignee =
    '=if (is defined(escalationAssignee) and escalationAssignee != null and trim(string(escalationAssignee)) != "") then escalationAssignee else null';
  return [
    `      <bpmn:startEvent id="${el}_start"><bpmn:outgoing>${el}_i0</bpmn:outgoing></bpmn:startEvent>`,
    `      <bpmn:userTask id="${task}" name="Delivery: human step — ${escapeXml(nodeId)}">`,
    "        <bpmn:extensionElements>",
    `          <zeebe:formDefinition formId="${GENERIC_HUMAN_FORM}" />`,
    "          <zeebe:userTask />",
    `          <zeebe:assignmentDefinition candidateGroups="operators" ${attr("assignee", assignee)} />`,
    "          <zeebe:ioMapping>",
    `            <zeebe:output ${attr("source", '="completed"')} target="humanOutcome" />`,
    `            <zeebe:output ${attr("source", "=if (is defined(value)) then value else null")} target="humanEmitValue" />`,
    `            <zeebe:output ${attr("source", "=if (is defined(resolvedArtifact)) then resolvedArtifact else null")} target="humanEmitArtifact" />`,
    `            <zeebe:output ${attr("source", "=if (is defined(note)) then note else null")} target="humanNote" />`,
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i0</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i1</bpmn:outgoing>`,
    "      </bpmn:userTask>",
    `      <bpmn:boundaryEvent id="${el}_sla" name="SLA elapsed" attachedToRef="${task}">`,
    `        <bpmn:outgoing>${el}_i2</bpmn:outgoing>`,
    `        <bpmn:timerEventDefinition id="${el}_ted"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=escalationSlaTimeout</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "      </bpmn:boundaryEvent>",
    `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${el}_i1</bpmn:incoming></bpmn:endEvent>`,
    `      <bpmn:endEvent id="${el}_escEnd" name="Escalated">`,
    "        <bpmn:extensionElements>",
    `          <zeebe:ioMapping><zeebe:input ${attr("source", '="escalated"')} target="humanOutcome" /></zeebe:ioMapping>`,
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i2</bpmn:incoming>`,
    "      </bpmn:endEvent>",
    flow(`${el}_i0`, `${el}_start`, task),
    flow(`${el}_i1`, task, `${el}_end`),
    flow(`${el}_i2`, `${el}_sla`, `${el}_escEnd`),
  ];
}

/** A bounded node's escalation user task — a human-completable stop (`isDeliveryHumanElement`
 * convention) that a human OR an agent (ADR 0046) answers to unstick a stalled node. `contextFeel` is
 * a FEEL expression yielding the context line seeded onto the generic form's read-only prompt field
 * (issue #499) — e.g. "Node n1 (senior:feature) exceeded its SLA (PT30M); …" — so the operator can see
 * WHICH node timed out and that in-flight work may already exist, instead of a blank form.
 *
 * `opts.resume` turns an inert escalation into a RESUMABLE one (issue #514 Defect B): when the parked
 * `wait` node declares emits, the form must both PRESENT its typed-value field (so `emitMode`/
 * `emitLabel` are derived from those emits, not forced to "none") and, on completion, MAP the
 * operator-supplied value onto the node's emit-source variable (`detail` for scalar/version,
 * `resolvedArtifact` for artifact, `mergedSha` for a merge oid — {@link factSourceVar}). Without that
 * mapping a naive resume publishes `<el>_<fact> = null`, silently starving the downstream consumer.
 * `opts.diagnosticInputs` seeds read-only probe context (issue #514 Defect A) onto the same task so the
 * operator can see WHY the gate escalated (its last probe detail + observed candidate releases). */
function escalationTaskLines(
  esc: string,
  nodeId: string,
  incoming: readonly string[],
  outgoing: string,
  contextFeel: string,
  opts?: {
    resume?: { kind: DeliveryNode["kind"]; emits: readonly DeliveryFact[] };
    diagnosticInputs?: readonly { source: string; target: string }[];
  },
): string[] {
  const emits = opts?.resume?.emits ?? [];
  const emitMode = emits.length > 0 ? "typed" : "none";
  const emitLabel = emits.map((e) => `${e.name} (${e.type})`).join(", ");
  const inputs: string[] = [
    `            <zeebe:input ${attr("source", contextFeel)} target="prompt" />`,
    `            <zeebe:input ${attr("source", `=${feelStr(nodeId)}`)} target="nodeId" />`,
    `            <zeebe:input ${attr("source", `=${feelStr(emitMode)}`)} target="emitMode" />`,
  ];
  if (emits.length > 0) {
    inputs.push(`            <zeebe:input ${attr("source", `=${feelStr(emitLabel)}`)} target="emitLabel" />`);
  }
  for (const di of opts?.diagnosticInputs ?? []) {
    inputs.push(`            <zeebe:input ${attr("source", di.source)} target="${di.target}" />`);
  }
  // Defect B: map the operator's captured typed value onto the node's emit-source var, so the
  // subProcess output ioMapping publishes the SAME `<el>_<fact>` shape a normally-completing node does.
  const outputs: string[] = [];
  if (opts?.resume) {
    const seen = new Set<string>();
    for (const fact of emits) {
      const target = factSourceVar(opts.resume.kind, fact);
      if (seen.has(target)) continue;
      seen.add(target);
      // The generic escalation form (`GENERIC_HUMAN_FORM`) captures the operator's answer in a single
      // `value` field — it has NO `resolvedArtifact` field — so every emit type resumes from `value`,
      // mapped onto that fact's emit-source var (artifact→resolvedArtifact, version→detail, …). Sourcing
      // an artifact from a `resolvedArtifact` form field the form never sets would publish null and make
      // an artifact wait-node escalation non-resumable via the UI.
      outputs.push(
        `            <zeebe:output ${attr("source", `=if (is defined(value)) then value else null`)} target="${target}" />`,
      );
    }
  }
  return [
    `      <bpmn:userTask id="${esc}" name="Escalate: ${escapeXml(nodeId)}">`,
    "        <bpmn:extensionElements>",
    `          <zeebe:formDefinition formId="${GENERIC_HUMAN_FORM}" />`,
    "          <zeebe:userTask />",
    '          <zeebe:assignmentDefinition candidateGroups="operators" />',
    "          <zeebe:ioMapping>",
    ...inputs,
    ...outputs,
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    ...incoming.map((id) => `        <bpmn:incoming>${id}</bpmn:incoming>`),
    `        <bpmn:outgoing>${outgoing}</bpmn:outgoing>`,
    "      </bpmn:userTask>",
  ];
}

/** Build the FEEL context line seeded onto an escalation task's read-only prompt field (issue #499).
 * The node id + descriptor (job type / connector target / "readiness gate") are baked as compile-time
 * literals; the elapsed SLA is read from the node body's runtime `timeoutVar` (`nodeTimeout` for a
 * bounded service node, `probeTimeout` for a `wait` gate). `tail` closes the sentence per kind. */
function escalationContextFeel(nodeId: string, descriptor: string, timeoutVar: string, tail: string): string {
  const head = feelStr(`Node ${nodeId} (${descriptor}) exceeded its SLA (`);
  return `=${head} + string(${timeoutVar}) + ${feelStr(`)${tail}`)}`;
}

/** The escalation context line for a `wait` gate (issue #514 Defect A). Extends the base #499 line with
 * the probe's RUNTIME last `detail` and its observed-candidate summary (`observed`), so a human/agent
 * reading the (read-only) prompt can immediately tell a genuine "not published yet" from a transient
 * false-negative — without hunting for the internal variables. Both are folded in defensively (an
 * as-yet-unset var renders "—", never a FEEL error). */
function waitEscalationContextFeel(nodeId: string): string {
  const base = escalationContextFeel(
    nodeId,
    "readiness gate",
    "probeTimeout",
    " before its ReadinessProbe went green — decide how to proceed.",
  );
  const lastProbe = `(if (is defined(detail)) then string(detail) else "—")`;
  const observed = `(if (is defined(observed)) then string(observed) else "—")`;
  return `${base} + " Last probe: " + ${lastProbe} + ". Observed: " + ${observed} + "."`;
}

/** A plain `<bpmn:sequenceFlow>` (6-space indented). */
function flow(id: string, source: string, target: string): string {
  return `      <bpmn:sequenceFlow id="${id}" sourceRef="${source}" targetRef="${target}" />`;
}

/** Render a human-readable mermaid `flowchart` of the resolved graph — one node per box labelled
 * `<kind>: <id>`, one arrow per edge (labelled with the referenced fact when qualified). Deterministic
 * (nodes/edges already sorted). */
function renderMermaid(
  graph: DeliveryGraph,
  wirings: readonly NodeWiring[],
  edges: readonly ResolvedDeliveryEdge[],
  elementById: ReadonlyMap<string, string>,
): string {
  const lines: string[] = ["flowchart TD"];
  if (graph.name !== undefined) lines.push(`  %% ${escapeMermaid(graph.name)}`);
  for (const w of wirings) {
    lines.push(`  ${w.element}["${escapeMermaid(`${w.node.kind}: ${w.node.id}`)}"]`);
  }
  for (const edge of edges) {
    const from = mustGet(elementById, edge.fromNode);
    const to = mustGet(elementById, edge.to);
    // Label a guarded edge with its predicate (`fact == value`) and a default with `default` (S7), a
    // fact-qualified edge with the fact name, else an unlabelled arrow.
    let label: string | undefined;
    if (edge.when !== undefined && edge.default !== true) {
      const guardFact = edge.when.includes(".") ? edge.when.slice(edge.when.lastIndexOf(".") + 1) : edge.when;
      label = `${guardFact} == ${feelLiteral(edge.equals)}`;
    } else if (edge.default === true) {
      label = "default";
    } else if (edge.fromFact !== undefined) {
      label = edge.fromFact;
    }
    if (label !== undefined) {
      lines.push(`  ${from} -- "${escapeMermaid(label)}" --> ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
