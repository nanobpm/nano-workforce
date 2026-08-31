// @generated from app/agentic/cockpit/transcript-derive.ts by scripts/build-cockpit-browser.ts — DO NOT EDIT.
//
// Browser ESM derived (type-strip only) from the typed transcript core so pages/cockpit/mount.js
// renders the agentic transcript from ONE source of truth (#660). Regenerate with:
//   node --experimental-strip-types scripts/build-cockpit-browser.ts

import { deriveViewFromChunks, optionKindAllows, } from "./transcript-events.js";
/**
 * Derive the structured view of a fetched transcript page by folding its stored chunks through the ONE
 * event parser + fold. Pure: the cockpit reads THIS instead of re-parsing raw frame bytes.
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
/** Render one tool card: name, status, args + result content, and a distinguishable diff block. */
function renderTool(doc, tool) {
    const card = el(doc, "div", "cockpit-transcript-tool");
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
    return card;
}
/**
 * Render one permission prompt card from a {@link DerivedPermission}:
 * - a pending `escalate` request → interactive Allow/Deny buttons wired to `onPermissionResolve`;
 * - a `yolo` request → informational only (yolo auto-allows, it never prompts a human);
 * - a resolved permission → settled (`allowed`/`denied`), showing the chosen option, no live buttons.
 */
function renderPermission(doc, perm, options) {
    const card = el(doc, "div", "cockpit-transcript-permission");
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
        return card;
    }
    if (perm.policy === "yolo") {
        // Informational: yolo auto-allows and never prompts a human, so no Allow/Deny buttons.
        card.setAttribute("data-status", "auto");
        card.appendChild(el(doc, "div", "cockpit-transcript-permission-note", "Auto-allowed (yolo) — no operator prompt."));
        return card;
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
    return card;
}
/**
 * Render the DERIVED structured view of a fetched transcript into `host`, replacing whatever was there.
 * Draws per-turn sections with their derived messages, rich tool/diff cards and permission prompts, plus
 * a raw-fidelity footer (retained bytes/chunks) so the operator sees the byte-replay is preserved
 * alongside the structure. Idempotent — call again on each refresh. Everything it shows is a derivation
 * of the one event log. `options.onPermissionResolve`, when provided, is invoked by a pending
 * escalate-permission prompt's Allow/Deny buttons.
 */
export function renderDerivedTranscript(host, doc, data, options = {}) {
    const view = deriveTranscript(data);
    host.replaceChildren();
    const root = el(doc, "div", "cockpit-transcript-derived");
    root.setAttribute("data-stream", data.stream);
    root.setAttribute("data-lifecycle", view.lifecycle);
    root.setAttribute("data-turn-count", String(view.turns.length));
    root.setAttribute("data-message-count", String(view.messages.length));
    root.setAttribute("data-tool-count", String(view.tools.length));
    root.setAttribute("data-permission-count", String(view.permissions.length));
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
            section.appendChild(renderTool(doc, tool));
        }
        for (const perm of turn.permissions) {
            section.appendChild(renderPermission(doc, perm, options));
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
