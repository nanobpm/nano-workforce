// Unit tests for the cockpit STRUCTURED transcript view derived from the one fold (#251).
//
// Proves the cockpit's structured view is a DERIVATION of the typed event log (message history, tool
// cards, per-turn boundaries), and that raw chunks are preserved in the fidelity footer — the byte
// replay is not lost. It renders into the in-memory DOM double, no browser.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { FakeDocument, FakeElement } from "../../../test/agentic-cockpit-doubles.ts";
import { TRANSCRIPT_EVENT_MARKER, TRANSCRIPT_EVENT_VERSION } from "../transcript-events.ts";
import { deriveTranscript, renderDerivedTranscript } from "./transcript-derive.ts";
import type { TranscriptDataReport } from "./transcript-render.ts";

const doc = new FakeDocument();

function env(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, kind, ...extra });
}

function report(): TranscriptDataReport {
  return {
    stream: "job:1",
    from: 0,
    gap: false,
    nextOffset: 6,
    entries: [
      { offset: 0, chunk: env("turn", { index: 0 }) },
      { offset: 1, chunk: env("message", { role: "user", text: "please build it" }) },
      { offset: 2, chunk: env("tool-call", { name: "grep", callId: "c1" }) },
      { offset: 3, chunk: env("tool-result", { callId: "c1", ok: true, content: "hit" }) },
      { offset: 4, chunk: "\u001b[2Jraw terminal frame" },
      { offset: 5, chunk: env("message", { role: "assistant", text: "done" }) },
    ],
  };
}

test("deriveTranscript folds the fetched page into structured turns/messages/tools", () => {
  const view = deriveTranscript(report());
  assertEquals(view.turns.length, 1);
  assertEquals(view.messages.map((m) => m.text), ["please build it", "done"]);
  assertEquals(view.tools.length, 1);
  assertEquals(view.tools[0]?.result?.ok, true);
  assertEquals(view.rawChunkCount, 1); // the one raw terminal frame is retained
});

test("renderDerivedTranscript draws a turn section with derived messages and tool cards", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report());
  assertEquals(host.byData("turn-count", "1").length, 1);
  assertEquals(host.byData("message-count", "2").length, 1);
  assertEquals(host.byData("tool-count", "1").length, 1);
  const tool = host.byData("tool", "grep")[0];
  assertEquals(tool?.getAttribute("data-status"), "ok");
  const roles = host.byClass("cockpit-transcript-message").map((n) => n.getAttribute("data-role"));
  assertEquals(roles, ["user", "assistant"]);
});

test("renderDerivedTranscript keeps the raw-fidelity footer so byte replay is visibly preserved", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report());
  const footer = host.byClass("cockpit-transcript-raw")[0];
  assertEquals(footer?.getAttribute("data-raw-chunks"), "1");
});

test("renderDerivedTranscript shows an empty state for an all-raw (unstructured) transcript", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, {
    stream: "job:2",
    from: 0,
    gap: false,
    nextOffset: 2,
    entries: [
      { offset: 0, chunk: "just raw\n" },
      { offset: 1, chunk: "bytes\n" },
    ],
  });
  assertEquals(host.byData("empty", "true").length, 1);
  assertEquals(host.byData("turn-count", "0").length, 1);
});
