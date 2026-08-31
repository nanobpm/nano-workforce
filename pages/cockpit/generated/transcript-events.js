// @generated from app/agentic/transcript-events.ts by scripts/build-cockpit-browser.ts — DO NOT EDIT.
//
// Browser ESM derived (type-strip only) from the typed transcript core so pages/cockpit/mount.js
// renders the agentic transcript from ONE source of truth (#660). Regenerate with:
//   node --experimental-strip-types scripts/build-cockpit-browser.ts

// nano-workforce — the transcript EVENT vocabulary + the single derive() fold (ADR 0056, #251).
//
// This is the "event-sourced session" layer over the H3 transcript store (#146/#222). The store is
// already append-only and offset-keyed — chunks are appended, never mutated — which is half of the
// dsh (DeepSeek Harness) event-sourced-session pattern. The gap it left is that chunks are opaque
// `TEXT`: every richer view (structured message history, tool cards, per-turn boundaries, token
// accounting) had to re-parse the raw frame bytes ad hoc, a DRIFT SURFACE (two parsers of the same
// bytes), which our "Derivation Over Duplication" doctrine forbids.
//
// This module closes that gap the way dsh does: the append-only log of TYPED events is the single
// source of truth, and every higher-level view is a DERIVATION of that one log via a single
// {@link deriveView} fold — "the log IS the state, so divergence is structurally impossible". A raw
// terminal chunk is retained verbatim as a `stream-chunk` event (byte-level replay fidelity is
// preserved); a producer that emits a structured, marker-tagged JSON envelope is decoded into the
// authoritative typed events (message / tool-call / tool-result / turn / step / lifecycle) the derived
// views fold over — mirroring dsh (raw chunks for token-replay, `assistant/message` authoritative).
//
// THE ONE PARSER. {@link parseTranscriptEvent} is the SINGLE place a stored chunk is classified into a
// typed event; every consumer (cockpit, search, token accounting, export) reads the derived view, not
// the raw bytes. A drift-guard test (`transcript-events.drift.test.ts`) asserts the event marker — and
// therefore the raw→event parse — appears in exactly this module, so a second parser cannot creep in.
//
// MERGE-EXTENSIBLE. The vocabulary is a small core ({@link CORE_TRANSCRIPT_VOCAB}) authors extend in the
// same schema with {@link mergeTranscriptVocab} (cribbed from dsh's merge-extensible event taxonomy and
// the S3 `mergeVocab`), so a new event kind is an additive merge, never a fork of the parser.
//
// Pure and side-effect-free: no I/O, unit-testable on Node, and it never touches the engine or a BPMN
// flow (ADR 0056: app-tier only, advisory).
/**
 * Runtime-safe UTF-8 byte length. This module is imported by cockpit code that runs in the BROWSER
 * (via `cockpit/transcript-derive.ts`), where Node's `Buffer` global is not available — a bare
 * `Buffer.byteLength` would throw at runtime when deriving the view for a replayed transcript. Prefer
 * `Buffer` when present (Node) and fall back to `TextEncoder` (a Web/Node standard) otherwise, so the
 * single derive fold is portable across both hosts. This is the one canonical UTF-8 byte-length
 * implementation the transcript plane derives from (reused by `transcript-read.ts`).
 */
let cachedTextEncoder;
export function utf8ByteLength(text) {
    if (typeof Buffer !== "undefined")
        return Buffer.byteLength(text, "utf8");
    // Cache one TextEncoder in the browser hot path (folding many stream-chunk events) to avoid
    // allocating a new encoder — and the GC pressure it creates — on every call.
    cachedTextEncoder ??= new TextEncoder();
    return cachedTextEncoder.encode(text).length;
}
/**
 * The reserved marker field that distinguishes a structured transcript-event envelope from raw
 * terminal bytes. A stored chunk is decoded as a typed event ONLY when it is a JSON object carrying
 * this field set to the schema version — otherwise it is retained verbatim as a raw `stream-chunk`, so
 * a raw ANSI frame that happens to be valid JSON is never mis-classified. Namespaced to nano-workforce
 * so it cannot collide with a producer's own payload keys.
 */
