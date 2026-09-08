// The cockpit STRUCTURED transcript view — derived from the one ORDERED DISPLAY projection (#566, #757).
//
// Beside the byte-level replay (`transcript-render.ts` feeds stored chunks through the live terminal
// renderer for pixel-faithful playback), the cockpit shows a STRUCTURED view of a captured session. That
// view is a DERIVATION of the one typed event log — it re-parses nothing. It folds the stored chunks
// through the single {@link parseTranscriptEvent} parser and the canonical ORDERED DISPLAY projection
// ({@link createDisplayProjection}, agentic #566): the projection coalesces transport-fragmented message
// deltas ("I", "not", "ice I am act", …) back into ONE growing block per logical message, and interleaves
// text blocks, tool cards and permission prompts in strict chronological (offset) order. So a split word
// reconstructs into exactly that word in one coherent block — never one bordered card per delta — and a
// tool call issued mid-message renders between the text before and after it (issue #757). The raw log,
// its offsets and byte-faithful replay are untouched; the drift-guard test enforces this module never
// parses chunks itself.
//
// INCREMENTAL, not rebuild-on-every-chunk. {@link createIncrementalTranscript} keeps the display
// projection and a `blockId → DOM node` map as mutable state, so a live delta updates the ONE active
// block's node in place (append a new node, or patch an existing one) instead of rebuilding the whole
// transcript tree. That is what lets the browser adapter (`pages/cockpit/mount.js`) preserve the
// operator's selection, expansion and scroll position and auto-follow only at the tail. {@link
// renderDerivedTranscript} is the pure batch convenience over the same fold — historical replay renders
// IDENTICALLY to the final live rendering because both drive the one incremental renderer.
//
// Framework-free and DOM-agnostic, like the sibling cockpit views: it draws into the injected {@link
// DocumentLike} subset so a real DOM satisfies it at runtime and an in-memory fake satisfies it for
// DOM-free Node tests.
import type { DocumentLike, ElementLike } from "@nanobpm/agentic/cockpit";
import { createDisplayProjection } from "../transcript-display.ts";
import {
  type DerivedPermission,
  type DerivedTool,
  type DerivedView,
  type DisplayBlock,
  type DisplayGapBlock,
  type DisplayProjection,
  type DisplayTextBlock,
  deriveViewFromChunks,
  optionKindAllows,
  parseTranscriptEvent,
  type StoredChunk,
  type TranscriptEvent,
  utf8ByteLength,
} from "../transcript-events.ts";
import type { TranscriptDataReport } from "./transcript-render.ts";

/**
 * Derive the structured (event-fold) view of a fetched transcript page — the flat message/tool/permission
 * history, per-turn structure and raw-byte accounting. This is the {@link DerivedView} fold, kept for the
 * raw-fidelity footer and summary counts; the ordered, human-facing block SEQUENCE is the separate
 * display projection {@link renderDerivedTranscript} draws. Pure: the cockpit reads THESE instead of
 * re-parsing raw frame bytes.
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
 * Options for {@link renderDerivedTranscript}. This is the SHARED SEAM the wave-2 escalation bridge
 * attaches its handler to: an escalate-policy permission prompt's Allow/Deny buttons invoke
 * {@link onPermissionResolve} on click (mirroring how `transcript-render.ts` wires `onReplay`). The
 * render itself only *invokes* the callback — the relay round-trip that actually releases the blocked
 * agent lives in the bridge, not here. Optional/defaulted so the 3-arg call sites keep working.
 */
export interface RenderDerivedTranscriptOptions {
  /**
   * Called when the operator picks an Allow/Deny option on a pending `escalate` permission prompt. The
   * resolution shape is the minimal `{ callId, optionId, allowed }` the bridge folds into a
   * `permission` RESOLUTION frame — `allowed` is derived from the chosen option's kind (allow-* ⇒ true,
   * reject-* ⇒ false). Yolo requests never prompt, so this never fires for a yolo policy.
   */
  readonly onPermissionResolve?: (resolution: { callId: string; optionId: string; allowed: boolean }) => void;
}

