// #757 — the cockpit renders ONE coherent, growing message block per logical message, with tool cards
// and permission prompts interleaved in chronological order — driven through the REAL published display
// projection (agentic #566) and the REAL codec (`encodeTranscriptEvent`), never a hand-invented mock.
//
// These are the red-first acceptance tests for the streaming-block render: they prove
//   - split-word deltas reconstruct byte-exact into ONE block (never one bordered card per delta),
//   - distinct messages stay distinct when producer metadata (messageId) exists,
//   - text / tool / permission order is chronological (a tool issued mid-conversation renders between),
//   - the legacy fallback (no boundary metadata) coalesces adjacent same-speaker deltas,
//   - a snapshot REPLACES (never doubles) accumulated text,
//   - replay / reconnect / duplicate offsets never double text (idempotent on offset),
//   - a retention gap stays a visible break that prevents false continuity,
//   - live incremental growth patches the SAME node in place (selection/expansion survive), and
//   - historical batch rendering is identical to the final live rendering.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { FakeDocument, FakeElement } from "../../../test/agentic-cockpit-doubles.ts";
import { type TranscriptEvent, encodeTranscriptEvent } from "../transcript-events.ts";
import { createIncrementalTranscript, renderDerivedTranscript } from "./transcript-derive.ts";
import type { TranscriptDataReport } from "./transcript-render.ts";

const doc = new FakeDocument();

/** Encode a typed event through the REAL published codec — the exact wire form a structured producer
 *  appends (the inverse of the one parser). Using it here is the integration guarantee: these fixtures
 *  ride the real @nanobpm/agentic envelope grammar, not a hand-rolled marker. */
function enc(event: TranscriptEvent): { offset: number; chunk: string } {
  return { offset: event.offset, chunk: encodeTranscriptEvent(event) };
}

/** A single-page report over the given stored chunks (offsets already assigned). */
function report(entries: Array<{ offset: number; chunk: string }>): TranscriptDataReport {
  return { stream: "job:757", from: 0, gap: false, nextOffset: entries.length, entries };
}

/** The ordered block class names under the blocks container — the human-facing top-to-bottom sequence. */
function blockOrder(host: FakeElement): string[] {
  return host.byClass("cockpit-transcript-blocks")[0]?.children.map((n) => n.className) ?? [];
}

/** The text-block nodes (one per logical message) with their reconstructed text + role. */
function messages(host: FakeElement): Array<{ role: string | undefined; text: string }> {
  return host.byClass("cockpit-transcript-message").map((n) => ({ role: n.getAttribute("data-role"), text: n.textContent ?? "" }));
}

test("#757 split-word deltas reconstruct byte-exact into ONE block — never one card per delta", () => {
  // The screenshot-equivalent failure: a single logical message arrives as fragments that spell words
  // ("No", "tice", " I am ", …). The bug rendered one bordered card per fragment; the fix coalesces.
  const deltas = ["No", "tice", " I am ", "act", "ually", " here."];
  const entries = deltas.map((text, i) => enc({ kind: "message", offset: i, role: "assistant", messageId: "m1", text }));
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report(entries));

  const msgs = messages(host);
  assertEquals(msgs.length, 1, "the six fragments fold into exactly ONE message block, not six cards");
  assertEquals(msgs[0]?.text, "Notice I am actually here.");
  assertEquals(msgs[0]?.role, "assistant");
});

test("#757 distinct messages with distinct messageId stay separate blocks", () => {
  const entries = [
    enc({ kind: "message", offset: 0, role: "assistant", messageId: "m1", text: "hello " }),
    enc({ kind: "message", offset: 1, role: "assistant", messageId: "m1", text: "world" }),
    enc({ kind: "message", offset: 2, role: "assistant", messageId: "m2", text: "second message" }),
  ];
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report(entries));
  assertEquals(
    messages(host).map((m) => m.text),
    ["hello world", "second message"],
  );
});