export const TRANSCRIPT_EVENT_MARKER = "nwfTranscriptEvent";
/** The current transcript-event envelope schema version (the value {@link TRANSCRIPT_EVENT_MARKER} carries). */
export const TRANSCRIPT_EVENT_VERSION = 1;
/** Pure, canonical: does a permission option kind ALLOW (true) or REJECT (false) the proposed action?
 *  The `allow-*` vs `reject-*` prefix is the single source of truth. This lives beside
 *  {@link PermissionOptionKind} so every consumer (the cockpit render seam and the permission-escalation
 *  bridge) derives allow/deny from ONE implementation — the two paths can never disagree on what a
 *  chosen option means (no drift surface). */
export function optionKindAllows(kind) {
    return kind === "allow-once" || kind === "allow-always";
}
function str(body, key) {
    const v = body[key];
    return typeof v === "string" ? v : undefined;
}
function num(body, key) {
    const v = body[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
const ROLES = ["assistant", "user", "system", "tool"];
/** Narrow an arbitrary string to a known {@link TranscriptRole}, defaulting to `assistant`. */
function toRole(value) {
    return ROLES.find((role) => role === value) ?? "assistant";
}
/** A structural guard: a non-null, non-array object is a plain record of unknown values. */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
const PERMISSION_OPTION_KINDS = [
    "allow-once",
    "allow-always",
    "reject-once",
    "reject-always",
];
/**
 * Decode ACP's `options[]` into typed {@link PermissionOption}s, or `undefined` if the array is
 * missing/empty or any member is malformed (so the whole request envelope is rejected → `stream-chunk`).
 */
function decodePermissionOptions(value) {
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    const options = [];
    for (const raw of value) {
        if (!isRecord(raw))
            return undefined;
        const optionId = str(raw, "optionId");
        const name = str(raw, "name");
        const kindRaw = str(raw, "kind");
        const kind = PERMISSION_OPTION_KINDS.find((k) => k === kindRaw);
        if (optionId === undefined || name === undefined || kind === undefined)
            return undefined;
        options.push({ optionId, name, kind });
    }
    return options;
}
/**
 * The opinionated core vocabulary — the built-in event kinds every consumer understands out of the
 * box. Authors extend it in the SAME schema via {@link mergeTranscriptVocab}; they never fork the
 * parser. (`stream-chunk` is not decoded here — it is the fallback the parser applies to any chunk
 * that is not a well-formed typed envelope, so raw fidelity needs no decoder.)
 */
export const CORE_TRANSCRIPT_VOCAB = Object.freeze({
    message: (body, offset) => {
        const text = str(body, "text");
        if (text === undefined)
            return undefined;
        const roleRaw = str(body, "role");
        return { kind: "message", offset, role: toRole(roleRaw), text };
    },
    "tool-call": (body, offset) => {
        const name = str(body, "name");
        if (name === undefined)
            return undefined;
        const event = { kind: "tool-call", offset, name };
        const callId = str(body, "callId");
        return {
            ...event,
            ...(callId !== undefined ? { callId } : {}),
            ...("args" in body ? { args: body.args } : {}),
        };
    },
    "tool-result": (body, offset) => {
        const ok = typeof body.ok === "boolean" ? body.ok : true;
        const event = { kind: "tool-result", offset, ok };
        const callId = str(body, "callId");
        const content = str(body, "content");
        return {
            ...event,
            ...(callId !== undefined ? { callId } : {}),
            ...(content !== undefined ? { content } : {}),
        };
    },
    // ACP `plan` mapping: ACP `session/update` plan updates map onto the EXISTING `step`/`turn`
    // vocabulary rather than a new kind — an ACP plan ENTRY becomes a `step` (its `label` is the plan
    // entry's title; the entry ordinal is not preserved, as `StepEvent` carries only a `label`), and a
    // plan/turn BOUNDARY becomes a `turn` (its `index` the ACP turn/plan ordinal). The decoders below
    // already cope with an ACP-shaped `label` (`step`) / `index` (`turn`), so no new kind is needed.
    turn: (body, offset) => {
        const index = num(body, "index");
        return index !== undefined ? { kind: "turn", offset, index } : { kind: "turn", offset };
    },
    step: (body, offset) => {
        const label = str(body, "label");
        return label !== undefined ? { kind: "step", offset, label } : { kind: "step", offset };
    },
    lifecycle: (body, offset) => {
        const phase = str(body, "phase");
        if (phase !== "open" && phase !== "completed" && phase !== "exited")
            return undefined;
        return { kind: "lifecycle", offset, phase };
    },
    // A single `permission` decoder handles BOTH shapes (never a parser fork), branching on `phase`.
    // Malformed envelopes return `undefined` and fall back to `stream-chunk`, like the other decoders.
    permission: (body, offset) => {
        const callId = str(body, "callId");
        if (callId === undefined)
            return undefined;
        const phase = str(body, "phase");
        if (phase === "request") {
            const policy = str(body, "policy");
            if (policy !== "escalate" && policy !== "yolo")
                return undefined;
            const options = decodePermissionOptions(body.options);
            if (options === undefined)
                return undefined;
            const toolName = str(body, "toolName");
            const title = str(body, "title");
            const reason = str(body, "reason");
            const event = { kind: "permission", phase: "request", offset, callId, policy, options };
            return {
                ...event,
                ...(toolName !== undefined ? { toolName } : {}),
                ...(title !== undefined ? { title } : {}),
                ...(reason !== undefined ? { reason } : {}),
            };
        }
        if (phase === "resolution") {
            const optionId = str(body, "optionId");
            if (optionId === undefined)
                return undefined;
            if (typeof body.allowed !== "boolean")
                return undefined;
            const by = str(body, "by");
            // Reject a malformed `by` rather than silently dropping it: a present-but-unknown provenance is a
            // producer bug, and swallowing it would make the typed event diverge from the on-wire JSON. This
            // covers BOTH a present-but-non-string `by` (e.g. `by: 123`, where str() coerces to undefined) and
            // a string that isn't a known provenance — either way the on-wire `by` is present but invalid.
            if (body.by !== undefined && by === undefined)
                return undefined;
            if (by !== undefined && by !== "operator" && by !== "auto")
                return undefined;
            const event = {
                kind: "permission",
                phase: "resolution",
                offset,
                callId,
                optionId,
                allowed: body.allowed,
            };
            return { ...event, ...(by !== undefined ? { by } : {}) };
        }
        return undefined;
    },
});
/**
 * Extend a vocabulary additively: later entries win on a key clash, so an author can either register a
 * brand-new kind or deliberately override a core decoder. Returns a NEW frozen vocab — neither input is
 * mutated — so the core stays canonical. (Cribbed from dsh's merge-extensible taxonomy / the S3
 * `mergeVocab`: one schema, extended by merge, never a second parser.)
 */
export function mergeTranscriptVocab(base, ...extensions) {
    return Object.freeze(Object.assign({}, base, ...extensions));
}
/**
 * THE ONE PARSER. Classify a single stored chunk into a typed {@link TranscriptEvent}.
 *
 * A chunk is decoded as a structured event ONLY when it is a JSON object carrying the
 * {@link TRANSCRIPT_EVENT_MARKER} at the current version AND a `kind` the vocab knows AND its decoder
 * accepts the body. Anything else — raw terminal bytes, non-JSON, a JSON value without the marker, an
 * unknown kind, a decoder rejection — is retained verbatim as a `stream-chunk`, so byte-level replay
 * fidelity is never lost. This is the SINGLE point at which raw bytes become typed events; every view
 * folds over the result of this function, so there is exactly one parser of the log.
 */
export function parseTranscriptEvent(entry, vocab = CORE_TRANSCRIPT_VOCAB) {
    const raw = { kind: "stream-chunk", offset: entry.offset, chunk: entry.chunk };
    const body = decodeEnvelope(entry.chunk);
    if (body === undefined)
        return raw;
    const kind = typeof body.kind === "string" ? body.kind : undefined;
    if (kind === undefined)
        return raw;
    const decoder = vocab[kind];
    if (decoder === undefined)
        return raw;
    return decoder(body, entry.offset) ?? raw;
}
/**
 * Decode a chunk into a marker-tagged envelope body, or `undefined` when it is not one. Kept private
 * so `JSON.parse` of a chunk lives in exactly one place (the drift-guard depends on this).
 */
function decodeEnvelope(chunk) {
    // Cheap reject before the parse: a valid envelope is a JSON object mentioning the marker key.
    const trimmed = chunk.trimStart();
    if (!trimmed.startsWith("{") || !chunk.includes(TRANSCRIPT_EVENT_MARKER))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(chunk);
    }
    catch {
        return undefined;
    }
    if (!isRecord(parsed))
        return undefined;
    return parsed[TRANSCRIPT_EVENT_MARKER] === TRANSCRIPT_EVENT_VERSION ? parsed : undefined;
}
/**
 * Encode a typed event into the stored-chunk wire form a structured producer appends. The inverse of
 * {@link parseTranscriptEvent} for every non-raw kind (a `stream-chunk` is stored as its own raw bytes,
 * so it is returned verbatim). Provided so producers and tests speak the one envelope grammar rather
 * than hand-rolling the marker — the derivation-over-duplication rule applied to the write side too.
 */
export function encodeTranscriptEvent(event) {
    if (event.kind === "stream-chunk")
        return event.chunk;
    const { offset: _offset, ...rest } = event;
    return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, ...rest });
}
/**
 * THE SINGLE FOLD. Derive every higher-level view from the typed event log — "the log IS the state".
 *
 * Folds the events (assumed in offset order — the store's append order) into per-turn structure, a flat
 * message history, tool cards (each call paired to its result by `callId`, else the most recent open
 * call), raw-byte accounting for replay fidelity, and the session lifecycle. It is a pure reduction of
 * one log: the cockpit, search, token accounting and export all read THIS, so there is never a second
 * parser of the same bytes. Content that precedes the first explicit `turn` event opens an implicit
 * turn 0, so a producer that never emits turn boundaries still derives a coherent single-turn view.
 */
