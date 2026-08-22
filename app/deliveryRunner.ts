// nano-workforce — the delivery-graph RUNNER (ADR 0005 slice S4). The integration step that turns the
// PURE compiled preview (S1's `compileDeliveryGraph`) into a RUNNING, engine-native process: it deploys
// the compile-to-native one-shot definition and starts an instance, seeding each node's config so the
// inlined subProcess bodies (agent/wait/human/connector) delegate to their existing worker / user-task
// bodies. It builds NO execution machinery of its own (Decision 2 — the graph SCHEDULES; the engine
// runs it); its whole job is deploy + seed + start.
//
// Definition lifecycle (the ADR open question, resolved here): the deployed process id is
// CONTENT-ADDRESSED — `delivery-graph-<sha256(bpmn)[:12]>`. Identical graphs compile byte-identically
// (S1 determinism) → identical id → an idempotent redeploy (the engine versions the same id, never a
// duplicate definition per run); different graphs get different ids and never collide; and because the
// id ENCODES its content, a stale one-shot definition is GC-identifiable by a later sweeper (out of
// scope to implement the sweeper — the naming is what enables it). The base id the compiler emits
// (`DELIVERY_GRAPH_PROCESS_ID`) is the single substitution target, so the runner never hardcodes it.

import { createHash, randomUUID } from "node:crypto";
import type { EngineClient } from "@nanobpm/urban";
import type { DeliveryGraph, DeliveryNode } from "../nano-generated/api-io.d.ts";
import { assertNever, compileDeliveryGraph, DELIVERY_GRAPH_PROCESS_ID } from "./deliveryGraphCompiler.ts";
import { DEFAULT_EVERY_MS, msToIsoDuration, parseProbe, readinessPollEvery } from "./readiness.ts";

/** The content digest of a compiled graph — `sha256(bpmn)[:12]` — the single source of truth for the
 * content-addressed deploy id (`delivery-graph-<digest>`) AND the S5 dispatch door's approval token /
 * default idempotency key. Both the runner (deploy id) and `operations/startDeliveryGraph` (approval +
 * dedupe key) derive from THIS one function so the two can never drift on how a graph is addressed. */
export function deliveryGraphDigest(bpmn: string): string {
  return createHash("sha256").update(bpmn).digest("hex").slice(0, 12);
}

/** The bounded-timeout / SLA envelope every node inherits (Decision: bounded → escalate). ISO-8601
 * durations. Defaults are conservative; a caller (the S5 door) may tighten them per run. */
export interface DeliveryRunTimeouts {
  /** `agent`/`connector` service-node bounded timeout before it escalates onto a human-completable task. */
  nodeTimeout?: string;
  /** `wait` gate poll budget before it escalates (the engine bound; the probe itself is read-only). */
  probeTimeout?: string;
  /** `human` node SLA before it records an `escalated` outcome and settles. */
  escalationSlaTimeout?: string;
  /** `wait` gate retry cadence owned by the engine. */
  probePollEvery?: string;
  /** Optional explicit assignee for `human` nodes + escalation tasks (else candidate-group routed). */
  escalationAssignee?: string | null;
}

export interface DeliveryRunOptions extends DeliveryRunTimeouts {
  /** A per-run token that scopes each `wait` node's gate key (`<runKey>:<element>`) so two concurrent
   * runs of the same graph never share a gate correlation. Defaults to a fresh random per-run token
   * (`randomUUID()`) — NOT the graph digest, which every run of an identical graph would share and so
   * cross-correlate. Pass an explicit `runKey` only when you need a reproducible/externally-owned gate
   * scope. */
  runKey?: string;
}

const DEFAULTS: Required<Omit<DeliveryRunTimeouts, "escalationAssignee">> = {
  nodeTimeout: "PT30M",
  probeTimeout: "PT30M",
  probePollEvery: msToIsoDuration(DEFAULT_EVERY_MS),
  escalationSlaTimeout: "P1D",
};

/** The per-node config the compiled subProcess ioMappings read from `nodeInputs.<element>`. A closed
 * union mirrored by the compiler's `ioMappingLines` — the two must agree on field names (a drift here
 * silently seeds `null` into a node body), so both derive from the same node kinds. */
type NodeInput =
  | { jobType: string; appendPrompt: string; timeout: string }
  | { gateKey: string; probe: unknown; probeTimeout: string; probePollEvery: string }
  | { escalationSlaTimeout: string; escalationAssignee: string | null }
  | { target: string; dedupeKey: string | null; payload: Record<string, unknown> | null; timeout: string };

/** The result of compiling + preparing a graph for deployment: the content-addressed process id, the
 * deployable BPMN (base id rewritten), and the seeded `nodeInputs` map — everything `runDeliveryGraph`
 * needs, exposed separately so a caller can deploy/inspect without starting an instance. */
export interface PreparedDeliveryGraph {
  processDefinitionId: string;
  bpmn: string;
  nodeInputs: Record<string, NodeInput>;
}

export type PrepareDeliveryResult =
  | { ok: true; prepared: PreparedDeliveryGraph }
  | { ok: false; errors: { path: string; message: string }[] };

/** A live delivery-graph run: the deployed definition + the started instance + the seed it ran with. */
export interface DeliveryRunHandle extends PreparedDeliveryGraph {
  processInstanceKey: string;
}

export type RunDeliveryResult =
  | { ok: true; handle: DeliveryRunHandle }
  | { ok: false; errors: { path: string; message: string }[] };