/** A single classified line of a rendered diff block. */
type DiffLineKind = "add" | "del" | "ctx";
interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}
interface DetectedDiff {
  readonly lines: readonly DiffLine[];
  /** Where the diff came from — so the raw `args`/`result` content isn't ALSO rendered redundantly. */
  readonly source: "args" | "result";
}

/** Render an arbitrary derived value (tool args/result) as displayable text without re-parsing the log. */
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/** Read the first string-valued field among `keys` off an object, without an `as` cast. */
function pickString(obj: object, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = Reflect.get(obj, key);
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Classify one line of a unified diff (file/hunk headers are context, not add/del). */
function classifyUnifiedLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")) return "ctx";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** Heuristic: does this string look like a unified diff (a hunk header, or paired +/- content lines)? */
function looksLikeUnifiedDiff(text: string): boolean {
  if (text.length === 0) return false;
  let add = false;
  let del = false;
  let hunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("diff --git")) hunk = true;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) add = true;
    else if (line.startsWith("-")) del = true;
  }
  return hunk || (add && del);
}

/** Split a unified-diff string into classified lines (dropping a single trailing empty line). */
function parseUnifiedDiff(text: string): DiffLine[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => ({ kind: classifyUnifiedLine(line), text: line }));
}

/** Split a block of text into lines, dropping a single trailing empty segment (text ending in "\n"). */
function splitTextLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Synthesize a diff from structured edit args (`{ path?, oldText/old_string, newText/new_string }`). */
function structuredDiff(args: unknown): DiffLine[] | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const oldText = pickString(args, ["oldText", "old_string", "oldStr", "old", "before"]);
  const newText = pickString(args, ["newText", "new_string", "newStr", "new", "after"]);
  if (oldText === undefined && newText === undefined) return undefined;
  const lines: DiffLine[] = [];
  const path = pickString(args, ["path", "file", "filePath", "fileName"]);
  if (path !== undefined) lines.push({ kind: "ctx", text: `diff --git a/${path} b/${path}` });
  if (oldText !== undefined && oldText.length > 0) {
    for (const line of splitTextLines(oldText)) lines.push({ kind: "del", text: `-${line}` });
  }
  if (newText !== undefined && newText.length > 0) {
    for (const line of splitTextLines(newText)) lines.push({ kind: "add", text: `+${line}` });
  }
  return lines.length > 0 ? lines : undefined;
}

/** Detect diff-shaped content on a tool call/result — a unified-diff string or structured edit args. */
function detectDiff(tool: DerivedTool): DetectedDiff | undefined {
  const content = tool.result?.content;
  if (typeof content === "string" && looksLikeUnifiedDiff(content)) {
    return { lines: parseUnifiedDiff(content), source: "result" };
  }
  if (typeof tool.args === "string" && looksLikeUnifiedDiff(tool.args)) {
    return { lines: parseUnifiedDiff(tool.args), source: "args" };
  }
  const structured = structuredDiff(tool.args);
  if (structured !== undefined) return { lines: structured, source: "args" };
  return undefined;
}

/** Fill an EXISTING tool card node with one tool's content (name, status, args/result, diff block). Clears
 *  the node first so it is safe to re-invoke in place when the tool's result later arrives (bounded to
 *  this one card — no sibling block is touched). */