export function deriveView(events) {
    const turns = [];
    const messages = [];
    const tools = [];
    const permissions = [];
    const openTools = new Map();
    let anonymousTool;
    const openPermissions = new Map();
    let rawByteLength = 0;
    let rawChunkCount = 0;
    let lifecycle = "open";
    let eventCount = 0;
    let current;
    const ensureTurn = (offset) => {
        if (current === undefined) {
            current = { index: turns.length, startOffset: offset, messages: [], tools: [], permissions: [], steps: 0 };
            turns.push(current);
        }
        return current;
    };
    for (const event of events) {
        eventCount++;
        switch (event.kind) {
            case "turn": {
                current = {
                    index: event.index ?? turns.length,
                    startOffset: event.offset,
                    messages: [],
                    tools: [],
                    permissions: [],
                    steps: 0,
                };
                turns.push(current);
                break;
            }
            case "step": {
                ensureTurn(event.offset).steps++;
                break;
            }
            case "message": {
                const msg = { role: event.role, text: event.text, offset: event.offset };
                messages.push(msg);
                ensureTurn(event.offset).messages.push(msg);
                break;
            }
            case "tool-call": {
                const tool = {
                    name: event.name,
                    offset: event.offset,
                    ...(event.callId !== undefined ? { callId: event.callId } : {}),
                    ...(event.args !== undefined ? { args: event.args } : {}),
                };
                tools.push(tool);
                ensureTurn(event.offset).tools.push(tool);
                if (event.callId !== undefined)
                    openTools.set(event.callId, tool);
                else
                    anonymousTool = tool;
                break;
            }
            case "tool-result": {
                const target = event.callId !== undefined ? openTools.get(event.callId) : anonymousTool;
                if (target !== undefined) {
                    pairResult(tools, target, event);
                    pairResultInTurns(turns, target, event);
                    if (event.callId !== undefined)
                        openTools.delete(event.callId);
                    else
                        anonymousTool = undefined;
                }
                break;
            }
            case "permission": {
                // A `permission` event is one of two phases (same discriminant `kind`); branch on `phase`. A
                // REQUEST opens a pending DerivedPermission (paired to its turn); a RESOLUTION folds back into
                // the open request by `callId` — mirroring the tool-call/tool-result open-map pairing above.
                if (event.phase === "request") {
                    const permission = {
                        policy: event.policy,
                        options: event.options,
                        offset: event.offset,
                        callId: event.callId,
                        ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
                        ...(event.title !== undefined ? { title: event.title } : {}),
                        ...(event.reason !== undefined ? { reason: event.reason } : {}),
                    };
                    permissions.push(permission);
                    ensureTurn(event.offset).permissions.push(permission);
                    openPermissions.set(event.callId, permission);
                }
                else {
                    const target = openPermissions.get(event.callId);
                    if (target !== undefined) {
                        pairResolution(permissions, target, event);
                        pairResolutionInTurns(turns, target, event);
                        openPermissions.delete(event.callId);
                    }
                }
                break;
            }
            case "lifecycle": {
                lifecycle = event.phase;
                break;
            }
            case "stream-chunk": {
                rawByteLength += utf8ByteLength(event.chunk);
                rawChunkCount++;
                break;
            }
        }
    }
    return {
        turns: turns.map((t) => ({
            index: t.index,
            startOffset: t.startOffset,
            messages: t.messages,
            tools: t.tools,
            permissions: t.permissions,
            steps: t.steps,
        })),
        messages,
        tools,
        permissions,
        rawByteLength,
        rawChunkCount,
        lifecycle,
        eventCount,
    };
}
/** Replace a pending tool with its result in the flat list. A pending tool starts as the same object in
 * both the flat list and its turn (pushed by reference), so {@link pairResultInTurns} locates it there by
 * identity; each list is then replaced independently with its own resolved copy via {@link withResult}. */
