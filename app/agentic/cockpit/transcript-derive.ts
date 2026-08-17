// The cockpit STRUCTURED transcript view — derived from the one event fold (ADR 0056, #251).
//
// Beside the byte-level replay (`transcript-render.ts` feeds stored chunks through the live terminal
// renderer for pixel-faithful playback), the cockpit can also show a STRUCTURED view of a captured
// session: its derived message history, tool cards and per-turn boundaries. Per the issue's acceptance
// criterion, that structured view is a DERIVATION of the one typed event log — it re-parses nothing.
// It reads a fetched transcript page and folds it through the single {@link deriveViewFromChunks} entry
// point (which routes every chunk through the ONE parser, `parseTranscriptEvent`), so there is no
// second parser of the raw bytes. The drift-guard test enforces that this module never parses chunks
// itself.
//
// Framework-free and side-effect-free, like the sibling cockpit views: the same report always yields
// the same {@link DerivedView}, and the renderer draws into the injected {@link DocumentLike} subset so
// a real DOM satisfies it at runtime and an in-memory fake satisfies it for DOM-free Node tests.
import type { DocumentLike, ElementLike } from "@nanobpm/agentic/cockpit";
import { type DerivedView, deriveViewFromChunks } from "../transcript-events.ts";
import type { TranscriptDataReport } from "./transcript-render.ts";

/**
 * Derive the structured view of a fetched transcript page by folding its stored chunks through the ONE
 * event parser + fold. Pure: the cockpit reads THIS instead of re-parsing raw frame bytes.
 */
export function deriveTranscript(data: TranscriptDataReport): DerivedView {
  return deriveViewFromChunks(data.entries);
}

function el(doc: DocumentLike, tag: string, className?: string, text?: string): ElementLike {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Handles into the rendered structured tree the caller may need. */
export interface DerivedTranscriptDom {
  readonly root: ElementLike;
}

/**
 * Render the DERIVED structured view of a fetched transcript into `host`, replacing whatever was there.
 * Draws per-turn sections with their derived messages and tool cards, plus a raw-fidelity footer
 * (retained bytes/chunks) so the operator sees the byte-replay is preserved alongside the structure.
 * Idempotent — call again on each refresh. Everything it shows is a derivation of the one event log.
 */
export function renderDerivedTranscript(host: ElementLike, doc: DocumentLike, data: TranscriptDataReport): DerivedTranscriptDom {
  const view = deriveTranscript(data);
  host.replaceChildren();
  const root = el(doc, "div", "cockpit-transcript-derived");
  root.setAttribute("data-stream", data.stream);
  root.setAttribute("data-lifecycle", view.lifecycle);
  root.setAttribute("data-turn-count", String(view.turns.length));
  root.setAttribute("data-message-count", String(view.messages.length));
  root.setAttribute("data-tool-count", String(view.tools.length));

  if (view.turns.length === 0) {
    const empty = el(doc, "div", "cockpit-transcript-empty", "No structured events derived — raw replay only.");
    empty.setAttribute("data-empty", "true");
    root.appendChild(empty);
  }

  for (const turn of view.turns) {
    const section = el(doc, "section", "cockpit-transcript-turn");
    section.setAttribute("data-turn", String(turn.index));
    section.setAttribute("data-steps", String(turn.steps));
    section.appendChild(el(doc, "h3", "cockpit-transcript-turn-title", `Turn ${turn.index}`));
    for (const msg of turn.messages) {
      const row = el(doc, "div", "cockpit-transcript-message", msg.text);
      row.setAttribute("data-role", msg.role);
      row.setAttribute("data-offset", String(msg.offset));
      section.appendChild(row);
    }
    for (const tool of turn.tools) {
      const card = el(doc, "div", "cockpit-transcript-tool", tool.name);
      card.setAttribute("data-tool", tool.name);
      card.setAttribute("data-offset", String(tool.offset));
      card.setAttribute("data-status", tool.result === undefined ? "pending" : tool.result.ok ? "ok" : "error");
      section.appendChild(card);
    }
    root.appendChild(section);
  }

  const footer = el(doc, "footer", "cockpit-transcript-raw");
  footer.setAttribute("data-raw-bytes", String(view.rawByteLength));
  footer.setAttribute("data-raw-chunks", String(view.rawChunkCount));
  footer.textContent = `${view.rawChunkCount} raw chunk(s) · ${view.rawByteLength} B retained for replay`;
  root.appendChild(footer);

  host.appendChild(root);
  return { root };
}
