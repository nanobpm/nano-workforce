// app/deliveryGraphProgress.ts — per-node progress of a RUNNING delivery graph (issue #1055).
//
// `GET /app/api/delivery-graph/runs/{runKey}` (`d8ctl nwf graph progress <runKey>`) answers "which gates
// are satisfied, which node is active, which PR did an agent bind" for a dispatched run, instead of the
// bare `status: running` the status endpoint shows.
//
// DERIVED, NOT STORED (no drift surface): nothing here is persisted. The node → compiled-element map is
// re-derived from the run's dispatched graph (the `delivery_graph_proposals` row keyed by the run's
// content `digest`, recompiled by the ONE `compileDeliveryGraphSemantic` compiler), and every per-node
// state is read from ENGINE TRUTH at request time:
//   • element instances of the run's process instance — each graph node is ONE inlined subProcess whose
//     id is the node's compiled `element` (`n0`, `n1`, …); its inner elements are `<element>_*` or the
//     human/escalation user tasks `delivery-human-task__<element>[__esc|__contract]`;
//   • open user tasks — a parked escalation / contract-repair twin, or a human node's own task;
//   • incidents — a node with an active incident on any of its elements is `failed`;
//   • variables — a node's bound facts are the flat `<element>_<fact>` run-root variables the compiler's
//     output mapping publishes, and a wait's last probe result is the `ready`/`detail`/`observed` the
//     `pr.readiness-probe` worker wrote into the probe loop's scope.
// The pure {@link deriveNodeProgress} folds those reads into the per-node view so it unit-tests without
// an engine; {@link loadDeliveryGraphProgress} does the reads.

import type { AppApi } from "@nanobpm/urban";
import type { DeliveryGraph, DeliveryGraphNodeProgress, DeliveryGraphRunProgress } from "../nano-generated/api-io.d.ts";
import { isConvergeTarget } from "./convergeTargets.ts";
import { type BoundFact, resolveConvergePr } from "./deliveryConnector.ts";
import { compileDeliveryGraphSemantic } from "./deliveryGraphCompiler.ts";
import { deliveryGraphProposals } from "./deliveryGraphProposals.ts";
import { type DeliveryGraphRun, deliveryGraphRuns } from "./deliveryGraphRun.ts";
import { parsePr } from "./prParse.ts";

/** A node's derived lifecycle state. */
export type DeliveryNodeState = DeliveryGraphNodeProgress["state"];

/** One element instance as the engine reports it (the subset this projection reads). */
export interface ElementInstanceFact {
  elementId: string;
  elementInstanceKey: string;
  state: "ACTIVE" | "COMPLETED" | "TERMINATED";
}
/** One variable as the engine reports it (value is serialized JSON). */
export interface VariableFact {
  name: string;
  value: string;
  scopeKey: string;
  /** The engine clipped `value` to a preview — it is NOT the complete value and must not be parsed as one. */
  isTruncated?: boolean;
}
/** One open user task (the subset this projection reads). */
export interface UserTaskFact {
  userTaskKey: string;
  elementId?: string;
}
/** One active incident (the subset this projection reads). */
export interface IncidentFact {
  incidentKey: string;
  elementId?: string;
  errorType?: string;
  errorMessage?: string;
}
/** A resolved graph node: author id, kind, compiled element id and declared emitted fact names. */
export interface ResolvedNodeRef {
  id: string;
  kind: DeliveryNodeProgress["kind"];
  element: string;
  emits: { name: string; type?: string }[];
  dependsOn: string[];
}

/** The per-node / per-run progress shapes are the OpenAPI contract's (`openapi.yaml`
 * `DeliveryGraphNodeProgress` / `DeliveryGraphRunProgress`) — derived, never re-declared here. */
export type DeliveryNodeProgress = DeliveryGraphNodeProgress;
export type { DeliveryGraphRunProgress };

type DeliveryNodeEscalation = NonNullable<DeliveryNodeProgress["escalation"]>;
type DeliveryNodeIncident = NonNullable<DeliveryNodeProgress["incident"]>;
type DeliveryNodeProbe = NonNullable<DeliveryNodeProgress["lastProbe"]>;

