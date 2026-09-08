// @generated from node_modules/@nanobpm/agentic/dist/transcript/display.js by scripts/build-cockpit-browser.ts — DO NOT EDIT.
//
// Browser ESM derived (type-strip only) from the typed transcript core so pages/cockpit/mount.js
// renders the agentic transcript from ONE source of truth (#660). Regenerate with:
//   node --experimental-strip-types scripts/build-cockpit-browser.ts

const NOOP = Object.freeze({ appended: false });
/** Recursively freeze a value already owned exclusively by the caller (a fresh clone), so no consumer
 *  can mutate it at any depth. Idempotent, and a no-op for primitives and already-frozen objects. A
 *  `seen` set guards against cyclic references so an arbitrarily-shaped `args` payload with a cycle
 *  freezes without recursing forever. */
function deepFreeze(value, seen = new WeakSet()) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value) || seen.has(value))
        return;
    seen.add(value);
    Object.freeze(value);
    for (const nested of Object.values(value))
        deepFreeze(nested, seen);
}
/** Decouple a producer-owned, arbitrarily-shaped `args` value from projection state: deep clone it (so
 *  the returned snapshot shares no mutable reference) then deep-freeze the clone. When `structuredClone`
 *  is unavailable or `args` is non-cloneable (e.g. it contains functions), fall back to deep-freezing
 *  `args` *in place* rather than returning it unfrozen: a shared-by-reference fallback would let a
 *  consumer mutate `tool.args` back into the projection's internals, so freezing the shared object is
 *  what preserves the "cannot reach back" guarantee even when cloning fails. */
function freezeArgs(args) {
    if (args === null || typeof args !== "object")
        return args;
    let cloned;
    try {
        cloned = structuredClone(args);
    }
    catch {
        deepFreeze(args);
        return args;
    }
    deepFreeze(cloned);
    return cloned;
}
/** Deep-freeze a {@link DerivedTool} into a snapshot decoupled from the projection's mutable internals:
 *  a shallow clone whose nested `result` is itself cloned + frozen and whose producer-owned `args` is
 *  deep cloned + frozen ({@link freezeArgs}), so a consumer that mutates the returned `tool` (or
 *  `tool.result` / `tool.args`) cannot reach back into projection state. */
function freezeTool(tool) {
    return Object.freeze({
        ...tool,
        ...(tool.args !== undefined ? { args: freezeArgs(tool.args) } : {}),
        ...(tool.result !== undefined ? { result: Object.freeze({ ...tool.result }) } : {}),
    });
}
/** Deep-freeze a {@link DerivedPermission} into a snapshot decoupled from the projection's mutable
 *  internals: a shallow clone whose nested `options` (and each option) and `resolved` are cloned +
 *  frozen, so a consumer cannot mutate projection state through the returned `permission`. */
