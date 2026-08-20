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
import {
  type DeliveryGraphError,
  deliveryNodeFacts,
  resolveDeliveryFrom,
  validateDeliveryGraph,
} from "./deliveryGraph.ts";

/** The engine-native sub-process each non-human node kind delegates to (Decision 2 — the graph
 * SCHEDULES, it does not re-implement execution). `wait` reuses the REAL `readiness-gate` process
 * (`resources/processes/readiness-gate.bpmn`); `agent`/`connector` target forward-declared bodies
 * that slice S4 binds to their concrete implementations. `human` has NO called element — it compiles
 * to a native user task, not a call activity. Kept as the single source of truth so the compiler and
 * the resolved-preview agree on the target. */
const CALLED_ELEMENT: Record<Exclude<DeliveryNode["kind"], "human">, string> = {
  agent: "delivery-node-agent",
  wait: "readiness-gate",
  connector: "delivery-node-connector",
};

/** A never-reached exhaustiveness guard: `compileNode`'s `switch` covers every allowlisted kind, so
 * the closed union narrows to `never` here. If a future kind is added to the vocabulary without a
 * compiler arm, `tsc` flags this call — the compile-time half of the trust bound. */
function assertNever(value: never, context: string): never {
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

/** Escape a string for use inside a mermaid quoted label. Mermaid uses `#` HTML-entity escapes; a
 * double quote inside a `"…"` label must become `#quot;` so the label stays well-formed. */
function escapeMermaid(value: string): string {
  return value.replace(/"/g, "#quot;").replace(/\n/g, " ");
}

/** A node's typed emits, normalised to a stable array (absent → `[]`). */
function normaliseEmits(node: DeliveryNode): DeliveryFact[] {
  return Array.isArray(node.emits) ? node.emits.map((f) => ({ ...f })) : [];
}

/** One sequence flow in the compiled process — `source`/`target` are element ids, `name` an optional
 * (fact) label. */
interface Flow {
  id: string;
  source: string;
  target: string;
  name?: string;
}

/** A compiled node's structural fixtures: its own BPMN `element` id, and — when it has >1 downstream
 * or >1 upstream — the parallel fork/join gateway that fans its flow out/in. `entry` is the id
 * upstream flows target (the join, else the element); `exit` is the id downstream flows leave from
 * (the fork, else the element). */
interface NodeWiring {
  node: DeliveryNode;
  element: string;
  forkGateway?: string;
  joinGateway?: string;
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

/**
 * Validate + compile a delivery graph into a PURE preview (ADR 0005 slice S1). Returns
 * `{ ok:true, diagram, bpmn, resolved, humanNodes, sideEffects }` for a well-formed graph, or
 * `{ ok:false, errors }` (each error path-qualified) for a malformed one. NEVER deploys, dispatches,
 * or mutates anything — safe to call repeatedly. Deterministic: identical input JSON yields
 * byte-identical output.
 */
export function compileDeliveryGraph(graph: unknown): CompileDeliveryGraphResult | CompileDeliveryGraphErrors {
  const validationErrors: DeliveryGraphError[] = validateDeliveryGraph(graph);
  if (validationErrors.length > 0) {
    // Forward every semantic failure verbatim as a wire `{ path, message }` (the stable `code` stays
    // server-side). Nothing is compiled — the agent fixes the exact offending input and re-compiles.
    return { ok: false, errors: validationErrors.map(({ path, message }) => ({ path, message })) };
  }

  // The graph passed both the OpenAPI shape gate (at the edge) and the semantic validator, so it is
  // safe to narrow to the typed contract. Every field below is well-formed by construction.
  // biome-ignore lint/plugin: validated external body narrowed to its contract after validateDeliveryGraph
  const typed = graph as DeliveryGraph;
  const nodes = [...typed.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = Array.isArray(typed.edges) ? typed.edges : [];

  // Resolve every edge's `from` endpoint against the SAME node/fact map the validator checked (shared
  // helper — no drift), then sort edges deterministically by (consumer, producer, fact).
  const nodeFacts = deliveryNodeFacts(typed);
  const resolvedEdges: ResolvedDeliveryEdge[] = edges
    .map((edge) => {
      const { nodeId, fact } = resolveDeliveryFrom(edge.from, nodeFacts);
      const resolved: ResolvedDeliveryEdge = { from: edge.from, to: edge.to, fromNode: nodeId };
      return fact !== undefined ? { ...resolved, fromFact: fact } : resolved;
    })
    .sort(
      (a, b) =>
        a.to.localeCompare(b.to) ||
        a.fromNode.localeCompare(b.fromNode) ||
        (a.fromFact ?? "").localeCompare(b.fromFact ?? ""),
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
  for (const list of producersById.values()) list.sort((a, b) => a.localeCompare(b));
  for (const list of consumersById.values()) list.sort((a, b) => a.localeCompare(b));

  // Assign the deterministic BPMN element id per node (`n0`, `n1`, … in sorted order) plus the
  // fork/join gateway ids (`gwf<i>` / `gwj<i>`) any fan-out/fan-in node needs.
  const elementById = new Map<string, string>();
  const wirings: NodeWiring[] = [];
  const wiringById = new Map<string, NodeWiring>();
  let forkSeq = 0;
  let joinSeq = 0;
  nodes.forEach((node, i) => {
    const element = `n${i}`;
    elementById.set(node.id, element);
    const consumers = consumersById.get(node.id) ?? [];
    const producers = producersById.get(node.id) ?? [];
    const forkGateway = consumers.length > 1 ? `gwf${forkSeq++}` : undefined;
    const joinGateway = producers.length > 1 ? `gwj${joinSeq++}` : undefined;
    const wiring: NodeWiring = {
      node,
      element,
      forkGateway,
      joinGateway,
      entry: joinGateway ?? element,
      exit: forkGateway ?? element,
    };
    wirings.push(wiring);
    wiringById.set(node.id, wiring);
  });

  const roots = nodes.filter((n) => (producersById.get(n.id) ?? []).length === 0);
  const leaves = nodes.filter((n) => (consumersById.get(n.id) ?? []).length === 0);
  const startForkGateway = roots.length > 1 ? "gwf_start" : undefined;
  const endJoinGateway = leaves.length > 1 ? "gwj_end" : undefined;

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
  // 4. Edge flows: producer.exit → consumer.entry, labelled with the referenced fact when qualified.
  for (const edge of resolvedEdges) {
    const producer = mustGet(wiringById, edge.fromNode);
    const consumer = mustGet(wiringById, edge.to);
    const flow: Omit<Flow, "id"> = { source: producer.exit, target: consumer.entry };
    flows.push(edge.fromFact !== undefined ? { ...flow, name: edge.fromFact } : flow);
  }
  // 5. Leaf(s) → End.
  if (leaves.length === 1) {
    flows.push({ source: mustGet(wiringById, leaves[0].id).exit, target: "End" });
  } else if (leaves.length > 1) {
    for (const leaf of leaves) {
      flows.push({ source: mustGet(wiringById, leaf.id).exit, target: "gwj_end" });
    }
    flows.push({ source: "gwj_end", target: "End" });
  }
  const numberedFlows: Flow[] = flows.map((f, i) => ({ id: `f${i}`, ...f }));

  const bpmn = renderBpmn(typed, wirings, numberedFlows, startForkGateway, endJoinGateway);
  const diagram = renderMermaid(typed, wirings, resolvedEdges, elementById);
  const resolved = buildResolved(typed, wirings, resolvedEdges, producersById);
  const humanNodes = buildHumanNodes(nodes);
  const sideEffects = buildSideEffects(nodes);

  return { ok: true, diagram, bpmn, resolved, humanNodes, sideEffects };
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
    };
    return w.node.kind === "human" ? base : { ...base, calledElement: CALLED_ELEMENT[w.node.kind] };
  });
  const resolved: CompileDeliveryGraphResult["resolved"] = { nodes, edges: [...edges] };
  return graph.name !== undefined ? { name: graph.name, ...resolved } : resolved;
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
): string {
  const incoming = (elementId: string): string[] =>
    flows.filter((f) => f.target === elementId).map((f) => f.id);
  const outgoing = (elementId: string): string[] =>
    flows.filter((f) => f.source === elementId).map((f) => f.id);
  const refs = (tag: string, ids: readonly string[]): string =>
    ids.map((id) => `      <bpmn:${tag}>${id}</bpmn:${tag}>`).join("\n");

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
      'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" ' +
      'id="Definitions_delivery_graph" targetNamespace="http://nanobpm.io/nano-workforce">',
  );
  const processName = graph.name ?? "Delivery graph";
  lines.push(`  <bpmn:process id="delivery-graph" name="${escapeXml(processName)}" isExecutable="true">`);

  // Start event.
  lines.push('    <bpmn:startEvent id="Start" name="Graph opened">');
  lines.push(refs("outgoing", outgoing("Start")));
  lines.push("    </bpmn:startEvent>");

  // Start fork gateway (fan-out to multiple roots).
  if (startForkGateway) {
    lines.push(`    <bpmn:parallelGateway id="${startForkGateway}" name="fan out to roots">`);
    lines.push(refs("incoming", incoming(startForkGateway)));
    lines.push(refs("outgoing", outgoing(startForkGateway)));
    lines.push("    </bpmn:parallelGateway>");
  }

  // Node elements (sorted), each preceded by its join gateway and followed by its fork gateway.
  for (const w of wirings) {
    if (w.joinGateway) {
      lines.push(`    <bpmn:parallelGateway id="${w.joinGateway}" name="join into ${escapeXml(w.node.id)}">`);
      lines.push(refs("incoming", incoming(w.joinGateway)));
      lines.push(refs("outgoing", outgoing(w.joinGateway)));
      lines.push("    </bpmn:parallelGateway>");
    }
    lines.push(renderNodeElement(w, incoming(w.element), outgoing(w.element)));
    if (w.forkGateway) {
      lines.push(`    <bpmn:parallelGateway id="${w.forkGateway}" name="fan out of ${escapeXml(w.node.id)}">`);
      lines.push(refs("incoming", incoming(w.forkGateway)));
      lines.push(refs("outgoing", outgoing(w.forkGateway)));
      lines.push("    </bpmn:parallelGateway>");
    }
  }

  // End join gateway (fan-in from multiple leaves) + end event.
  if (endJoinGateway) {
    lines.push(`    <bpmn:parallelGateway id="${endJoinGateway}" name="join leaves">`);
    lines.push(refs("incoming", incoming(endJoinGateway)));
    lines.push(refs("outgoing", outgoing(endJoinGateway)));
    lines.push("    </bpmn:parallelGateway>");
  }
  lines.push('    <bpmn:endEvent id="End" name="Graph complete">');
  lines.push(refs("incoming", incoming("End")));
  lines.push("    </bpmn:endEvent>");

  // Sequence flows.
  for (const f of flows) {
    const nameAttr = f.name !== undefined ? ` name="${escapeXml(f.name)}"` : "";
    lines.push(
      `    <bpmn:sequenceFlow id="${f.id}"${nameAttr} sourceRef="${f.source}" targetRef="${f.target}" />`,
    );
  }

  lines.push("  </bpmn:process>");
  lines.push("</bpmn:definitions>");
  // Drop empty ref lines (nodes/events with no incoming or outgoing) so the output stays clean.
  return `${lines.filter((l) => l.length > 0).join("\n")}\n`;
}

/** Render one node's BPMN element — a `callActivity` delegating to its engine-native body for
 * `agent`/`wait`/`connector` (Decision 2), or a native `userTask` for `human`. The `switch` is
 * EXHAUSTIVE over the closed kind union (the compile-time trust bound): a non-allowlisted kind cannot
 * be instantiated. */
function renderNodeElement(w: NodeWiring, incoming: readonly string[], outgoing: readonly string[]): string {
  const node = w.node;
  const name = escapeXml(`${node.kind}: ${node.id}`);
  const flowRefs =
    incoming.map((id) => `      <bpmn:incoming>${id}</bpmn:incoming>`).join("\n") +
    (incoming.length > 0 && outgoing.length > 0 ? "\n" : "") +
    outgoing.map((id) => `      <bpmn:outgoing>${id}</bpmn:outgoing>`).join("\n");
  const body = flowRefs.length > 0 ? `\n${flowRefs}\n    ` : "";

  switch (node.kind) {
    case "agent":
    case "wait":
    case "connector": {
      const called = CALLED_ELEMENT[node.kind];
      return (
        `    <bpmn:callActivity id="${w.element}" name="${name}">\n` +
        `      <bpmn:extensionElements>\n` +
        `        <zeebe:calledElement processId="${called}" propagateAllChildVariables="false" />\n` +
        `      </bpmn:extensionElements>${body ? "" : "\n"}` +
        (body ? body : "") +
        `</bpmn:callActivity>`
      );
    }
    case "human":
      return (
        `    <bpmn:userTask id="${w.element}" name="${name}">\n` +
        `      <bpmn:extensionElements>\n` +
        `        <zeebe:userTask />\n` +
        `      </bpmn:extensionElements>${body ? "" : "\n"}` +
        (body ? body : "") +
        `</bpmn:userTask>`
      );
    default:
      return assertNever(node, "renderNodeElement");
  }
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
    if (edge.fromFact !== undefined) {
      lines.push(`  ${from} -- "${escapeMermaid(edge.fromFact)}" --> ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