test("#757 chronological order: a tool issued mid-conversation renders BETWEEN the text before and after", () => {
  const entries = [
    enc({ kind: "message", offset: 0, role: "assistant", messageId: "m1", text: "let me look" }),
    enc({ kind: "tool-call", offset: 1, name: "grep", callId: "c1", args: { pattern: "x" } }),
    enc({ kind: "tool-result", offset: 2, callId: "c1", ok: true, content: "hit" }),
    enc({ kind: "message", offset: 3, role: "assistant", messageId: "m2", text: "found it" }),
    enc({
      kind: "permission",
      offset: 4,
      phase: "request",
      callId: "p1",
      policy: "escalate",
      options: [{ optionId: "ok", name: "Allow", kind: "allow-once" }],
    }),
  ];
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report(entries));
  assertEquals(blockOrder(host), [
    "cockpit-transcript-message",
    "cockpit-transcript-tool",
    "cockpit-transcript-message",
    "cockpit-transcript-permission",
  ]);
  assertEquals(
    messages(host).map((m) => m.text),
    ["let me look", "found it"],
  );
});

test("#757 legacy fallback: no messageId/mode — adjacent same-speaker deltas coalesce, a tool boundary splits", () => {
  const entries = [
    enc({ kind: "message", offset: 0, role: "assistant", text: "a" }),
    enc({ kind: "message", offset: 1, role: "assistant", text: "b" }),
    enc({ kind: "tool-call", offset: 2, name: "read", callId: "c1" }),
    enc({ kind: "message", offset: 3, role: "assistant", text: "c" }),
  ];
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report(entries));
  assertEquals(
    messages(host).map((m) => m.text),
    ["ab", "c"],
  );
  assertEquals(blockOrder(host), ["cockpit-transcript-message", "cockpit-transcript-tool", "cockpit-transcript-message"]);
});

test("#757 a snapshot REPLACES accumulated text (never doubled as a delta)", () => {
  const entries = [
    enc({ kind: "message", offset: 0, role: "assistant", messageId: "m1", text: "Hel" }),
    enc({ kind: "message", offset: 1, role: "assistant", messageId: "m1", mode: "snapshot", text: "Hello world" }),
  ];
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report(entries));
  assertEquals(messages(host)[0]?.text, "Hello world");
});

test("#757 replay/duplicate: re-feeding already-applied offsets never doubles text (idempotent on offset)", () => {
  const host = new FakeElement("div");
  const t = createIncrementalTranscript(host, doc, "job:757");
  const deltas = [
    enc({ kind: "message", offset: 0, role: "assistant", messageId: "m1", text: "one " }),
    enc({ kind: "message", offset: 1, role: "assistant", messageId: "m1", text: "two" }),
  ];
  for (const d of deltas) t.applyChunk(d);
  // A reconnect re-delivers the same offsets (pagination overlap): applying them again is a no-op.
  for (const d of deltas) t.applyChunk(d);
  assertEquals(messages(host).length, 1);
  assertEquals(messages(host)[0]?.text, "one two");
});

test("#757 a retention gap stays a VISIBLE break and prevents false continuity across the drop", () => {
  const host = new FakeElement("div");
  const t = createIncrementalTranscript(host, doc, "job:757");
  t.applyChunk(enc({ kind: "message", offset: 0, role: "assistant", messageId: "m1", text: "before the gap" }));
  // The consumer resumed from an offset older than the oldest retained chunk — chunks were evicted.
  t.noteGap();
  t.applyChunk(enc({ kind: "message", offset: 10, role: "assistant", messageId: "m2", text: "after the gap" }));

  assertEquals(blockOrder(host), ["cockpit-transcript-message", "cockpit-transcript-gap", "cockpit-transcript-message"]);
  const gapNode = host.byData("gap", "true")[0];
  assert(gapNode !== undefined, "the retention gap renders a visible break");
  // The gap is anchored to the first post-gap block, so the break is placed, not implied-continuous.
  assertEquals(gapNode?.getAttribute("data-before-offset"), "10");
  // The text on either side did NOT merge into one block.
  assertEquals(
    messages(host).map((m) => m.text),
    ["before the gap", "after the gap"],
  );
});

