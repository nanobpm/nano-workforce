// @generated from app/agentic/cockpit/transcript-derive.ts by scripts/build-cockpit-browser.ts — DO NOT EDIT.
//
// Browser ESM derived (type-strip only) from the typed transcript core so pages/cockpit/mount.js
// renders the agentic transcript from ONE source of truth (#660). Regenerate with:
//   node --experimental-strip-types scripts/build-cockpit-browser.ts

import { createDisplayProjection } from "./transcript-display.js";
import { deriveViewFromChunks, optionKindAllows, parseTranscriptEvent, utf8ByteLength, } from "./transcript-events.js";
/**
 * Derive the structured (event-fold) view of a fetched transcript page — the flat message/tool/permission
 * history, per-turn structure and raw-byte accounting. This is the {@link DerivedView} fold, kept for the
 * raw-fidelity footer and summary counts; the ordered, human-facing block SEQUENCE is the separate
 * display projection {@link renderDerivedTranscript} draws. Pure: the cockpit reads THESE instead of
 * re-parsing raw frame bytes.
 */
export function deriveTranscript(data) {
    return deriveViewFromChunks(data.entries);
}
function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className !== undefined)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
/** Render an arbitrary derived value (tool args/result) as displayable text without re-parsing the log. */
function toText(value) {
    if (typeof value === "string")
        return value;
    if (value === undefined)
        return "";
    return JSON.stringify(value, null, 2);
}
/** Read the first string-valued field among `keys` off an object, without an `as` cast. */
function pickString(obj, keys) {
    for (const key of keys) {
        const value = Reflect.get(obj, key);
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
/** Classify one line of a unified diff (file/hunk headers are context, not add/del). */
function classifyUnifiedLine(line) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff "))
        return "ctx";
    if (line.startsWith("+"))
        return "add";
    if (line.startsWith("-"))
        return "del";
    return "ctx";
}
/** Heuristic: does this string look like a unified diff (a hunk header, or paired +/- content lines)? */
function looksLikeUnifiedDiff(text) {
    if (text.length === 0)
        return false;
    let add = false;
    let del = false;
    let hunk = false;
    for (const line of text.split("\n")) {
        if (line.startsWith("@@") || line.startsWith("diff --git"))
            hunk = true;
        else if (line.startsWith("+++") || line.startsWith("---"))
            continue;
        else if (line.startsWith("+"))
            add = true;
        else if (line.startsWith("-"))
            del = true;
    }
    return hunk || (add && del);
}
/** Split a unified-diff string into classified lines (dropping a single trailing empty line). */
function parseUnifiedDiff(text) {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
    return lines.map((line) => ({ kind: classifyUnifiedLine(line), text: line }));
}
/** Split a block of text into lines, dropping a single trailing empty segment (text ending in "\n"). */
function splitTextLines(text) {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}
/** Synthesize a diff from structured edit args (`{ path?, oldText/old_string, newText/new_string }`). */
function structuredDiff(args) {
    if (typeof args !== "object" || args === null)
        return undefined;
    const oldText = pickString(args, ["oldText", "old_string", "oldStr", "old", "before"]);
    const newText = pickString(args, ["newText", "new_string", "newStr", "new", "after"]);
    if (oldText === undefined && newText === undefined)
        return undefined;
    const lines = [];
    const path = pickString(args, ["path", "file", "filePath", "fileName"]);
    if (path !== undefined)
        lines.push({ kind: "ctx", text: `diff --git a/${path} b/${path}` });
    if (oldText !== undefined && oldText.length > 0) {
        for (const line of splitTextLines(oldText))
            lines.push({ kind: "del", text: `-${line}` });
    }
    if (newText !== undefined && newText.length > 0) {
        for (const line of splitTextLines(newText))
            lines.push({ kind: "add", text: `+${line}` });
    }
    return lines.length > 0 ? lines : undefined;
}
/** Detect diff-shaped content on a tool call/result — a unified-diff string or structured edit args. */
function detectDiff(tool) {
    const content = tool.result?.content;
    if (typeof content === "string" && looksLikeUnifiedDiff(content)) {
        return { lines: parseUnifiedDiff(content), source: "result" };
    }
    if (typeof tool.args === "string" && looksLikeUnifiedDiff(tool.args)) {
        return { lines: parseUnifiedDiff(tool.args), source: "args" };
    }
    const structured = structuredDiff(tool.args);
    if (structured !== undefined)
        return { lines: structured, source: "args" };
    return undefined;
}
/** Fill an EXISTING tool card node with one tool's content (name, status, args/result, diff block). Clears
 *  the node first so it is safe to re-invoke in place when the tool's result later arrives (bounded to
 *  this one card — no sibling block is touched). */
function applyTool(card, doc, tool) {
    card.replaceChildren();
    card.setAttribute("data-tool", tool.name);
    card.setAttribute("data-offset", String(tool.offset));
    card.setAttribute("data-status", tool.result === undefined ? "pending" : tool.result.ok ? "ok" : "error");
    card.appendChild(el(doc, "div", "cockpit-transcript-tool-name", tool.name));
    const diff = detectDiff(tool);
    if (diff !== undefined)
        card.setAttribute("data-tool-kind", "diff");
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
function renderTool(doc, tool) {
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
function applyPermission(card, doc, perm, options) {
    card.replaceChildren();
    card.setAttribute("data-permission", "request");
    card.setAttribute("data-policy", perm.policy);
    card.setAttribute("data-call-id", perm.callId);
    card.setAttribute("data-offset", String(perm.offset));
    if (perm.toolName !== undefined)
        card.setAttribute("data-tool", perm.toolName);
    if (perm.title !== undefined)
        card.appendChild(el(doc, "div", "cockpit-transcript-permission-title", perm.title));
    if (perm.reason !== undefined)
        card.appendChild(el(doc, "div", "cockpit-transcript-permission-reason", perm.reason));
    if (perm.resolved !== undefined) {
        // Settled: show which option was chosen and no live buttons.
        card.setAttribute("data-status", perm.resolved.allowed ? "allowed" : "denied");
        const chosen = perm.options.find((option) => option.optionId === perm.resolved?.optionId);
        const settled = el(doc, "div", "cockpit-transcript-permission-settled", chosen?.name ?? perm.resolved.optionId);
        settled.setAttribute("data-chosen-option", perm.resolved.optionId);
        if (perm.resolved.by !== undefined)
            settled.setAttribute("data-by", perm.resolved.by);
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
function renderPermission(doc, perm, options) {
    const card = el(doc, "div", "cockpit-transcript-permission");
    applyPermission(card, doc, perm, options);
    return card;
}
/** Fill an EXISTING text-block node with a coalesced message's text + offsets. The block is ONE growing
 *  node per logical message — a delta patches this node's `textContent` in place (never a new card per
 *  fragment), so a split word reconstructs into exactly that word. */
function applyText(node, block) {
    node.setAttribute("data-role", block.role);
    node.setAttribute("data-offset", String(block.startOffset));
    node.setAttribute("data-end-offset", String(block.endOffset));
    node.setAttribute("data-block-id", block.id);
    if (block.messageId !== undefined)
        node.setAttribute("data-message-id", block.messageId);
    node.setAttribute("data-complete", String(block.complete));
    node.textContent = block.text;
}
/** Render one coalesced-message text block (a single growing node). */
function renderText(doc, block) {
    const node = el(doc, "div", "cockpit-transcript-message");
    applyText(node, block);
    return node;
}
/** Fill an EXISTING retention-gap node. A gap is a first-class visible break so a reattach that dropped
 *  chunks never implies the surrounding text is continuous; its `beforeOffset` is anchored once the first
 *  post-gap block opens. */
function applyGap(node, block) {
    node.setAttribute("data-gap", "true");
    node.setAttribute("data-block-id", block.id);
    if (block.beforeOffset !== undefined)
        node.setAttribute("data-before-offset", String(block.beforeOffset));
    node.textContent = "⋯ retained-data gap — earlier output was evicted ⋯";
}
/** Render one retention-gap block. */
function renderGap(doc, block) {
    const node = el(doc, "div", "cockpit-transcript-gap");
    applyGap(node, block);
    return node;
}
/** Build a fresh DOM node for any display block kind. */
function renderBlock(doc, block, options) {
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
function patchBlock(node, doc, block, options) {
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
 * Build the incremental renderer's stable DOM scaffold under `host` and return the mutable render state.
 * Shared by {@link createIncrementalTranscript} (live) and {@link renderDerivedTranscript} (batch) so
 * historical replay renders IDENTICALLY to the final live rendering.
 */
export function createIncrementalTranscript(host, doc, stream, options = {}) {
    host.replaceChildren();
    const projection = createDisplayProjection();
    const nodes = new Map();
    const tallies = { text: 0, tool: 0, permission: 0, gap: 0, turns: 0, rawBytes: 0, rawChunks: 0, lifecycle: "open" };
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
    function refreshSummary() {
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
    function countAppended(block) {
        structured = structured || block.kind !== "gap";
        if (block.kind === "text")
            tallies.text++;
        else if (block.kind === "tool")
            tallies.tool++;
        else if (block.kind === "permission")
            tallies.permission++;
        else
            tallies.gap++;
    }
    /** Reconcile ONE projection apply-result into the DOM: append a new node, patch an existing one, and/or
     *  patch a secondary now-anchored gap. Bounded to the touched block(s) — no unaffected node is replaced. */
    function reconcile(changed, appended, anchored) {
        if (changed !== undefined) {
            if (appended) {
                const node = renderBlock(doc, changed, options);
                nodes.set(changed.id, node);
                blocksHost.appendChild(node);
                countAppended(changed);
            }
            else {
                const node = nodes.get(changed.id);
                if (node !== undefined)
                    patchBlock(node, doc, changed, options);
            }
        }
        if (anchored !== undefined) {
            const node = nodes.get(anchored.id);
            if (node !== undefined)
                patchBlock(node, doc, anchored, options);
        }
    }
    function applyEvent(event) {
        // Raw bytes feed the byte-replay footer but produce no display block (the projection ignores them).
        if (event.kind === "stream-chunk") {
            tallies.rawChunks++;
            tallies.rawBytes += utf8ByteLength(event.chunk);
        }
        else if (event.kind === "turn") {
            tallies.turns++;
        }
        else if (event.kind === "lifecycle") {
            tallies.lifecycle = event.phase;
        }
        const result = projection.apply(event);
        reconcile(result.changed, result.appended, result.anchored);
    }
    refreshSummary();
    return {
        root,
        applyChunk(chunk) {
            applyEvent(parseTranscriptEvent(chunk));
            refreshSummary();
        },
        noteGap() {
            const result = projection.noteGap();
            reconcile(result.changed, result.appended, result.anchored);
            refreshSummary();
        },
        blocks() {
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
export function renderDerivedTranscript(host, doc, data, options = {}) {
    const incremental = createIncrementalTranscript(host, doc, data.stream, options);
    // A page-level retention gap precedes the page's first chunk: note it before folding so a leading
    // visible break renders (a reattach that dropped chunks never implies false continuity).
    if (data.gap)
        incremental.noteGap();
    // The batch path folds the SAME chunks the live path does, in offset order, through the ONE projection,
    // so historical and live rendering are byte-for-byte the same tree.
    for (const chunk of [...data.entries].sort((a, b) => a.offset - b.offset))
        incremental.applyChunk(chunk);
    return { root: incremental.root };
}