/** Which compiled node element owns a BPMN element id, given the set of node elements. */
export function owningNodeElement(elementId: string, nodeElements: ReadonlySet<string>): string | null {
  if (nodeElements.has(elementId)) return elementId;
  const HUMAN = "delivery-human-task__";
  if (elementId.startsWith(HUMAN)) {
    const rest = elementId.slice(HUMAN.length);
    const cut = rest.indexOf("__");
    const el = cut === -1 ? rest : rest.slice(0, cut);
    return nodeElements.has(el) ? el : null;
  }
  const us = elementId.indexOf("_");
  if (us > 0) {
    const prefix = elementId.slice(0, us);
    if (nodeElements.has(prefix)) return prefix;
  }
  return null;
}

/** A numeric engine key as a bigint for ordering; null when it is not a decimal key. */
function keyOrder(key: string): bigint | null {
  return /^\d+$/.test(key) ? BigInt(key) : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** An `owner/repo#N` PR key from a bound fact value (a key string, a GitHub PR URL, or `{ key|url }`). */
export function prKeyOf(value: unknown): string | null {
  if (typeof value === "string") {
    const pr = parsePr(value);
    return pr ? pr.prKey : null;
  }
  if (value !== null && typeof value === "object") {
    for (const k of ["key", "prKey", "url", "html_url"]) {
      const v: unknown = Reflect.get(value, k);
      const key = prKeyOf(v);
      if (key) return key;
    }
  }
  return null;
}

/** Fold the engine reads into the per-node progress view. Pure. */
export function deriveNodeProgress(input: {
  nodes: readonly ResolvedNodeRef[];
  elements: readonly ElementInstanceFact[];
  variables: readonly VariableFact[];
  userTasks: readonly UserTaskFact[];
  incidents: readonly IncidentFact[];
  processInstanceKey: string;
  pollEveryByNode?: Readonly<Record<string, string>>;
  /** The run's process instance ended (COMPLETED/TERMINATED): unreached nodes are `skipped`, not `pending`. */
  instanceEnded?: boolean;
}): DeliveryNodeProgress[] {
  const nodeElements = new Set(input.nodes.map((n) => n.element));
  // A truncated row is only a clipped preview: parsing it would surface malformed/partial progress, so it
  // is treated exactly like an absent variable (fail closed to "unknown") everywhere below.
  const variables = input.variables.filter((v) => v.isTruncated !== true);
  const rootVars = new Map<string, string>();
  for (const v of variables) if (v.scopeKey === input.processInstanceKey) rootVars.set(v.name, v.value);
  const varsByScope = new Map<string, Map<string, string>>();
  for (const v of variables) {
    const m = varsByScope.get(v.scopeKey) ?? new Map<string, string>();
    m.set(v.name, v.value);
    varsByScope.set(v.scopeKey, m);
  }

  return input.nodes.map((node) => {
    const own = input.elements.filter((e) => owningNodeElement(e.elementId, nodeElements) === node.element);
    const body = own.filter((e) => e.elementId === node.element);
    const activeElements = [...new Set(own.filter((e) => e.state === "ACTIVE" && e.elementId !== node.element).map((e) => e.elementId))].sort();

    const escTask = input.userTasks.find((t) => t.elementId !== undefined && owningNodeElement(t.elementId, nodeElements) === node.element);
    let escalation: DeliveryNodeEscalation | null = null;
    if (escTask?.elementId) {
      // `…__esc` (service-node twin) and `…__esc__wait` (a wait gate's timeout twin) are both timeouts.
      const reason = escTask.elementId.endsWith("__esc") || escTask.elementId.endsWith("__esc__wait") ? "timeout" : escTask.elementId.endsWith("__contract") ? "contract" : "human";
      escalation = { userTaskKey: escTask.userTaskKey, elementId: escTask.elementId, reason };
    }
    const inc = input.incidents.find((i) => i.elementId !== undefined && owningNodeElement(i.elementId, nodeElements) === node.element);
    const incident: DeliveryNodeIncident | null = inc
      ? { incidentKey: inc.incidentKey, elementId: inc.elementId ?? null, errorType: inc.errorType ?? null, errorMessage: inc.errorMessage ?? null }
      : null;

    const boundFacts: Record<string, unknown> = {};
    for (const fact of node.emits) {
      const raw = rootVars.get(`${node.element}_${fact.name}`);
      if (raw === undefined) continue;
      const value = parseJson(raw);
      if (value !== null) Object.defineProperty(boundFacts, fact.name, { value, enumerable: true, writable: true, configurable: true });
    }

    let lastProbe: DeliveryNodeProbe | null = null;
    if (node.kind === "wait") {
      // Read the probe result (`ready`/`detail`/`observed`) only from a scope this node OWNS: a
      // probeLoop scope, then the node's own element scope. A run-ROOT `ready` carries no producer
      // provenance — it may be a previous (now completed) wait's result — so attributing it to this
      // node would be a guess; report null instead.
      const scopes: Map<string, string>[] = [];
      for (const id of [`${node.element}_probeLoop`, node.element]) {
        // The NEWEST scope wins (the most recent loop iteration) — chosen by element-instance key, which
        // the engine allocates monotonically, never by the engine's (unspecified) result order.
        let newest: { key: bigint; scope: Map<string, string> } | null = null;
        for (const e of own) {
          if (e.elementId !== id) continue;
          const scope = varsByScope.get(e.elementInstanceKey);
          const key = keyOrder(e.elementInstanceKey);
          if (scope?.has("ready") !== true || key === null) continue;
          if (newest === null || key > newest.key) newest = { key, scope };
        }
        if (newest) scopes.push(newest.scope);
      }
      const scope = scopes[0];
      if (scope !== undefined) {
        const ready = parseJson(scope.get("ready") ?? "null");
        const detail = parseJson(scope.get("detail") ?? "null");
        lastProbe = {
          ready: typeof ready === "boolean" ? ready : null,
          detail: typeof detail === "string" ? detail : detail === null ? null : JSON.stringify(detail),
          observed: scope.has("observed") ? parseJson(scope.get("observed") ?? "null") : null,
        };
      }
    }

    const childRunKeys: string[] = [];
    if (node.kind === "agent" || node.kind === "connector") {
      const candidates = [...Object.values(boundFacts)];
      for (const fact of ["pr", "prUrl"]) {
        const raw = rootVars.get(`${node.element}_${fact}`);
        if (raw !== undefined) candidates.push(parseJson(raw));
      }
      if (node.kind === "agent") {
        // Agent PR results are node-LOCAL (AGENT_RESULT_LOCAL_VARS): the root `<element>_pr` exists only for
        // a declared emit and only after the subProcess completes, so also read the node's own scopes —
        // covering a no-emits agent and an emitting agent still parked (e.g. in enrollment).
        for (const e of own) {
          const scope = varsByScope.get(e.elementInstanceKey);
          if (!scope) continue;
          for (const name of ["pr", "prUrl", "pullRequest"]) {
            const raw = scope.get(name);
            if (raw !== undefined) candidates.push(parseJson(raw));
          }
        }
      }
      if (node.kind === "connector") {
        // A converge connector with no declared emits enrolls the PR it resolves from its own task-local
        // `payload`/`boundFacts` inputs — derive the key through the SAME canonical resolver the worker uses.
        for (const e of own) {
          const scope = varsByScope.get(e.elementInstanceKey);
          const target = parseJson(scope?.get("target") ?? "null");
          if (!scope || typeof target !== "string" || !isConvergeTarget(target.trim())) continue;
          const payload = parseJson(scope.get("payload") ?? "null");
          const facts = parseJson(scope.get("boundFacts") ?? "null");
          const payloadPr = payload !== null && typeof payload === "object" ? Reflect.get(payload, "pr") : undefined;
          const bound: BoundFact[] = Array.isArray(facts) ? facts : [];
          candidates.push(resolveConvergePr(payloadPr, bound));
        }
      }
      for (const c of candidates) {
        const key = prKeyOf(c);
        if (key && !childRunKeys.includes(key)) childRunKeys.push(key);
      }
    }

    let state: DeliveryNodeState;
    if (incident) state = "failed";
    else if (escalation && escalation.reason !== "human") state = "escalated";
    else if (body.some((e) => e.state === "ACTIVE")) state = "active";
    else if (body.some((e) => e.state === "COMPLETED")) state = "satisfied";
    else if (body.some((e) => e.state === "TERMINATED")) state = "skipped";
    else state = input.instanceEnded ? "skipped" : "pending";

    return {
      id: node.id,
      kind: node.kind,
      element: node.element,
      state,
      dependsOn: [...node.dependsOn],
      activeElements: state === "active" || state === "escalated" || state === "failed" ? activeElements : [],
      boundFacts,
      lastProbe,
      pollEvery: node.kind === "wait" ? (input.pollEveryByNode && Object.hasOwn(input.pollEveryByNode, node.id) ? input.pollEveryByNode[node.id] : null) : null,
      childRunKeys,
      escalation,
      incident,
    };
  });
}

/** Render the graph's mermaid diagram annotated with per-node state classes. */
export function renderProgressMermaid(diagram: string, nodes: readonly DeliveryNodeProgress[]): string {
  const lines = [diagram.trimEnd()];
  lines.push(
    "  classDef pending fill:#eee,stroke:#999",
    "  classDef active fill:#cde4ff,stroke:#2563eb",
    "  classDef satisfied fill:#d1fadf,stroke:#16a34a",
    "  classDef escalated fill:#fff3c4,stroke:#d97706",
    "  classDef skipped fill:#f4f4f5,stroke:#a1a1aa,stroke-dasharray:4",
    "  classDef failed fill:#fee2e2,stroke:#dc2626",
  );
  for (const n of nodes) lines.push(`  class ${n.element} ${n.state}`);
  return `${lines.join("\n")}\n`;
}

/** The per-wait-node configured poll cadence, read from the run-root `nodeInputs` seed. */
function pollEveryFromSeed(raw: string | undefined, nodes: readonly ResolvedNodeRef[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  const seed = parseJson(raw);
  if (seed === null || typeof seed !== "object") return out;
  for (const n of nodes) {
    if (n.kind !== "wait") continue;
    const entry: unknown = Reflect.get(seed, n.element) ?? Reflect.get(seed, n.id);
    if (entry !== null && typeof entry === "object") {
      const every: unknown = Reflect.get(entry, "probePollEvery");
      if (typeof every === "string" && every !== "") Object.defineProperty(out, n.id, { value: every, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/** Load a run's per-node progress from the run row, its dispatched graph and engine truth. Null when no
 * run has that key. */
export async function loadDeliveryGraphProgress(
  app: Pick<AppApi, "data" | "engine">,
  runKey: string,
): Promise<DeliveryGraphRunProgress | null> {
  const run: DeliveryGraphRun | undefined = await deliveryGraphRuns(app.data).get(runKey);
  if (!run) return null;
  const base: DeliveryGraphRunProgress = {
    runKey: run.run_key,
    title: run.title,
    status: run.status,
    phase: run.phase,
    digest: run.digest,
    processInstanceKey: run.process_key,
    instanceState: null,
    nodes: [],
    mermaid: null,
    note: null,
    truncated: false,
  };
  const proposal = await deliveryGraphProposals(app.data).get(run.digest);
  if (!proposal) return { ...base, note: `the dispatched graph for digest ${run.digest} is no longer stored, so per-node progress cannot be derived` };
  // The stored graph passed `validateDeliveryGraph` at stage time, so it is a well-formed DeliveryGraph.
  const graph: DeliveryGraph = JSON.parse(proposal.graph);
  const compiled = await compileDeliveryGraphSemantic(graph);
  if (!compiled.ok) return { ...base, note: "the dispatched graph no longer compiles under this version, so per-node progress cannot be derived" };
  const nodes: ResolvedNodeRef[] = compiled.resolved.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    element: n.element,
    emits: (n.emits ?? []).map((e) => ({ name: e.name, type: e.type })),
    dependsOn: n.dependsOn ?? [],
  }));
  const pik = run.process_key;
  if (!pik) {
    const pending = deriveNodeProgress({ nodes, elements: [], variables: [], userTasks: [], incidents: [], processInstanceKey: "" });
    return { ...base, nodes: pending, mermaid: renderProgressMermaid(compiled.diagram, pending) };
  }
  const read = await readEngineFacts(app.engine, pik, nodes);
  const { instances, elements, variables, userTasks, incidents } = read;
  const instanceState = instances[0]?.state ?? null;
  const nodeInputsVar = variables.find((v) => v.scopeKey === pik && v.name === "nodeInputs");
  // A truncated seed is a clipped preview: leave cadences unknown rather than parse partial JSON.
  const nodeInputs = nodeInputsVar?.isTruncated ? undefined : nodeInputsVar?.value;
  const progress = deriveNodeProgress({
    nodes,
    elements,
    variables,
    userTasks,
    incidents,
    processInstanceKey: pik,
    pollEveryByNode: pollEveryFromSeed(nodeInputs, nodes),
    instanceEnded: instanceState !== null && instanceState !== "ACTIVE",
  });
  return { ...base, instanceState, nodes: progress, mermaid: renderProgressMermaid(compiled.diagram, progress), truncated: read.truncated };
}

/**
 * The page size the engine's search endpoints answer with when no page is requested. The urban
 * `EngineClient` sends no `page`/`searchAfter` and drops `page.totalItems`, so any single search returns
 * at most ONE page. Rather than treat a page as exhaustive, every read below is NARROWED (by element id,
 * variable name, scope or state) so that it stays far below a page in practice, and a read that comes
 * back with a full page is reported as possibly truncated (`truncated: true`) instead of silently
 * dropping facts.
 */
export const ENGINE_SEARCH_PAGE = 100;

/** Variable names read from node-owned (non-root) scopes: a wait's probe result, an agent's PR result,
 * a converge connector's task-local inputs. */
const SCOPED_VARIABLE_NAMES = ["ready", "detail", "observed", "pr", "prUrl", "pullRequest", "target", "payload", "boundFacts"] as const;

/** The engine reads {@link loadDeliveryGraphProgress} folds, gathered by narrow (page-bounded) queries. */
export async function readEngineFacts(
  engine: Pick<AppApi["engine"], "searchProcessInstances" | "searchElementInstances" | "searchVariables" | "searchUserTasks" | "searchIncidents" | "getElementInstance">,
  pik: string,
  nodes: readonly ResolvedNodeRef[],
): Promise<{
  instances: { state: string }[];
  elements: ElementInstanceFact[];
  variables: VariableFact[];
  userTasks: UserTaskFact[];
  incidents: IncidentFact[];
  truncated: boolean;
}> {
  let truncated = false;
  const page = <T>(rows: T[]): T[] => {
    if (rows.length >= ENGINE_SEARCH_PAGE) truncated = true;
    return rows;
  };
  // Root facts: one exact-name read per compiled `<element>_<fact>` (plus the PR fallbacks and the seed).
  const rootNames = new Set<string>(["nodeInputs"]);
  for (const n of nodes) {
    for (const f of n.emits) rootNames.add(`${n.element}_${f.name}`);
    if (n.kind === "agent" || n.kind === "connector") for (const f of ["pr", "prUrl"]) rootNames.add(`${n.element}_${f}`);
  }
  // Element instances: each node's body (one per node, bounded), every wait's probe-loop iterations, and
  // every ACTIVE element (bounded by the run's concurrency) for `activeElements`.
  const elementQueries: { processInstanceKey: string; elementId?: string; state?: "ACTIVE" }[] = [{ processInstanceKey: pik, state: "ACTIVE" }];
  for (const n of nodes) {
    elementQueries.push({ processInstanceKey: pik, elementId: n.element });
    if (n.kind === "wait") elementQueries.push({ processInstanceKey: pik, elementId: `${n.element}_probeLoop` });
  }
  const [instances, elementPages, rootPages, scopedPages, userTasks, incidents] = await Promise.all([
    engine.searchProcessInstances({ processInstanceKeys: [pik] }),
    Promise.all(elementQueries.map((q) => engine.searchElementInstances(q))),
    Promise.all([...rootNames].map((name) => engine.searchVariables({ processInstanceKey: pik, scopeKey: pik, name }))),
    Promise.all(SCOPED_VARIABLE_NAMES.map((name) => engine.searchVariables({ processInstanceKey: pik, name }))),
    engine.searchUserTasks({ processInstanceKey: pik, state: "CREATED" }),
    engine.searchIncidents({ processInstanceKey: pik, state: "ACTIVE" }),
  ]);
  const elements = new Map<string, ElementInstanceFact>();
  for (const rows of elementPages) for (const e of page(rows)) elements.set(e.elementInstanceKey, e);
  const variables = new Map<string, VariableFact>();
  for (const rows of [...rootPages, ...scopedPages]) for (const v of page(rows)) variables.set(`${v.scopeKey}\u0000${v.name}`, v);
  // A node-local variable's scope may be an inner element no query above returned (e.g. a completed
  // agent task): resolve each unseen scope by key so its owning node is known.
  const unseen = [...new Set([...variables.values()].map((v) => v.scopeKey))].filter((k) => k !== pik && !elements.has(k));
  for (const e of await Promise.all(unseen.map((k) => engine.getElementInstance(k)))) if (e) elements.set(e.elementInstanceKey, e);
  return {
    instances,
    elements: [...elements.values()],
    variables: [...variables.values()],
    userTasks: page(userTasks),
    incidents: page(incidents),
    truncated,
  };
}