function applyTool(card: ElementLike, doc: DocumentLike, tool: DerivedTool): void {
  card.replaceChildren();
  card.setAttribute("data-tool", tool.name);
  card.setAttribute("data-offset", String(tool.offset));
  card.setAttribute("data-status", tool.result === undefined ? "pending" : tool.result.ok ? "ok" : "error");
  card.appendChild(el(doc, "div", "cockpit-transcript-tool-name", tool.name));

  const diff = detectDiff(tool);
  if (diff !== undefined) card.setAttribute("data-tool-kind", "diff");

  // Show the raw args unless the diff was synthesized FROM the args (then the diff block replaces it).
  if (tool.args !== undefined && !(diff !== undefined && diff.source === "args")) {
    const argsEl = el(doc, "pre", "cockpit-transcript-tool-args", toText(tool.args));
    argsEl.setAttribute("data-tool-args", "true");
    card.appendChild(argsEl);
  }

  if (diff !== undefined) {
    const pre = el(doc, "pre", "cockpit-transcript-diff");
    pre.setAttribute("data-diff", "true");
    for (const line of diff.lines) {
      // A <pre> may only contain phrasing content, so each diff line is a phrasing <span>
      // (not a block <div>, which would be invalid markup) carrying a trailing "\n". The
      // enclosing <pre> preserves that newline, so lines break onto their own line without
      // depending on host CSS forcing display:block.
      const row = el(doc, "span", "cockpit-transcript-diff-line", `${line.text}\n`);
      row.setAttribute("data-diff-line", line.kind);
      pre.appendChild(row);
    }
    card.appendChild(pre);
  }

  // Render the result content unless it was itself consumed as the diff source (source === "result").
  if (typeof tool.result?.content === "string" && !(diff !== undefined && diff.source === "result")) {
    const resEl = el(doc, "pre", "cockpit-transcript-tool-result", tool.result.content);
    resEl.setAttribute("data-tool-result", "true");
    card.appendChild(resEl);
  }
}

/** Render one tool card: name, status, args + result content, and a distinguishable diff block. */
function renderTool(doc: DocumentLike, tool: DerivedTool): ElementLike {
  const card = el(doc, "div", "cockpit-transcript-tool");
  applyTool(card, doc, tool);
  return card;
}

/**
 * Render one permission prompt card from a {@link DerivedPermission}:
 * - a pending `escalate` request → interactive Allow/Deny buttons wired to `onPermissionResolve`;
 * - a `yolo` request → informational only (yolo auto-allows, it never prompts a human);
 * - a resolved permission → settled (`allowed`/`denied`), showing the chosen option, no live buttons.
 */
function applyPermission(card: ElementLike, doc: DocumentLike, perm: DerivedPermission, options: RenderDerivedTranscriptOptions): void {
  card.replaceChildren();
  card.setAttribute("data-permission", "request");
  card.setAttribute("data-policy", perm.policy);
  card.setAttribute("data-call-id", perm.callId);
  card.setAttribute("data-offset", String(perm.offset));
  if (perm.toolName !== undefined) card.setAttribute("data-tool", perm.toolName);
  if (perm.title !== undefined) card.appendChild(el(doc, "div", "cockpit-transcript-permission-title", perm.title));
  if (perm.reason !== undefined) card.appendChild(el(doc, "div", "cockpit-transcript-permission-reason", perm.reason));

  if (perm.resolved !== undefined) {
    // Settled: show which option was chosen and no live buttons.
    card.setAttribute("data-status", perm.resolved.allowed ? "allowed" : "denied");
    const chosen = perm.options.find((option) => option.optionId === perm.resolved?.optionId);
    const settled = el(doc, "div", "cockpit-transcript-permission-settled", chosen?.name ?? perm.resolved.optionId);
    settled.setAttribute("data-chosen-option", perm.resolved.optionId);
    if (perm.resolved.by !== undefined) settled.setAttribute("data-by", perm.resolved.by);
    card.appendChild(settled);
    return;
  }

  if (perm.policy === "yolo") {
    // Informational: yolo auto-allows and never prompts a human, so no Allow/Deny buttons.
    card.setAttribute("data-status", "auto");
    card.appendChild(el(doc, "div", "cockpit-transcript-permission-note", "Auto-allowed (yolo) — no operator prompt."));
    return;
  }

  // Pending escalate: one interactive button per offered option, wired to the resolve seam.
  card.setAttribute("data-status", "pending");
  const actions = el(doc, "div", "cockpit-transcript-permission-actions");
  for (const option of perm.options) {
    const allowed = optionKindAllows(option.kind);
    const button = el(doc, "button", "cockpit-transcript-permission-option", option.name);
    button.setAttribute("type", "button");
    button.setAttribute("data-option-id", option.optionId);
    button.setAttribute("data-option-kind", option.kind);
    button.setAttribute("data-allowed", String(allowed));
    const onPermissionResolve = options.onPermissionResolve;
    if (onPermissionResolve !== undefined) {
      button.addEventListener("click", () => onPermissionResolve({ callId: perm.callId, optionId: option.optionId, allowed }));
    }
    actions.appendChild(button);
  }
  card.appendChild(actions);
}