function freezePermission(permission) {
    return Object.freeze({
        ...permission,
        options: Object.freeze(permission.options.map((option) => Object.freeze({ ...option }))),
        ...(permission.resolved !== undefined ? { resolved: Object.freeze({ ...permission.resolved }) } : {}),
    });
}
function freezeBlock(block) {
    switch (block.kind) {
        case "text":
            return Object.freeze({
                kind: "text",
                id: `text:${block.startOffset}`,
                role: block.role,
                ...(block.messageId !== undefined ? { messageId: block.messageId } : {}),
                text: block.text,
                startOffset: block.startOffset,
                endOffset: block.endOffset,
                complete: block.complete,
            });
        case "tool":
            return Object.freeze({
                kind: "tool",
                id: `tool:${block.startOffset}`,
                tool: freezeTool(block.tool),
                startOffset: block.startOffset,
                endOffset: block.endOffset,
            });
        case "permission":
            return Object.freeze({
                kind: "permission",
                id: `permission:${block.startOffset}`,
                permission: freezePermission(block.permission),
                startOffset: block.startOffset,
                endOffset: block.endOffset,
            });
        case "gap":
            return Object.freeze({
                kind: "gap",
                id: `gap:${block.ordinal}`,
                ...(block.beforeOffset !== undefined ? { beforeOffset: block.beforeOffset } : {}),
            });
    }
}
function toolFromCall(event) {
    return {
        name: event.name,
        offset: event.offset,
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
        ...(event.args !== undefined ? { args: event.args } : {}),
    };
}
function toolWithResult(tool, result) {
    return {
        ...tool,
        result: {
            ok: result.ok,
            offset: result.offset,
            ...(result.content !== undefined ? { content: result.content } : {}),
        },
    };
}
function permissionFromRequest(event) {
    return {
        callId: event.callId,
        policy: event.policy,
        options: event.options,
        offset: event.offset,
        ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
    };
}
function permissionWithResolution(permission, resolution) {
    return {
        ...permission,
        resolved: {
            allowed: resolution.allowed,
            optionId: resolution.optionId,
            offset: resolution.offset,
            ...(resolution.by !== undefined ? { by: resolution.by } : {}),
        },
    };
}
export function createDisplayProjection() {
    const blocks = [];
    const openTools = new Map();
    let anonymousTool;
    const openPermissions = new Map();
    // The append-order idempotency key: the highest offset ever folded. Any event at or below it was
    // already applied (a replayed/duplicated chunk), so it is a no-op — this is what keeps replay,
    // reconnect and pagination overlap from doubling text. Starts at -1 so offset 0 applies.
    let lastOffset = -1;
    // A pending gap awaiting the offset of the next block, so a consumer can anchor the break.
    let pendingGapBlock;
    let gapOrdinal = 0;
    /** The active text block a delta may extend: the LAST block, iff it is an open text block. Any other
     *  trailing block (a tool card, a permission, a gap) means there is no open text run to coalesce into. */
    const activeText = () => {
        const tail = blocks[blocks.length - 1];
        return tail !== undefined && tail.kind === "text" && !tail.complete ? tail : undefined;
    };
    const closeActiveText = () => {
        const active = activeText();
        if (active !== undefined)
            active.complete = true;
    };
    /** Anchor a not-yet-anchored gap to the first block that opens after it, returning the now-anchored gap
     *  (frozen) so the triggering {@link apply} can surface it as {@link DisplayApplyResult.anchored} — else
     *  `undefined` when there is no pending gap. */
    const anchorGap = (offset) => {
        if (pendingGapBlock === undefined)
            return undefined;
        pendingGapBlock.beforeOffset = offset;
        const anchored = freezeBlock(pendingGapBlock);
        pendingGapBlock = undefined;
        return anchored;
    };
    const applyMessage = (event) => {
        const active = activeText();
        // A delta may extend the active block only when it is the SAME speaker AND the SAME logical message
        // AND the producer did not force a new block with `start`. Message identity: if both sides carry a
        // `messageId` they must match; a changed id (or one side having an id the other lacks) is a distinct
        // message. With no ids on either side, the fallback is purely structural — adjacent + same speaker.
        const idsMatch = event.messageId !== undefined || active?.messageId !== undefined
            ? event.messageId === active?.messageId
            : true;
        const canExtend = active !== undefined && event.start !== true && active.role === event.role && idsMatch;
        if (canExtend && active !== undefined) {
            // Snapshot REPLACES the accumulated text; a delta APPENDS exactly (no separator).
            active.text = event.mode === "snapshot" ? event.text : active.text + event.text;
            active.endOffset = event.offset;
            if (event.final === true)
                active.complete = true;
            return { changed: freezeBlock(active), appended: false };
        }
        // Open a fresh block. (A `start`/id-change/role-change also closes any still-open predecessor so the
        // next unrelated delta cannot re-open it.)
        closeActiveText();
        const anchored = anchorGap(event.offset);
        const block = {
            kind: "text",
            role: event.role,
            text: event.text,
            startOffset: event.offset,
            endOffset: event.offset,
            complete: event.final === true,
            ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
        };
        blocks.push(block);
        return { changed: freezeBlock(block), appended: true, ...(anchored !== undefined ? { anchored } : {}) };
    };
    const applyToolCall = (event) => {
        // A tool call interrupts any running text: it becomes the trailing block, so a later delta opens a
        // new text block rather than coalescing across the tool.
        closeActiveText();
        const anchored = anchorGap(event.offset);
        const block = {
            kind: "tool",
            tool: toolFromCall(event),
            startOffset: event.offset,
            endOffset: event.offset,
        };
        blocks.push(block);
        const pending = { block };
        if (event.callId !== undefined)
            openTools.set(event.callId, pending);
        else
            anonymousTool = pending;
        return { changed: freezeBlock(block), appended: true, ...(anchored !== undefined ? { anchored } : {}) };
    };
    const applyToolResult = (event) => {
        const pending = event.callId !== undefined ? openTools.get(event.callId) : anonymousTool;
        if (pending === undefined)
            return NOOP; // A result with no open call — nothing to pair (never invents a card).
        pending.block.tool = toolWithResult(pending.block.tool, event);
        pending.block.endOffset = event.offset;
        if (event.callId !== undefined)
            openTools.delete(event.callId);
        else
            anonymousTool = undefined;
        return { changed: freezeBlock(pending.block), appended: false };
    };
    const applyPermissionRequest = (event) => {
        closeActiveText();
        const anchored = anchorGap(event.offset);
        const block = {
            kind: "permission",
            permission: permissionFromRequest(event),
            startOffset: event.offset,
            endOffset: event.offset,
        };
        blocks.push(block);
        openPermissions.set(event.callId, { block });
        return { changed: freezeBlock(block), appended: true, ...(anchored !== undefined ? { anchored } : {}) };
    };
    const applyPermissionResolution = (event) => {
        const pending = openPermissions.get(event.callId);
        if (pending === undefined)
            return NOOP;
        pending.block.permission = permissionWithResolution(pending.block.permission, event);
        pending.block.endOffset = event.offset;
        openPermissions.delete(event.callId);
        return { changed: freezeBlock(pending.block), appended: false };
    };
    const apply = (event) => {
        // Idempotency gate: this projection requires events in strictly increasing `offset` order, so any
        // offset at or below the high-water mark is treated as already folded (replay / reconnect /
        // pagination overlap / a duplicated chunk) and re-applying it must not change anything. A genuinely
        // out-of-order event (offset <= lastOffset arriving late) is likewise dropped here, not merged — a
        // caller seeing a "missing" block must re-feed the stream in order rather than read it as deduped.
        if (event.offset <= lastOffset)
            return NOOP;
        lastOffset = event.offset;
        switch (event.kind) {
            case "message":
                return applyMessage(event);
            case "tool-call":
                return applyToolCall(event);
            case "tool-result":
                return applyToolResult(event);
            case "permission":
                return event.phase === "request" ? applyPermissionRequest(event) : applyPermissionResolution(event);
            case "turn":
                // An explicit turn boundary closes the running message so the next turn's text starts fresh.
                closeActiveText();
                return NOOP;
            // A `step`, a `lifecycle` transition, and a raw `stream-chunk` do not themselves produce a display
            // block and do not break text coalescing (raw bytes render on the separate byte-terminal plane).
            case "step":
            case "lifecycle":
            case "stream-chunk":
                return NOOP;
        }
    };
    return {
        apply,
        applyAll(events) {
            for (const event of events)
                apply(event);
        },
        noteGap() {
            closeActiveText();
            const block = { kind: "gap", ordinal: gapOrdinal++ };
            blocks.push(block);
            pendingGapBlock = block;
            return { changed: freezeBlock(block), appended: true };
        },
        blocks() {
            return blocks.map(freezeBlock);
        },
    };
}
/**
 * The pure batch convenience: fold a whole run of offset-ordered events into the ordered display blocks
 * in one call, over a fresh {@link createDisplayProjection}. Duplicate offsets in the input are deduped
 * by the same idempotency gate, so a replayed slice folds to the same result as a gap-free one.
 */
export function deriveDisplay(events) {
    const projection = createDisplayProjection();
    projection.applyAll(events);
    return projection.blocks();
}
