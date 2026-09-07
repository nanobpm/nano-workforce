// The cockpit engine-native "agent history" view-model (ADR 0056, issue #745/#747, umbrella #746).
//
// A pure, deterministic projection of the engine AgentInstance / AgentHistory read model
// (`GET /agentic/agent-instances` + `…/{agentInstanceKey}/history`, served from
// `@nanobpm/urban`'s EngineClient `searchAgentInstances` / `searchAgentInstanceHistory`) onto the
// shapes the cockpit's HISTORICAL (settled) transcript + metrics view renders. This is the CONSUMER
// half of the durable-agent-transcript work: settled history now derives from engine truth, keyed by
// AGENT-INSTANCE / PROCESS / ELEMENT-INSTANCE keys — never the slash-bearing `job:<jobKey>` relay
// stream id (so the #744 gateway-proxy bug class is moot for historical reads). The token-granular
// relay (`./transcript-view.ts`) stays the LIVE overlay only.
//
// Like its relay sibling `./transcript-view.ts` and `./supply-view.ts`, it is framework-free and
// side-effect-free: the same report always yields the same view, so it renders identically embedded
// (App View) and standalone, and is unit-testable on Node with no browser.

import type {
  AgentHistoryRecord,
  AgentHistory as AgentHistoryReport,
  AgentInstanceList as AgentInstanceListReport,
  AgentInstance as AgentInstanceReport,
} from "../../../nano-generated/api-io.d.ts";

export type { AgentHistoryReport, AgentInstanceListReport };

/** One agent-instance row in the renderable historical-sessions list. */
export interface AgentSessionView {
  /** The engine-unique agent-instance key — the identity the history read is keyed on. */
  readonly agentInstanceKey: string;
  /** A single stable human label for the run's process / element (falls back to the instance key). */
  readonly label: string;
  /** The engine lifecycle status (a bare string, e.g. COMPLETED / THINKING / IDLE). */
  readonly status: string;
  /** The owning process-instance key. */
  readonly processInstanceKey: string;
  /** The BPMN element id (AI-agent task) that owns the instance, when reported. */
  readonly elementId?: string;
  /** A compact human token/call rollup (e.g. "1.2k in · 340 out · 3 calls · 5 tools"), when metrics exist. */
  readonly metrics?: string;
  /** When the run was captured — completionDate when sealed, else lastUpdatedDate, else creationDate. */
  readonly capturedAt?: string;
}

/** The full renderable historical-sessions list view. */
export interface AgentSessionsView {
  readonly sessions: readonly AgentSessionView[];
  readonly count: number;
}

/** One tool call in a rendered turn. */
export interface AgentTurnToolCallView {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly elementId?: string;
}

/** One conversation turn in the renderable history. */
export interface AgentTurnView {
  readonly historyItemKey: string;
  readonly loopIteration: number;
  readonly role: AgentHistoryRecord["role"];
  /** The turn's text content blocks, joined newest-in-order (empty when the turn is non-textual). */
  readonly text: string;
  readonly toolCalls: readonly AgentTurnToolCallView[];
  /** A compact per-turn token/duration rollup, when metrics exist. */
  readonly metrics?: string;
}

/** The full renderable history for one agent instance: its rolled-up header + ordered turns. */
export interface AgentHistoryView {
  readonly agentInstanceKey: string;
  /** The owning instance summary row, when the engine still reports it. */
  readonly instance?: AgentSessionView;
  readonly turns: readonly AgentTurnView[];
  readonly count: number;
}

/** A single stable human label for an agent run's process / element (empty parts dropped). */
function instanceLabel(i: AgentInstanceReport): string {
  const parts: string[] = [];
  if (i.processDefinitionId !== undefined && i.processDefinitionId !== "") parts.push(i.processDefinitionId);
  if (i.elementId !== undefined && i.elementId !== "") parts.push(i.elementId);
  if (i.processInstanceKey !== "") parts.push(`inst ${i.processInstanceKey}`);
  if (parts.length > 0) return parts.join(" \u00b7 ");
  return i.agentInstanceKey;
}