/** Compile a graph and prepare it for deployment WITHOUT touching the engine: content-address its id,
 * rewrite the base process id, and build the `nodeInputs` seed. The deployable DEFINITION (the
 * content-addressed `processDefinitionId` and the `bpmn`) is deterministic — the same graph yields the
 * same id, which is what makes redeploy idempotent — because the gate scope lives in `nodeInputs`
 * (runtime instance variables), not in the BPMN. The default `runKey` is a fresh random per-run token,
 * so each call's `wait` `gateKey`s differ (two concurrent runs of the same graph never cross-correlate);
 * pass an explicit `runKey` for a reproducible seed. Returns the S1 compile errors verbatim for a
 * malformed graph. */
export async function prepareDeliveryGraph(
  graph: DeliveryGraph,
  options: DeliveryRunOptions = {},
): Promise<PrepareDeliveryResult> {
  const compiled = await compileDeliveryGraph(graph);
  if (!compiled.ok) return { ok: false, errors: compiled.errors };

  const digest = deliveryGraphDigest(compiled.bpmn);
  const processDefinitionId = `${DELIVERY_GRAPH_PROCESS_ID}-${digest}`;
  const bpmn = rewriteProcessId(compiled.bpmn, processDefinitionId);

  const runKey = options.runKey?.trim() || randomUUID();
  const timeouts = {
    nodeTimeout: options.nodeTimeout ?? DEFAULTS.nodeTimeout,
    probeTimeout: options.probeTimeout ?? DEFAULTS.probeTimeout,
    probePollEvery: options.probePollEvery ?? DEFAULTS.probePollEvery,
    escalationSlaTimeout: options.escalationSlaTimeout ?? DEFAULTS.escalationSlaTimeout,
    escalationAssignee: options.escalationAssignee ?? null,
  };
  const elementByNodeId = new Map(compiled.resolved.nodes.map((n) => [n.id, n.element]));
  const nodeInputs: Record<string, NodeInput> = {};
  for (const node of graph.nodes) {
    const element = elementByNodeId.get(node.id);
    if (element === undefined) continue; // unreachable — resolved covers every node — but keep total.
    nodeInputs[element] = buildNodeInput(node, { runKey, element, ...timeouts });
  }
  return { ok: true, prepared: { processDefinitionId, bpmn, nodeInputs } };
}

/** Deploy + start a compiled graph as a running engine-native instance. Idempotent at the DEFINITION
 * level (content-addressed id — redeploying the same graph re-uses the definition); each call still
 * starts a fresh INSTANCE (a distinct run of that definition). Returns the run handle, or the compile
 * errors for a malformed graph (the engine is never touched in that case). */
export async function runDeliveryGraph(
  engine: Pick<EngineClient, "deployResources" | "createInstance">,
  graph: DeliveryGraph,
  options: DeliveryRunOptions = {},
): Promise<RunDeliveryResult> {
  const prep = await prepareDeliveryGraph(graph, options);
  if (!prep.ok) return prep;
  const { processDefinitionId, bpmn, nodeInputs } = prep.prepared;

  await engine.deployResources([{ name: `${processDefinitionId}.bpmn`, content: bpmn, contentType: "application/xml" }]);
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId,
    variables: { nodeInputs },
  });
  // The engine can yield a numeric key; `DeliveryRunHandle.processInstanceKey` is typed `string` and
  // downstream consumers expect a string — coerce (codebase-wide `String(...)` pattern, e.g. app/plan.ts).
  return {
    ok: true,
    handle: { processDefinitionId, bpmn, nodeInputs, processInstanceKey: String(processInstanceKey) },
  };
}

/** Rewrite the compiled BPMN's base `bpmn:process` id to the content-addressed deploy id. The base id
 * appears exactly once as the process element's `id` attribute (element ids are `n<i>`/`gw*`/`Start`/
 * `End`, never the process id), and once more as the top-level `bpmndi:BPMNPlane`'s `bpmnElement`
 * reference back to that process (the diagram interchange the compiler now attaches, #440). Both must
 * move together, otherwise the deployed definition carries a DANGLING plane reference and renders
 * positionless — the very bug DI was added to fix. Nested sub-process planes reference `n<i>` element
 * ids, which are untouched. */
function rewriteProcessId(bpmn: string, processDefinitionId: string): string {
  return bpmn
    .replace(`id="${DELIVERY_GRAPH_PROCESS_ID}"`, `id="${processDefinitionId}"`)
    .replace(`bpmnElement="${DELIVERY_GRAPH_PROCESS_ID}"`, `bpmnElement="${processDefinitionId}"`);
}

/** Build the `nodeInputs.<element>` seed for one node, per its kind — the exact fields the compiled
 * subProcess ioMapping pulls. Total over the closed kind set. */
function buildNodeInput(
  node: DeliveryNode,
  ctx: { runKey: string; element: string; nodeTimeout: string; probeTimeout: string; probePollEvery: string; escalationSlaTimeout: string; escalationAssignee: string | null },
): NodeInput {
  switch (node.kind) {
    case "agent":
      return { jobType: node.agent.jobType, appendPrompt: node.agent.prompt ?? "", timeout: ctx.nodeTimeout };
    case "wait": {
      const probe = parseProbe(node.wait);
      return {
        gateKey: `${ctx.runKey}:${ctx.element}`,
        probe: node.wait,
        probeTimeout: ctx.probeTimeout,
        probePollEvery: probe.poll?.everyMs ? readinessPollEvery(probe, {}) : ctx.probePollEvery,
      };
    }
    case "human":
      return { escalationSlaTimeout: ctx.escalationSlaTimeout, escalationAssignee: ctx.escalationAssignee };
    case "connector":
      return {
        target: node.connector.target,
        dedupeKey: node.connector.dedupeKey ?? null,
        payload: node.connector.payload ?? null,
        timeout: ctx.nodeTimeout,
      };
    default:
      return assertNever(node, "buildNodeInput");
  }
}
