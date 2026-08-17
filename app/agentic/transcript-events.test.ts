// Unit tests for the typed transcript-event vocabulary + the single derive() fold (#251).
//
// Pins: the ONE parser classifies raw bytes vs typed envelopes (raw fidelity preserved), the core
// vocabulary decodes each kind, merge-extensibility adds/overrides kinds without a second parser,
// encode↔parse round-trips, and deriveView folds the log into per-turn structure / message history /
// tool cards / raw-byte accounting / lifecycle — "the log IS the state".
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  CORE_TRANSCRIPT_VOCAB,
  deriveView,
  deriveViewFromChunks,
  encodeTranscriptEvent,
  mergeTranscriptVocab,
  parseTranscriptEvent,
  type TranscriptEvent,
  TRANSCRIPT_EVENT_MARKER,
  TRANSCRIPT_EVENT_VERSION,
} from "./transcript-events.ts";

function env(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, kind, ...extra });
}

test("parseTranscriptEvent: raw terminal bytes are retained verbatim as a stream-chunk", () => {
  const event = parseTranscriptEvent({ offset: 3, chunk: "\u001b[32mok\u001b[0m\r\n" });
  assertEquals(event, { kind: "stream-chunk", offset: 3, chunk: "\u001b[32mok\u001b[0m\r\n" });
});

test("parseTranscriptEvent: JSON without the marker is NOT mis-classified — stays a raw chunk", () => {
  const chunk = JSON.stringify({ kind: "message", text: "hi" }); // no marker → raw
  const event = parseTranscriptEvent({ offset: 0, chunk });
  assertEquals(event.kind, "stream-chunk");
});

test("parseTranscriptEvent: a marker envelope with an unknown kind falls back to raw", () => {
  const event = parseTranscriptEvent({ offset: 0, chunk: env("no-such-kind", { foo: 1 }) });
  assertEquals(event.kind, "stream-chunk");
});

test("parseTranscriptEvent: malformed JSON carrying the marker text falls back to raw", () => {
  const event = parseTranscriptEvent({ offset: 0, chunk: `{"${TRANSCRIPT_EVENT_MARKER}":1, broken` });
  assertEquals(event.kind, "stream-chunk");
});

test("core vocab decodes message with role (default assistant)", () => {
  assertEquals(parseTranscriptEvent({ offset: 1, chunk: env("message", { text: "hello" }) }), {
    kind: "message",
    offset: 1,
    role: "assistant",
    text: "hello",
  });
  assertEquals(parseTranscriptEvent({ offset: 2, chunk: env("message", { role: "user", text: "hi" }) }), {
    kind: "message",
    offset: 2,
    role: "user",
    text: "hi",
  });
});

test("core vocab: a message envelope missing text is rejected → raw fallback", () => {
  assertEquals(parseTranscriptEvent({ offset: 0, chunk: env("message", { role: "user" }) }).kind, "stream-chunk");
});

test("core vocab decodes tool-call / tool-result / turn / step / lifecycle", () => {
  assertEquals(parseTranscriptEvent({ offset: 1, chunk: env("tool-call", { name: "grep", callId: "c1", args: { q: "x" } }) }), {
    kind: "tool-call",
    offset: 1,
    name: "grep",
    callId: "c1",
    args: { q: "x" },
  });
  assertEquals(parseTranscriptEvent({ offset: 2, chunk: env("tool-result", { callId: "c1", ok: true, content: "found" }) }), {
    kind: "tool-result",
    offset: 2,
    ok: true,
    callId: "c1",
    content: "found",
  });
  assertEquals(parseTranscriptEvent({ offset: 3, chunk: env("turn", { index: 4 }) }), { kind: "turn", offset: 3, index: 4 });
  assertEquals(parseTranscriptEvent({ offset: 4, chunk: env("step", { label: "loop" }) }), { kind: "step", offset: 4, label: "loop" });
  assertEquals(parseTranscriptEvent({ offset: 5, chunk: env("lifecycle", { phase: "completed" }) }), {
    kind: "lifecycle",
    offset: 5,
    phase: "completed",
  });
});

test("mergeTranscriptVocab: adds a new kind without forking the parser, and can override a core one", () => {
  const vocab = mergeTranscriptVocab(CORE_TRANSCRIPT_VOCAB, {
    // A brand new merge-extensible kind, decoded into a message so deriveView still folds it.
    reasoning: (body, offset) => ({ kind: "message", offset, role: "system", text: String(body.text ?? "") }),
  });
  const event = parseTranscriptEvent({ offset: 7, chunk: env("reasoning", { text: "thinking" }) }, vocab);
  assertEquals(event, { kind: "message", offset: 7, role: "system", text: "thinking" });
  // The core vocab is unchanged (merge returns a new object).
  assertEquals(parseTranscriptEvent({ offset: 7, chunk: env("reasoning", { text: "thinking" }) }).kind, "stream-chunk");
});