/** Render a token count compactly (e.g. 1234 -> "1.2k"), stable and locale-free. */
function humanCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Render a duration (ms) compactly (e.g. "1.2s", "340ms"), or undefined when absent/zero. */
function humanMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function instanceMetrics(i: AgentInstanceReport): string | undefined {
  const m = i.metrics;
  if (m === undefined) return undefined;
  return `${humanCount(m.inputTokens)} in \u00b7 ${humanCount(m.outputTokens)} out \u00b7 ${m.modelCalls} calls \u00b7 ${m.toolCalls} tools`;
}

function turnMetrics(r: AgentHistoryRecord): string | undefined {
  const m = r.metrics;
  if (m === undefined) return undefined;
  const dur = humanMs(m.durationMs);
  const base = `${humanCount(m.inputTokens)} in \u00b7 ${humanCount(m.outputTokens)} out`;
  return dur !== undefined ? `${base} \u00b7 ${dur}` : base;
}

/** The textual content of a turn: TEXT blocks joined in order (non-textual/empty blocks dropped). */
function turnText(r: AgentHistoryRecord): string {
  const texts: string[] = [];
  for (const b of r.content) {
    if (b.contentType === "TEXT" && b.text !== undefined && b.text !== "") texts.push(b.text);
  }
  return texts.join("\n");
}

/** Project one engine {@link AgentInstanceReport} onto a renderable {@link AgentSessionView}. */
export function agentSessionView(i: AgentInstanceReport): AgentSessionView {
  const metrics = instanceMetrics(i);
  const capturedAt = i.completionDate ?? i.lastUpdatedDate ?? i.creationDate;
  return {
    agentInstanceKey: i.agentInstanceKey,
    label: instanceLabel(i),
    status: i.status,
    processInstanceKey: i.processInstanceKey,
    ...(i.elementId !== undefined && i.elementId !== "" ? { elementId: i.elementId } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(capturedAt !== undefined && capturedAt !== "" ? { capturedAt } : {}),
  };
}

/**
 * Derive the renderable historical-sessions list from the engine AgentInstance list report.
 *
 * Pure and total: re-sorts newest-captured-first (stable on the instance key) so the view is
 * diff-friendly regardless of the report's incoming order; no input mutates and no I/O happens.
 */
export function agentSessionsView(report: AgentInstanceListReport): AgentSessionsView {
  const sessions = report.instances
    .map(agentSessionView)
    .sort((a, b) => {
      const byTime = (b.capturedAt ?? "").localeCompare(a.capturedAt ?? "");
      return byTime !== 0 ? byTime : a.agentInstanceKey.localeCompare(b.agentInstanceKey);
    });
  return { sessions, count: sessions.length };
}

/** Project one engine {@link AgentHistoryRecord} onto a renderable {@link AgentTurnView}. */
export function agentTurnView(r: AgentHistoryRecord): AgentTurnView {
  const metrics = turnMetrics(r);
  return {
    historyItemKey: r.historyItemKey,
    loopIteration: r.loopIteration,
    role: r.role,
    text: turnText(r),
    toolCalls: r.toolCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      ...(c.elementId !== undefined && c.elementId !== "" ? { elementId: c.elementId } : {}),
    })),
    ...(metrics !== undefined ? { metrics } : {}),
  };
}

/**
 * Derive one agent instance's renderable history from the engine AgentHistory report. The transport
 * already orders records (loopIteration, then creation-ordered key); this projection preserves that
 * order. Pure and total; no I/O.
 */
export function agentHistoryView(report: AgentHistoryReport): AgentHistoryView {
  const turns = report.records.map(agentTurnView);
  return {
    agentInstanceKey: report.agentInstanceKey,
    ...(report.instance !== undefined ? { instance: agentSessionView(report.instance) } : {}),
    turns,
    count: turns.length,
  };
}
