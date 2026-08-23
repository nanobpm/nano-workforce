// The cockpit "past sessions" DOM renderer + static-replay helper (ADR 0056, H3 read path / #222).
//
// Renders a {@link TranscriptsView} into a host element: the captured-session history list the cockpit
// shows BESIDE the live supply list. Clicking a session calls {@link RenderTranscriptsOptions.onReplay}
// with that session's relay stream id, which the boot layer turns into a STATIC playback in the same
// persistent terminal region a live drill-in uses — clearly distinguished as "replayed" (a closed
// stream) vs "live". Like the supply renderer it draws only the *volatile* history list; the terminal
// itself is owned by the boot layer's persistent region.
//
// It builds against the structural {@link ElementLike} / {@link DocumentLike} subset (reused from the
// package) rather than the global `document`, so the real DOM satisfies it at runtime AND a plain
// in-memory fake satisfies it for DOM-free Node tests.
//
// The static-replay helper ({@link replayTranscript}) drives a `@nanobpm/agentic/cockpit`
// {@link TerminalSession} from a fetched transcript page: it feeds the stored chunks through the SAME
// resume-from-offset renderer a LIVE stream uses, so a closed session replays faithfully with no live
// worker and no relay connection.
import type { DocumentLike, ElementLike, TerminalSession } from "@nanobpm/agentic/cockpit";
import type { TranscriptsView, TranscriptView } from "./transcript-view.ts";

export interface RenderTranscriptsOptions {
  /** Called with a session's relay stream id when the operator selects it to replay. */
  readonly onReplay?: (stream: string) => void;
  /** The stream currently being replayed, if any — highlighted in the list. */
  readonly activeStream?: string;
  /** Panel title. Defaults to the global cockpit history label. */
  readonly title?: string;
  /** Empty-state copy. Defaults to the global cockpit history copy. */
  readonly emptyText?: string;
}

/** Handles into the rendered tree the caller may need. */
export interface TranscriptsDom {
  readonly root: ElementLike;
}

function el(doc: DocumentLike, tag: string, className?: string, text?: string): ElementLike {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sessionRow(doc: DocumentLike, session: TranscriptView, options: RenderTranscriptsOptions): ElementLike {
  const row = el(doc, "tr", "cockpit-past-session");
  row.setAttribute("data-stream", session.stream);
  row.setAttribute("data-status", session.status);
  if (session.jobKey !== undefined) row.setAttribute("data-job-key", session.jobKey);
  if (options.activeStream === session.stream) row.setAttribute("data-active", "true");

  const nameCell = el(doc, "td", "cockpit-td cockpit-past-name");
  const button = el(doc, "button", "cockpit-past-replay", session.label);
  button.setAttribute("type", "button");
  button.setAttribute("data-stream", session.stream);
  const onReplay = options.onReplay;
  if (onReplay !== undefined) button.addEventListener("click", () => onReplay(session.stream));
  nameCell.appendChild(button);
  row.appendChild(nameCell);

  row.appendChild(el(doc, "td", "cockpit-td cockpit-past-status", session.status));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-past-size", session.size));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-past-captured", session.capturedAt));
  return row;
}

/**
 * Render `view` into `host`, replacing whatever was there. Idempotent: call it again on every refresh
 * to reflect the latest captured-session snapshot.
 */
export function renderTranscripts(
  host: ElementLike,
  doc: DocumentLike,
  view: TranscriptsView,
  options: RenderTranscriptsOptions = {},
): TranscriptsDom {
  host.replaceChildren();
  const root = el(doc, "div", "cockpit-past");
  root.setAttribute("data-session-count", String(view.count));

  const header = el(doc, "header", "cockpit-past-header");
  header.appendChild(el(doc, "h2", "cockpit-past-title", options.title ?? "Past sessions"));
  const summary = el(doc, "span", "cockpit-past-summary", view.retention !== undefined ? `${view.count} · kept ${view.retention}` : `${view.count}`);
  summary.setAttribute("data-summary", "past");
  header.appendChild(summary);
  root.appendChild(header);

  if (view.count === 0) {
    const empty = el(doc, "div", "cockpit-past-empty", options.emptyText ?? "No captured sessions yet.");
    empty.setAttribute("data-empty", "true");
    root.appendChild(empty);
    host.appendChild(root);
    return { root };
  }

  const table = el(doc, "table", "cockpit-past-table");
  const thead = el(doc, "thead", "cockpit-past-thead");
  const head = el(doc, "tr", "cockpit-past-head");
  for (const label of ["session", "status", "size", "captured"]) head.appendChild(el(doc, "th", "cockpit-th", label));
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el(doc, "tbody", "cockpit-past-tbody");
  for (const session of view.sessions) tbody.appendChild(sessionRow(doc, session, options));
  table.appendChild(tbody);
  root.appendChild(table);

  host.appendChild(root);
  return { root };
}

/** One stored transcript chunk as the fetch endpoint returns it (mirrors `AgenticTranscriptChunk`). */
export interface TranscriptChunkReport {
  readonly offset: number;
  readonly chunk: string;
}

/** A stored transcript's bytes as `GET /agentic/transcripts/{stream}` returns them (mirrors `AgenticTranscriptData`). */
export interface TranscriptDataReport {
  readonly stream: string;
  readonly from: number;
  readonly gap: boolean;
  readonly nextOffset: number;
  readonly entries: readonly TranscriptChunkReport[];
}

/**
 * Statically replay a fetched transcript into a {@link TerminalSession}: feed the stored chunks through
 * the SAME resume-from-offset handler a live stream uses, so a closed session renders faithfully. The
 * session must be constructed with `from` equal to `data.from` (so it does not drop the leading chunks
 * as already-applied) and a no-op `send` (there is no live relay to talk to). Returns the count written.
 */
export function replayTranscript(session: TerminalSession, data: TranscriptDataReport): number {
  // The resume ack first (records any retention gap), then the stored chunks in offset order.
  session.handle({ op: "subscribed", stream: data.stream, gap: data.gap, nextOffset: data.nextOffset });
  let written = 0;
  for (const entry of data.entries) {
    session.handle({ stream: data.stream, offset: entry.offset, chunk: entry.chunk });
    written++;
  }
  return written;
}