/**
 * Render one permission prompt card from a {@link DerivedPermission}:
 * - a pending `escalate` request → interactive Allow/Deny buttons wired to `onPermissionResolve`;
 * - a `yolo` request → informational only (yolo auto-allows, it never prompts a human);
 * - a resolved permission → settled (`allowed`/`denied`), showing the chosen option, no live buttons.
 */
function renderPermission(doc: DocumentLike, perm: DerivedPermission, options: RenderDerivedTranscriptOptions): ElementLike {
  const card = el(doc, "div", "cockpit-transcript-permission");
  applyPermission(card, doc, perm, options);
  return card;
}

/** Fill an EXISTING text-block node with a coalesced message's text + offsets. The block is ONE growing
 *  node per logical message — a delta patches this node's `textContent` in place (never a new card per
 *  fragment), so a split word reconstructs into exactly that word. */
function applyText(node: ElementLike, block: DisplayTextBlock): void {
  node.setAttribute("data-role", block.role);
  node.setAttribute("data-offset", String(block.startOffset));
  node.setAttribute("data-end-offset", String(block.endOffset));
  node.setAttribute("data-block-id", block.id);
  if (block.messageId !== undefined) node.setAttribute("data-message-id", block.messageId);
  node.setAttribute("data-complete", String(block.complete));
  node.textContent = block.text;
}

/** Render one coalesced-message text block (a single growing node). */
function renderText(doc: DocumentLike, block: DisplayTextBlock): ElementLike {
  const node = el(doc, "div", "cockpit-transcript-message");
  applyText(node, block);
  return node;
}

/** Fill an EXISTING retention-gap node. A gap is a first-class visible break so a reattach that dropped
 *  chunks never implies the surrounding text is continuous; its `beforeOffset` is anchored once the first
 *  post-gap block opens. */
function applyGap(node: ElementLike, block: DisplayGapBlock): void {
  node.setAttribute("data-gap", "true");
  node.setAttribute("data-block-id", block.id);
  if (block.beforeOffset !== undefined) node.setAttribute("data-before-offset", String(block.beforeOffset));
  node.textContent = "⋯ retained-data gap — earlier output was evicted ⋯";
}

/** Render one retention-gap block. */
function renderGap(doc: DocumentLike, block: DisplayGapBlock): ElementLike {
  const node = el(doc, "div", "cockpit-transcript-gap");
  applyGap(node, block);
  return node;
}

/** Build a fresh DOM node for any display block kind. */
function renderBlock(doc: DocumentLike, block: DisplayBlock, options: RenderDerivedTranscriptOptions): ElementLike {
  switch (block.kind) {
    case "text":
      return renderText(doc, block);
    case "tool":
      return renderTool(doc, block.tool);
    case "permission":
      return renderPermission(doc, block.permission, options);
    case "gap":
      return renderGap(doc, block);
  }
}

/** Patch an EXISTING block node in place (bounded to that one block — no sibling node is touched). */
function patchBlock(node: ElementLike, doc: DocumentLike, block: DisplayBlock, options: RenderDerivedTranscriptOptions): void {
  switch (block.kind) {
    case "text":
      applyText(node, block);
      return;
    case "tool":
      applyTool(node, doc, block.tool);
      return;
    case "permission":
      applyPermission(node, doc, block.permission, options);
      return;
    case "gap":
      applyGap(node, block);
      return;
  }
}

