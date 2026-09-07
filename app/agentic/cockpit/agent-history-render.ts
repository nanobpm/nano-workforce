// The cockpit engine-native "agent history" DOM renderer (ADR 0056, issue #745/#747, umbrella #746).
//
// Renders an {@link AgentSessionsView} (the settled agent-run list, sourced from engine
// `searchAgentInstances`) and a selected instance's {@link AgentHistoryView} (its ordered conversation
// turns + per-turn / instance metrics, sourced from engine `searchAgentInstanceHistory`) into host
// elements. This is the CONSUMER render surface of the durable-agent-transcript work: the HISTORICAL
// transcript is a STRUCTURED conversation (roles / text / tool calls / metrics) read from engine truth,
// keyed by `agentInstanceKey` — NOT the ANSI terminal replay of a relay stream (`./transcript-render.ts`),
// which stays the LIVE overlay only.
//
// Like the relay renderer it builds against the structural {@link ElementLike} / {@link DocumentLike}
// subset (reused from the package) rather than the global `document`, so the real DOM satisfies it at
// runtime AND a plain in-memory fake satisfies it for DOM-free Node tests. It draws only the volatile
// history; the host region is owned by the boot layer.
import type { DocumentLike, ElementLike } from "@nanobpm/agentic/cockpit";
import type { AgentHistoryView, AgentSessionsView, AgentSessionView, AgentTurnView } from "./agent-history-view.ts";

export interface RenderAgentSessionsOptions {
  /** Called with an instance's key when the operator selects it to view its history. */
  readonly onSelect?: (agentInstanceKey: string) => void;
  /** The instance currently being viewed, if any — highlighted in the list. */
  readonly activeInstanceKey?: string;
  /** Panel title. Defaults to the historical-sessions label. */
  readonly title?: string;
  /** Empty-state copy. */
  readonly emptyText?: string;
}

export interface AgentSessionsDom {
  readonly root: ElementLike;
}

export interface AgentHistoryDom {
  readonly root: ElementLike;
}

function el(doc: DocumentLike, tag: string, className?: string, text?: string): ElementLike {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sessionRow(doc: DocumentLike, s: AgentSessionView, options: RenderAgentSessionsOptions): ElementLike {
  const row = el(doc, "tr", "cockpit-agent-session");
  row.setAttribute("data-agent-instance-key", s.agentInstanceKey);
  row.setAttribute("data-status", s.status);
  if (options.activeInstanceKey === s.agentInstanceKey) row.setAttribute("data-active", "true");

  const nameCell = el(doc, "td", "cockpit-td cockpit-agent-name");
  const button = el(doc, "button", "cockpit-agent-select", s.label);
  button.setAttribute("type", "button");
  button.setAttribute("data-agent-instance-key", s.agentInstanceKey);
  const onSelect = options.onSelect;
  if (onSelect !== undefined) button.addEventListener("click", () => onSelect(s.agentInstanceKey));
  nameCell.appendChild(button);
  row.appendChild(nameCell);

  row.appendChild(el(doc, "td", "cockpit-td cockpit-agent-status", s.status));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-agent-metrics", s.metrics ?? ""));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-agent-captured", s.capturedAt ?? ""));
  return row;
}

/**
 * Render the historical agent-sessions list `view` into `host`, replacing whatever was there.
 * Idempotent: call again on every refresh to reflect the latest engine snapshot.
 */