test("#757 live growth patches the SAME node in place — unaffected sibling nodes are never replaced", () => {
  const host = new FakeElement("div");
  const t = createIncrementalTranscript(host, doc, "job:757");
  t.applyChunk(enc({ kind: "message", offset: 0, role: "assistant", messageId: "m1", text: "Hel" }));
  const blocksHost = host.byClass("cockpit-transcript-blocks")[0];
  const textNode = blocksHost?.children[0];
  assert(textNode !== undefined, "the first delta created the text node");

  // A further delta of the SAME message grows the SAME node in place (identity preserved) — this is what
  // lets the browser keep the operator's selection/expansion state across streaming.
  t.applyChunk(enc({ kind: "message", offset: 1, role: "assistant", messageId: "m1", text: "lo there" }));
  assert(blocksHost?.children[0] === textNode, "the delta grew the SAME node, it was not replaced");
  assertEquals(textNode?.textContent, "Hello there");
  assertEquals(blocksHost?.children.length, 1, "no second card was appended for the same message");

  // A later tool call appends a NEW sibling and leaves the original text node object untouched.
  t.applyChunk(enc({ kind: "tool-call", offset: 2, name: "grep", callId: "c1" }));
  assert(blocksHost?.children[0] === textNode, "appending the tool card did not replace the text node");
  assertEquals(textNode?.textContent, "Hello there");
  assertEquals(blocksHost?.children.length, 2);
});

test("#757 a tool result settles the EXISTING tool card in place (no duplicate card)", () => {
  const host = new FakeElement("div");
  const t = createIncrementalTranscript(host, doc, "job:757");
  t.applyChunk(enc({ kind: "tool-call", offset: 0, name: "grep", callId: "c1" }));
  const toolNode = host.byData("tool", "grep")[0];
  assertEquals(toolNode?.getAttribute("data-status"), "pending");
  t.applyChunk(enc({ kind: "tool-result", offset: 1, callId: "c1", ok: true, content: "match" }));
  assertEquals(host.byData("tool", "grep").length, 1, "the result settled the same card — no second card");
  assertEquals(host.byData("tool", "grep")[0]?.getAttribute("data-status"), "ok");
});

test("#757 historical batch render is identical to the final live incremental render", () => {
  const entries = [
    enc({ kind: "message", offset: 0, role: "user", messageId: "u1", text: "please " }),
    enc({ kind: "message", offset: 1, role: "user", messageId: "u1", text: "build it" }),
    enc({ kind: "tool-call", offset: 2, name: "edit", callId: "c1", args: { path: "a.txt", oldText: "one", newText: "two" } }),
    enc({ kind: "tool-result", offset: 3, callId: "c1", ok: true, content: "ok" }),
    enc({ kind: "message", offset: 4, role: "assistant", messageId: "a1", text: "built " }),
    enc({ kind: "message", offset: 5, role: "assistant", messageId: "a1", text: "it" }),
  ];

  // Historical: one batch render of the whole fetched page.
  const past = new FakeElement("div");
  renderDerivedTranscript(past, doc, report(entries));

  // Live: the same chunks fed one at a time (as a relay stream) through the incremental renderer.
  const live = new FakeElement("div");
  const t = createIncrementalTranscript(live, doc, "job:757");
  for (const e of entries) t.applyChunk(e);

  assertEquals(blockOrder(live), blockOrder(past));
  assertEquals(messages(live), messages(past));
  assertEquals(live.text(), past.text(), "final live rendering matches historical rendering exactly");
});

test("#757 an all-raw (unstructured) transcript shows the empty state, and a later block clears it", () => {
  const host = new FakeElement("div");
  const t = createIncrementalTranscript(host, doc, "job:757");
  t.applyChunk({ offset: 0, chunk: "\u001b[2Jraw terminal frame" });
  assertEquals(host.byData("empty", "true").length, 1, "an all-raw page shows the empty note");
  assertEquals(host.byClass("cockpit-transcript-raw")[0]?.getAttribute("data-raw-chunks"), "1");

  // A structured block arriving later clears the empty note WITHOUT rebuilding (toggled, not removed).
  t.applyChunk(enc({ kind: "message", offset: 1, role: "assistant", text: "now structured" }));
  assertEquals(host.byData("empty", "true").length, 0, "the empty note is cleared once a block renders");
  assertEquals(messages(host)[0]?.text, "now structured");
});