test("encodeTranscriptEvent round-trips every non-raw kind through the one parser", () => {
  const events: TranscriptEvent[] = [
    { kind: "message", offset: 0, role: "assistant", text: "hi" },
    { kind: "tool-call", offset: 1, name: "ls", callId: "c1" },
    { kind: "tool-result", offset: 2, ok: false, callId: "c1", content: "boom" },
    { kind: "turn", offset: 3, index: 1 },
    { kind: "step", offset: 4, label: "s" },
    { kind: "lifecycle", offset: 5, phase: "exited" },
  ];
  for (const original of events) {
    const chunk = encodeTranscriptEvent(original);
    assertEquals(parseTranscriptEvent({ offset: original.offset, chunk }), original);
  }
});

test("encodeTranscriptEvent returns raw bytes verbatim for a stream-chunk", () => {
  assertEquals(encodeTranscriptEvent({ kind: "stream-chunk", offset: 0, chunk: "raw" }), "raw");
});

test("deriveView: folds messages + tool cards into per-turn structure with lifecycle", () => {
  const events: TranscriptEvent[] = [
    { kind: "turn", offset: 0, index: 0 },
    { kind: "message", offset: 1, role: "user", text: "do it" },
    { kind: "step", offset: 2 },
    { kind: "tool-call", offset: 3, name: "grep", callId: "c1" },
    { kind: "tool-result", offset: 4, ok: true, callId: "c1", content: "hit" },
    { kind: "message", offset: 5, role: "assistant", text: "done" },
    { kind: "turn", offset: 6, index: 1 },
    { kind: "message", offset: 7, role: "assistant", text: "next" },
    { kind: "stream-chunk", offset: 8, chunk: "raw-bytes" },
    { kind: "lifecycle", offset: 9, phase: "completed" },
  ];
  const view = deriveView(events);
  assertEquals(view.turns.length, 2);
  assertEquals(view.turns[0]?.messages.map((m) => m.text), ["do it", "done"]);
  assertEquals(view.turns[0]?.steps, 1);
  assertEquals(view.turns[0]?.tools.length, 1);
  assertEquals(view.turns[0]?.tools[0]?.result, { ok: true, offset: 4, content: "hit" });
  assertEquals(view.turns[1]?.messages.map((m) => m.text), ["next"]);
  assertEquals(view.messages.length, 3);
  assertEquals(view.tools.length, 1);
  assertEquals(view.lifecycle, "completed");
  assertEquals(view.rawChunkCount, 1);
  assertEquals(view.rawByteLength, Buffer.byteLength("raw-bytes", "utf8"));
  assertEquals(view.eventCount, 10);
});

test("deriveView: content before any turn event opens an implicit turn 0", () => {
  const view = deriveView([
    { kind: "message", offset: 0, role: "assistant", text: "hello" },
    { kind: "tool-call", offset: 1, name: "ls" },
  ]);
  assertEquals(view.turns.length, 1);
  assertEquals(view.turns[0]?.index, 0);
  assertEquals(view.turns[0]?.messages.length, 1);
  assertEquals(view.turns[0]?.tools.length, 1);
});

test("deriveView: an anonymous tool-result pairs with the most recent open anonymous call", () => {
  const view = deriveView([
    { kind: "tool-call", offset: 0, name: "a" },
    { kind: "tool-result", offset: 1, ok: false, content: "nope" },
  ]);
  assertEquals(view.tools[0]?.result, { ok: false, offset: 1, content: "nope" });
});

test("deriveViewFromChunks: an all-raw log derives no structure but full raw fidelity accounting", () => {
  const view = deriveViewFromChunks([
    { offset: 0, chunk: "line-1\n" },
    { offset: 1, chunk: "line-2\n" },
  ]);
  assertEquals(view.turns.length, 0);
  assertEquals(view.messages.length, 0);
  assertEquals(view.rawChunkCount, 2);
  assert(view.rawByteLength > 0);
});

test("deriveViewFromChunks: a mixed log derives typed structure while retaining raw chunks", () => {
  const view = deriveViewFromChunks([
    { offset: 0, chunk: env("turn", { index: 0 }) },
    { offset: 1, chunk: "\u001b[2Jraw frame" },
    { offset: 2, chunk: env("message", { role: "assistant", text: "hi" }) },
  ]);
  assertEquals(view.turns.length, 1);
  assertEquals(view.messages.map((m) => m.text), ["hi"]);
  assertEquals(view.rawChunkCount, 1);
});
