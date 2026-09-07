// nano-workforce — the engine-native AgentInstance/AgentHistory READ path (issue #745 / #747,
// umbrella #746). The CONSUMER half of the durable-agent-transcript work.
//
// The write path is engine-native: the worker harness (jwulf/c8ctl-plugin-nano#195) mints
// Create/Update/Complete AgentInstance/AgentHistory records against the engine for every element that
// carries the `<zeebe:agentDefinition agentType="external"/>` marker (the PRODUCER half, landed in
// #748). This module is the READ counterpart: it projects the engine's durable AgentInstance +
// AgentHistory read model onto the wire shapes the Cockpit "historical" transcript + per-turn metrics
// view renders — keyed by AGENT-INSTANCE / PROCESS-INSTANCE / ELEMENT-INSTANCE keys, never the
// slash-bearing `job:<jobKey>` relay stream id (so the #744 gateway-proxy bug class is moot for
// settled history; live tail stays on the relay overlay).
//
// The engine reach is the SINGLE engine-read seam — `@nanobpm/urban`'s `EngineClient`
// (`searchAgentInstances` / `searchAgentInstanceHistory` / `getAgentInstance`, added in urban 0.93 /
// nanobpm/nano-ide#563). No second broker-REST client, no `orchestration-cluster-api-js` fork: option
// (a) from the escalation, so the read path is exercised by the testkit WASM double
// (`@nanobpm/urban-testkit` ≥ 1.4 records none — read-as-absence — while a live engine validates the
// behavioural parity).
//
// Invariant fit (ADR 0056): this is an ADVISORY, READ-ONLY engine query. It observes the engine read
// model to render a visibility view; it NEVER activates/completes a job, publishes a message, or gates
// a BPMN sequence flow. It is deliberately expressed against a NARROW reader shape (not the whole
// `EngineClient`) so the callers that drive it stay structurally decoupled from the engine — the same
// discipline as `./element-instance.ts`.
//
// Pure and side-effect-free apart from the injected reader: unit-testable on Node with a fake reader.

import type {
  AgentHistoryFilter,
  AgentHistoryRecord,
  AgentInstanceFilter,
  AgentInstanceSummary,
} from "@nanobpm/urban";
import type {
  AgentHistory as WireAgentHistory,
  AgentHistoryRecord as WireAgentHistoryRecord,
  AgentInstance as WireAgentInstance,
  AgentInstanceList as WireAgentInstanceList,
} from "../../nano-generated/api-io.d.ts";

/**
 * The narrow slice of the engine read model the historical-transcript consumer needs: the three
 * engine-native agent read methods. `@nanobpm/urban`'s `EngineClient` satisfies it structurally; a
 * test supplies a fake. Kept minimal (three methods, not the whole `EngineClient`) so a caller depends
 * on a capability, not the engine.
 */
export interface AgentHistoryReader {
  searchAgentInstances(filter?: AgentInstanceFilter): Promise<readonly AgentInstanceSummary[]>;
  searchAgentInstanceHistory(
    agentInstanceKey: string,
    filter?: AgentHistoryFilter,
  ): Promise<readonly AgentHistoryRecord[]>;
  getAgentInstance(agentInstanceKey: string): Promise<AgentInstanceSummary | null>;
}

/** The selectors {@link listAgentInstances} understands (all optional; an empty filter lists all). */
export interface AgentInstanceQuery {
  readonly processInstanceKey?: string;
  readonly rootProcessInstanceKey?: string;
  readonly status?: string;
  readonly elementId?: string;
}

/** The selectors {@link readAgentHistory} understands beyond the required `agentInstanceKey`. */
export interface AgentHistoryQuery {
  readonly role?: AgentHistoryRecord["role"];
  readonly loopIteration?: number;
  readonly elementInstanceKey?: string;
}

/** Drop an empty/blank string filter value (No Drift Surfaces — the presence rule the key selectors
 *  elsewhere in this seam use: an omitted/blank selector is not applied). */
function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** Project an engine {@link AgentInstanceSummary} onto the wire {@link WireAgentInstance}, dropping the
 *  optional fields the engine did not report (so the wire object is minimal and stable). */
export function toWireInstance(summary: AgentInstanceSummary): WireAgentInstance {
  const out: WireAgentInstance = {
    agentInstanceKey: summary.agentInstanceKey,
    status: summary.status,
    processInstanceKey: summary.processInstanceKey,
  };
  if (present(summary.elementId)) out.elementId = summary.elementId;
  if (summary.elementInstanceKeys !== undefined && summary.elementInstanceKeys.length > 0) {
    out.elementInstanceKeys = [...summary.elementInstanceKeys];
  }
  if (present(summary.rootProcessInstanceKey)) out.rootProcessInstanceKey = summary.rootProcessInstanceKey;
  if (present(summary.processDefinitionKey)) out.processDefinitionKey = summary.processDefinitionKey;
  if (present(summary.processDefinitionId)) out.processDefinitionId = summary.processDefinitionId;
  if (summary.metrics !== undefined) {
    out.metrics = {
      inputTokens: summary.metrics.inputTokens,
      outputTokens: summary.metrics.outputTokens,
      modelCalls: summary.metrics.modelCalls,
      toolCalls: summary.metrics.toolCalls,
    };
  }
  if (present(summary.creationDate)) out.creationDate = summary.creationDate;
  if (present(summary.lastUpdatedDate)) out.lastUpdatedDate = summary.lastUpdatedDate;
  if (present(summary.completionDate)) out.completionDate = summary.completionDate;
  return out;
}