export function renderAgentSessions(
  host: ElementLike,
  doc: DocumentLike,
  view: AgentSessionsView,
  options: RenderAgentSessionsOptions = {},
): AgentSessionsDom {
  host.replaceChildren();
  const root = el(doc, "div", "cockpit-agent-history");
  root.setAttribute("data-session-count", String(view.count));

  const header = el(doc, "header", "cockpit-agent-header");
  header.appendChild(el(doc, "h2", "cockpit-agent-title", options.title ?? "Agent history"));
  const summary = el(doc, "span", "cockpit-agent-summary", String(view.count));
  summary.setAttribute("data-summary", "agent-history");
  header.appendChild(summary);
  root.appendChild(header);

  if (view.count === 0) {
    const empty = el(doc, "div", "cockpit-agent-empty", options.emptyText ?? "No agent runs recorded yet.");
    empty.setAttribute("data-empty", "true");
    root.appendChild(empty);
    host.appendChild(root);
    return { root };
  }

  const table = el(doc, "table", "cockpit-agent-table");
  const thead = el(doc, "thead", "cockpit-agent-thead");
  const head = el(doc, "tr", "cockpit-agent-head");
  for (const label of ["run", "status", "metrics", "captured"]) head.appendChild(el(doc, "th", "cockpit-th", label));
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el(doc, "tbody", "cockpit-agent-tbody");
  for (const s of view.sessions) tbody.appendChild(sessionRow(doc, s, options));
  table.appendChild(tbody);
  root.appendChild(table);

  host.appendChild(root);
  return { root };
}

function turnBlock(doc: DocumentLike, t: AgentTurnView): ElementLike {
  const block = el(doc, "div", "cockpit-agent-turn");
  block.setAttribute("data-history-item-key", t.historyItemKey);
  block.setAttribute("data-role", t.role);
  block.setAttribute("data-loop-iteration", String(t.loopIteration));

  const meta = el(doc, "div", "cockpit-agent-turn-meta");
  meta.appendChild(el(doc, "span", "cockpit-agent-turn-role", t.role));
  meta.appendChild(el(doc, "span", "cockpit-agent-turn-iter", `#${t.loopIteration}`));
  if (t.metrics !== undefined) meta.appendChild(el(doc, "span", "cockpit-agent-turn-metrics", t.metrics));
  block.appendChild(meta);

  if (t.text !== "") block.appendChild(el(doc, "pre", "cockpit-agent-turn-text", t.text));

  if (t.toolCalls.length > 0) {
    const tools = el(doc, "ul", "cockpit-agent-turn-tools");
    for (const call of t.toolCalls) {
      const li = el(doc, "li", "cockpit-agent-turn-tool", call.elementId !== undefined ? `${call.toolName} (${call.elementId})` : call.toolName);
      li.setAttribute("data-tool-call-id", call.toolCallId);
      tools.appendChild(li);
    }
    block.appendChild(tools);
  }
  return block;
}

/**
 * Render one instance's conversation history `view` into `host`, replacing whatever was there.
 * Idempotent. A null/empty history renders an explicit empty state (read-as-absence).
 */
export function renderAgentHistory(host: ElementLike, doc: DocumentLike, view: AgentHistoryView): AgentHistoryDom {
  host.replaceChildren();
  const root = el(doc, "div", "cockpit-agent-transcript");
  root.setAttribute("data-agent-instance-key", view.agentInstanceKey);
  root.setAttribute("data-turn-count", String(view.count));

  const header = el(doc, "header", "cockpit-agent-transcript-header");
  header.appendChild(el(doc, "h3", "cockpit-agent-transcript-title", view.instance?.label ?? view.agentInstanceKey));
  if (view.instance?.metrics !== undefined) {
    const m = el(doc, "span", "cockpit-agent-transcript-metrics", view.instance.metrics);
    m.setAttribute("data-summary", "agent-instance-metrics");
    header.appendChild(m);
  }
  root.appendChild(header);

  if (view.count === 0) {
    const empty = el(doc, "div", "cockpit-agent-transcript-empty", "No history for this run.");
    empty.setAttribute("data-empty", "true");
    root.appendChild(empty);
    host.appendChild(root);
    return { root };
  }

  const turns = el(doc, "div", "cockpit-agent-turns");
  for (const t of view.turns) turns.appendChild(turnBlock(doc, t));
  root.appendChild(turns);

  host.appendChild(root);
  return { root };
}