/**
 * A STATEFUL, incremental transcript renderer over a `host` element. It maintains the ordered
 * {@link DisplayBlock} sequence (via the canonical {@link createDisplayProjection}) and a `blockId → DOM
 * node` map, so feeding it one live chunk at a time updates just the ONE touched block's node in place —
 * append a brand-new block node, or patch an existing block's node (a growing text delta, a tool result
 * pairing, a permission resolution, or a now-anchored gap) — instead of rebuilding the whole transcript
 * tree. That bounded update is what lets the browser adapter preserve selection, expansion and scroll.
 *
 * DOM shape (stable across live growth so unaffected nodes are never replaced):
 *   div.cockpit-transcript-derived[data-*]
 *     div.cockpit-transcript-blocks   ← ordered block nodes are appended here / patched in place
 *     div.cockpit-transcript-empty    ← shown (data-empty="true") only while there are zero blocks
 *     footer.cockpit-transcript-raw   ← retained raw bytes/chunks (byte-replay is preserved alongside)
 */
export interface IncrementalTranscript {
  /** The rendered root (a `cockpit-transcript-derived` element) appended under the host. */
  readonly root: ElementLike;
  /**
   * Fold ONE stored chunk (by offset) into the display and update the DOM minimally. Idempotent on
   * offset — re-feeding an already-applied offset (reconnect, pagination overlap, a duplicated chunk) is
   * a no-op, so replayed text never doubles. Feed chunks in offset order (the projection drops a late
   * lower offset rather than merging it out of place).
   */
  applyChunk(chunk: StoredChunk): void;
  /**
   * Record a retention gap at the current tail BEFORE feeding the post-gap chunks: the consumer resumed
   * from an offset older than the oldest retained chunk, so what follows is NOT continuous with what
   * precedes. Renders a visible break; its `beforeOffset` is anchored when the next block opens.
   */
  noteGap(): void;
  /** A snapshot of the ordered display blocks as they stand now (for tests/inspection). */
  blocks(): readonly DisplayBlock[];
}

/** Running summary tallies for the root attributes + raw footer, maintained WITHOUT re-folding. */
interface Tallies {
  text: number;
  tool: number;
  permission: number;
  gap: number;
  turns: number;
  rawBytes: number;
  rawChunks: number;
  lifecycle: "open" | "completed" | "exited";
}

/**
 * Build the incremental renderer's stable DOM scaffold under `host` and return the mutable render state.
 * Shared by {@link createIncrementalTranscript} (live) and {@link renderDerivedTranscript} (batch) so
 * historical replay renders IDENTICALLY to the final live rendering.
 */