/** Project one engine {@link AgentHistoryRecord} (turn) onto the wire {@link WireAgentHistoryRecord},
 *  preserving the Camunda `AgentHistoryRecordValue` conversation grammar (role, content blocks, tool
 *  calls, per-turn metrics) the transcript store already models — one shape, no drift. */
export function toWireRecord(record: AgentHistoryRecord): WireAgentHistoryRecord {
  const out: WireAgentHistoryRecord = {
    historyItemKey: record.historyItemKey,
    agentInstanceKey: record.agentInstanceKey,
    loopIteration: record.loopIteration,
    role: record.role,
    commitStatus: record.commitStatus,
    content: record.content.map((block) => {
      const b: WireAgentHistoryRecord["content"][number] = { contentType: block.contentType };
      if (block.text !== undefined) b.text = block.text;
      if (block.documentReference !== undefined) b.documentReference = block.documentReference;
      if (block.object !== undefined) b.object = block.object;
      return b;
    }),
    toolCalls: record.toolCalls.map((call) => {
      const c: WireAgentHistoryRecord["toolCalls"][number] = {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        arguments: { ...call.arguments },
      };
      if (present(call.elementId)) c.elementId = call.elementId;
      return c;
    }),
  };
  if (record.metrics !== undefined) {
    out.metrics = {
      inputTokens: record.metrics.inputTokens,
      outputTokens: record.metrics.outputTokens,
      reasoningTokenCount: record.metrics.reasoningTokenCount,
      cacheCreationTokenCount: record.metrics.cacheCreationTokenCount,
      cacheReadTokenCount: record.metrics.cacheReadTokenCount,
      durationMs: record.metrics.durationMs,
    };
  }
  if (present(record.elementInstanceKey)) out.elementInstanceKey = record.elementInstanceKey;
  if (present(record.jobKey)) out.jobKey = record.jobKey;
  if (present(record.producedAt)) out.producedAt = record.producedAt;
  return out;
}

/**
 * List the engine-native agent instances matching `query`, projected onto the wire list shape and
 * sorted newest-created-first (stable on `agentInstanceKey`). Only non-blank selectors are applied.
 * Read-as-absence: an engine with no AgentInstance channel (or no matching instance) yields an empty
 * list, never an error.
 */
export async function listAgentInstances(
  reader: AgentHistoryReader,
  query: AgentInstanceQuery = {},
): Promise<WireAgentInstanceList> {
  const filter: AgentInstanceFilter = {
    ...(present(query.processInstanceKey) ? { processInstanceKey: query.processInstanceKey } : {}),
    ...(present(query.rootProcessInstanceKey) ? { rootProcessInstanceKey: query.rootProcessInstanceKey } : {}),
    ...(present(query.status) ? { status: query.status } : {}),
    ...(present(query.elementId) ? { elementId: query.elementId } : {}),
  };
  const summaries = await reader.searchAgentInstances(filter);
  const instances = summaries.map(toWireInstance).sort((a, b) => {
    // Newest-created first; a missing creationDate sorts last (oldest), stable on the key.
    const byTime = (b.creationDate ?? "").localeCompare(a.creationDate ?? "");
    return byTime !== 0 ? byTime : a.agentInstanceKey.localeCompare(b.agentInstanceKey);
  });
  return { count: instances.length, generatedAt: new Date().toISOString(), instances };
}

/**
 * Read one agent instance's durable conversation history (turns + per-turn metrics) from the engine,
 * projected onto the wire shape and sorted in conversational order — by `loopIteration`, then by the
 * creation-ordered `historyItemKey` within an iteration. Enriched with the owning instance's summary
 * (its rolled-up metrics + lifecycle) when the engine still reports it. A blank key or an unknown
 * instance yields an empty history (read-as-absence), never an error.
 */
export async function readAgentHistory(
  reader: AgentHistoryReader,
  agentInstanceKey: string,
  query: AgentHistoryQuery = {},
): Promise<WireAgentHistory> {
  if (!present(agentInstanceKey)) {
    return { agentInstanceKey: "", count: 0, generatedAt: new Date().toISOString(), records: [] };
  }
  const filter: AgentHistoryFilter = {
    ...(query.role !== undefined ? { role: query.role } : {}),
    ...(query.loopIteration !== undefined ? { loopIteration: query.loopIteration } : {}),
    ...(present(query.elementInstanceKey) ? { elementInstanceKey: query.elementInstanceKey } : {}),
  };

  const [rawRecords, summary] = await Promise.all([
    reader.searchAgentInstanceHistory(agentInstanceKey, filter),
    reader.getAgentInstance(agentInstanceKey),
  ]);
  const records = rawRecords.map(toWireRecord).sort((a, b) => {
    if (a.loopIteration !== b.loopIteration) return a.loopIteration - b.loopIteration;
    return a.historyItemKey.localeCompare(b.historyItemKey);
  });
  const out: WireAgentHistory = {
    agentInstanceKey,
    count: records.length,
    generatedAt: new Date().toISOString(),
    records,
  };
  if (summary !== null) out.instance = toWireInstance(summary);
  return out;
}
