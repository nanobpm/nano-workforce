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

import { createHash } from "node:crypto";
import type { EngineClient } from "@nanobpm/urban";
import type { DeliveryGraph, DeliveryNode } from "../nano-generated/api-io.d.ts";
import { assertNever, compileDeliveryGraph, DELIVERY_GRAPH_PROCESS_ID } from "./deliveryGraphCompiler.ts";

/** The bounded-timeout / SLA envelope every node inherits (Decision: bounded → escalate). ISO-8601
 * durations. Defaults are conservative; a caller (the S5 door) may tighten them per run. */
export interface DeliveryRunTimeouts {
  /** `agent`/`connector` service-node bounded timeout before it escalates onto a human-completable task. */
  nodeTimeout?: string;
  /** `wait` gate poll budget before it escalates (the engine bound; the probe itself is read-only). */
  probeTimeout?: string;
  /** `human` node SLA before it records an `escalated` outcome and settles. */
  escalationSlaTimeout?: string;
  /** Optional explicit assignee for `human` nodes + escalation tasks (else candidate-group routed). */
  escalationAssignee?: string | null;
}

export interface DeliveryRunOptions extends DeliveryRunTimeouts {
  /** A per-run token that scopes each `wait` node's gate key (`<runKey>:<element>`) so two concurrent
   * runs of the same graph never share a gate correlation. Defaults to a random token. */
  runKey?: string;
}

const DEFAULTS: Required<Omit<DeliveryRunTimeouts, "escalationAssignee">> = {
  nodeTimeout: "PT30M",
  probeTimeout: "PT30M",
  escalationSlaTimeout: "P1D",
};

/** The per-node config the compiled subProcess ioMappings read from `nodeInputs.<element>`. A closed
 * union mirrored by the compiler's `ioMappingLines` — the two must agree on field names (a drift here
 * silently seeds `null` into a node body), so both derive from the same node kinds. */
type NodeInput =
  | { jobType: string; appendPrompt: string; timeout: string }
  | { gateKey: string; probe: unknown; probeTimeout: string }
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
 * rewrite the base process id, and build the `nodeInputs` seed. Pure and deterministic — the same graph
 * yields the same prepared definition (id included), which is what makes redeploy idempotent. Returns
 * the S1 compile errors verbatim for a malformed graph. */
export function prepareDeliveryGraph(graph: DeliveryGraph, options: DeliveryRunOptions = {}): PrepareDeliveryResult {
  const compiled = compileDeliveryGraph(graph);
  if (!compiled.ok) return { ok: false, errors: compiled.errors };

  const digest = createHash("sha256").update(compiled.bpmn).digest("hex").slice(0, 12);
  const processDefinitionId = `${DELIVERY_GRAPH_PROCESS_ID}-${digest}`;
  const bpmn = rewriteProcessId(compiled.bpmn, processDefinitionId);

  const runKey = options.runKey?.trim() || digest;
  const timeouts = {
    nodeTimeout: options.nodeTimeout ?? DEFAULTS.nodeTimeout,
    probeTimeout: options.probeTimeout ?? DEFAULTS.probeTimeout,
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
  const prep = prepareDeliveryGraph(graph, options);
  if (!prep.ok) return prep;
  const { processDefinitionId, bpmn, nodeInputs } = prep.prepared;

  await engine.deployResources([{ name: `${processDefinitionId}.bpmn`, content: bpmn, contentType: "application/xml" }]);
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId,
    variables: { nodeInputs },
  });
  return { ok: true, handle: { processDefinitionId, bpmn, nodeInputs, processInstanceKey } };
}

/** Rewrite the compiled BPMN's base `bpmn:process` id to the content-addressed deploy id. The base id
 * appears exactly once — as the process element's `id` attribute (element ids are `n<i>`/`gw*`/`Start`/
 * `End`, never the process id) — so a single targeted replacement is unambiguous. */
function rewriteProcessId(bpmn: string, processDefinitionId: string): string {
  return bpmn.replace(`id="${DELIVERY_GRAPH_PROCESS_ID}"`, `id="${processDefinitionId}"`);
}

/** Build the `nodeInputs.<element>` seed for one node, per its kind — the exact fields the compiled
 * subProcess ioMapping pulls. Total over the closed kind set. */
function buildNodeInput(
  node: DeliveryNode,
  ctx: { runKey: string; element: string; nodeTimeout: string; probeTimeout: string; escalationSlaTimeout: string; escalationAssignee: string | null },
): NodeInput {
  switch (node.kind) {
    case "agent":
      return { jobType: node.agent.jobType, appendPrompt: node.agent.prompt ?? "", timeout: ctx.nodeTimeout };
    case "wait":
      return { gateKey: `${ctx.runKey}:${ctx.element}`, probe: node.wait, probeTimeout: ctx.probeTimeout };
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