export function createIncrementalTranscript(
  host: ElementLike,
  doc: DocumentLike,
  stream: string,
  options: RenderDerivedTranscriptOptions = {},
): IncrementalTranscript {
  host.replaceChildren();
  const projection: DisplayProjection = createDisplayProjection();
  const nodes = new Map<string, ElementLike>();
  const tallies: Tallies = { text: 0, tool: 0, permission: 0, gap: 0, turns: 0, rawBytes: 0, rawChunks: 0, lifecycle: "open" };
  // A turn opens implicitly before the first structured block even without an explicit `turn` event
  // (mirrors deriveView's implicit turn 0), so any structured content means at least one turn.
  let structured = false;

  const root = el(doc, "div", "cockpit-transcript-derived");
  root.setAttribute("data-stream", stream);
  const blocksHost = el(doc, "div", "cockpit-transcript-blocks");
  const empty = el(doc, "div", "cockpit-transcript-empty");
  const footer = el(doc, "footer", "cockpit-transcript-raw");
  root.appendChild(blocksHost);
  root.appendChild(empty);
  root.appendChild(footer);
  host.appendChild(root);

  function refreshSummary(): void {
    const turnCount = tallies.turns > 0 ? tallies.turns : structured ? 1 : 0;
    root.setAttribute("data-lifecycle", tallies.lifecycle);
    root.setAttribute("data-turn-count", String(turnCount));
    root.setAttribute("data-message-count", String(tallies.text));
    root.setAttribute("data-tool-count", String(tallies.tool));
    root.setAttribute("data-permission-count", String(tallies.permission));
    root.setAttribute("data-gap-count", String(tallies.gap));
    root.setAttribute("data-block-count", String(nodes.size));

    const hasBlocks = tallies.text + tallies.tool + tallies.permission > 0;
    // Toggle (never remove — ElementLike has no removeChild) so a live first block clears the empty note
    // without rebuilding, and an all-raw page still shows exactly one data-empty="true" element.
    empty.setAttribute("data-empty", String(!hasBlocks));
    empty.textContent = hasBlocks ? "" : "No structured events derived — raw replay only.";

    footer.setAttribute("data-raw-bytes", String(tallies.rawBytes));
    footer.setAttribute("data-raw-chunks", String(tallies.rawChunks));
    footer.textContent = `${tallies.rawChunks} raw chunk(s) · ${tallies.rawBytes} B retained for replay`;
  }

  function countAppended(block: DisplayBlock): void {
    structured = structured || block.kind !== "gap";
    if (block.kind === "text") tallies.text++;
    else if (block.kind === "tool") tallies.tool++;
    else if (block.kind === "permission") tallies.permission++;
    else tallies.gap++;
  }

  /** Reconcile ONE projection apply-result into the DOM: append a new node, patch an existing one, and/or
   *  patch a secondary now-anchored gap. Bounded to the touched block(s) — no unaffected node is replaced. */
  function reconcile(changed: DisplayBlock | undefined, appended: boolean, anchored: DisplayBlock | undefined): void {
    if (changed !== undefined) {
      if (appended) {
        const node = renderBlock(doc, changed, options);
        nodes.set(changed.id, node);
        blocksHost.appendChild(node);
        countAppended(changed);
      } else {
        const node = nodes.get(changed.id);
        if (node !== undefined) patchBlock(node, doc, changed, options);
      }
    }
    if (anchored !== undefined) {
      const node = nodes.get(anchored.id);
      if (node !== undefined) patchBlock(node, doc, anchored, options);
    }
  }

  function applyEvent(event: TranscriptEvent): void {
    // Raw bytes feed the byte-replay footer but produce no display block (the projection ignores them).
    if (event.kind === "stream-chunk") {
      tallies.rawChunks++;
      tallies.rawBytes += utf8ByteLength(event.chunk);
    } else if (event.kind === "turn") {
      tallies.turns++;
    } else if (event.kind === "lifecycle") {
      tallies.lifecycle = event.phase;
    }
    const result = projection.apply(event);
    reconcile(result.changed, result.appended, result.anchored);
  }

  refreshSummary();

  return {
    root,
    applyChunk(chunk: StoredChunk): void {
      applyEvent(parseTranscriptEvent(chunk));
      refreshSummary();
    },
    noteGap(): void {
      const result = projection.noteGap();
      reconcile(result.changed, result.appended, result.anchored);
      refreshSummary();
    },
    blocks(): readonly DisplayBlock[] {
      return projection.blocks();
    },
  };
}

/**
 * Render the DERIVED, ORDERED display of a fetched transcript page into `host`, replacing whatever was
 * there — the pure BATCH convenience over {@link createIncrementalTranscript}. Draws one growing text
 * block per logical message, with tool/diff cards and permission prompts interleaved in chronological
 * (offset) order, plus a raw-fidelity footer (retained bytes/chunks) so the byte-replay stays visibly
 * preserved. A retention `gap` on the page (`data.gap`) renders a leading visible break. Idempotent —
 * call again on each refresh. Everything it shows is a derivation of the one event log, and it renders
 * IDENTICALLY to the final live rendering (same incremental fold). `options.onPermissionResolve`, when
 * provided, is invoked by a pending escalate-permission prompt's Allow/Deny buttons.
 */
export function renderDerivedTranscript(
  host: ElementLike,
  doc: DocumentLike,
  data: TranscriptDataReport,
  options: RenderDerivedTranscriptOptions = {},
): DerivedTranscriptDom {
  const incremental = createIncrementalTranscript(host, doc, data.stream, options);
  // A page-level retention gap precedes the page's first chunk: note it before folding so a leading
  // visible break renders (a reattach that dropped chunks never implies false continuity).
  if (data.gap) incremental.noteGap();
  // The batch path folds the SAME chunks the live path does, in offset order, through the ONE projection,
  // so historical and live rendering are byte-for-byte the same tree.
  for (const chunk of [...data.entries].sort((a, b) => a.offset - b.offset)) incremental.applyChunk(chunk);
  return { root: incremental.root };
}