function pairResult(list, target, result) {
    const idx = list.indexOf(target);
    if (idx >= 0)
        list[idx] = withResult(target, result);
}
/** Replace a pending tool with its result inside whichever turn holds it. */
function pairResultInTurns(turns, target, result) {
    for (const turn of turns) {
        const idx = turn.tools.indexOf(target);
        if (idx >= 0) {
            turn.tools[idx] = withResult(target, result);
            return;
        }
    }
}
function withResult(tool, result) {
    return {
        ...tool,
        result: { ok: result.ok, offset: result.offset, ...(result.content !== undefined ? { content: result.content } : {}) },
    };
}
/** Replace a pending permission with its resolution in the flat list (by identity — see {@link pairResult}). */
function pairResolution(list, target, resolution) {
    const idx = list.indexOf(target);
    if (idx >= 0)
        list[idx] = withResolution(target, resolution);
}
/** Replace a pending permission with its resolution inside whichever turn holds it. */
function pairResolutionInTurns(turns, target, resolution) {
    for (const turn of turns) {
        const idx = turn.permissions.indexOf(target);
        if (idx >= 0) {
            turn.permissions[idx] = withResolution(target, resolution);
            return;
        }
    }
}
function withResolution(permission, resolution) {
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
/**
 * Convenience: parse a run of stored chunks into typed events through {@link parseTranscriptEvent} (the
 * one parser) and fold them with {@link deriveView} in a single call — the entry point a consumer uses
 * to go from stored bytes to a derived view without ever touching a second parser.
 */
export function deriveViewFromChunks(chunks, vocab = CORE_TRANSCRIPT_VOCAB) {
    function* parsed() {
        for (const entry of chunks)
            yield parseTranscriptEvent(entry, vocab);
    }
    return deriveView(parsed());
}
