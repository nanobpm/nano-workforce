// Unit tests for the cockpit STRUCTURED transcript view derived from the one fold (#251).
//
// Proves the cockpit's structured view is a DERIVATION of the typed event log (message history, tool
// cards, per-turn boundaries), and that raw chunks are preserved in the fidelity footer — the byte
// replay is not lost. It renders into the in-memory DOM double, no browser.
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
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

// A minimal single-page report of the given entries (offsets assigned in order).
function page(chunks: readonly string[], stream = "job:x"): TranscriptDataReport {
  return { stream, from: 0, gap: false, nextOffset: chunks.length, entries: chunks.map((chunk, offset) => ({ offset, chunk })) };
}

test("a tool card renders its args and result content", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(
    host,
    doc,
    page([
      env("tool-call", { name: "read", callId: "c1", args: { path: "README.md" } }),
      env("tool-result", { callId: "c1", ok: true, content: "file contents here" }),
    ]),
  );
  const card = host.byData("tool", "read")[0];
  assertEquals(card?.getAttribute("data-status"), "ok");
  assertEquals(card?.getAttribute("data-tool-kind"), undefined); // not a diff
  const argsEl = host.byData("tool-args", "true")[0];
  assertStringIncludes(argsEl?.textContent ?? "", "README.md");
  const resultEl = host.byData("tool-result", "true")[0];
  assertEquals(resultEl?.textContent, "file contents here");
});

test("a diff tool renders a cockpit-transcript-diff block with per-line add/del/ctx markers", () => {
  const host = new FakeElement("div");
  const unified = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged\n";
  renderDerivedTranscript(
    host,
    doc,
    page([
      env("tool-call", { name: "edit", callId: "d1" }),
      env("tool-result", { callId: "d1", ok: true, content: unified }),
    ]),
  );
  const card = host.byData("tool", "edit")[0];
  assertEquals(card?.getAttribute("data-tool-kind"), "diff");
  assertEquals(host.byClass("cockpit-transcript-diff").length, 1);
  assertEquals(host.byData("diff-line", "add").length, 1);
  assertEquals(host.byData("diff-line", "del").length, 1);
  assert(host.byData("diff-line", "ctx").length >= 1, "the hunk/header/context lines are marked ctx");
  // The diff replaces the plain result rendering — no raw result <pre> for a diff tool.
  assertEquals(host.byData("tool-result", "true").length, 0);
});

test("structured edit args (path + old/new text) render as a synthesized diff", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(
    host,
    doc,
    page([env("tool-call", { name: "write", callId: "s1", args: { path: "a.txt", oldText: "one\ntwo", newText: "one\nTWO" } })]),
  );
  const card = host.byData("tool", "write")[0];
  assertEquals(card?.getAttribute("data-tool-kind"), "diff");
  assertEquals(host.byData("diff-line", "del").length, 2);
  assertEquals(host.byData("diff-line", "add").length, 2);
  // The diff was synthesized FROM args, so the raw args <pre> is not ALSO rendered.
  assertEquals(host.byData("tool-args", "true").length, 0);
});

test("a pending escalate permission renders Allow/Deny buttons that invoke onPermissionResolve", () => {
  const host = new FakeElement("div");
  const calls: Array<{ callId: string; optionId: string; allowed: boolean }> = [];
  renderDerivedTranscript(
    host,
    doc,
    page([
      env("permission", {
        phase: "request",
        callId: "p1",
        policy: "escalate",
        title: "Run a shell command?",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow-once" },
          { optionId: "deny", name: "Deny", kind: "reject-once" },
        ],
      }),
    ]),
    { onPermissionResolve: (resolution) => calls.push(resolution) },
  );
  const card = host.byData("permission", "request")[0];
  assertEquals(card?.getAttribute("data-policy"), "escalate");
  assertEquals(card?.getAttribute("data-status"), "pending");
  assertEquals(card?.getAttribute("data-call-id"), "p1");
  const buttons = host.byClass("cockpit-transcript-permission-option");
  assertEquals(buttons.length, 2);

  buttons.find((b) => b.getAttribute("data-option-id") === "allow")?.dispatch("click");
  buttons.find((b) => b.getAttribute("data-option-id") === "deny")?.dispatch("click");
  assertEquals(calls, [
    { callId: "p1", optionId: "allow", allowed: true },
    { callId: "p1", optionId: "deny", allowed: false },
  ]);
});

test("a yolo permission request renders informational only — no Allow/Deny buttons", () => {
  const host = new FakeElement("div");
  const calls: unknown[] = [];
  renderDerivedTranscript(
    host,
    doc,
    page([
      env("permission", {
        phase: "request",
        callId: "y1",
        policy: "yolo",
        options: [{ optionId: "allow", name: "Allow", kind: "allow-always" }],
      }),
    ]),
    { onPermissionResolve: (resolution) => calls.push(resolution) },
  );
  const card = host.byData("permission", "request")[0];
  assertEquals(card?.getAttribute("data-policy"), "yolo");
  assertEquals(card?.getAttribute("data-status"), "auto");
  assertEquals(host.byClass("cockpit-transcript-permission-option").length, 0);
  assertEquals(calls.length, 0);
});

test("a resolved permission renders settled (allowed/denied) with the chosen option and no live buttons", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(
    host,
    doc,
    page([
      env("permission", {
        phase: "request",
        callId: "r1",
        policy: "escalate",
        title: "Delete the file?",
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow-once" },
          { optionId: "deny", name: "Deny", kind: "reject-once" },
        ],
      }),
      env("permission", { phase: "resolution", callId: "r1", optionId: "deny", allowed: false, by: "operator" }),
    ]),
  );
  const card = host.byData("permission", "request")[0];
  assertEquals(card?.getAttribute("data-status"), "denied");
  const settled = host.byClass("cockpit-transcript-permission-settled")[0];
  assertEquals(settled?.getAttribute("data-chosen-option"), "deny");
  assertEquals(settled?.textContent, "Deny");
  assertEquals(host.byClass("cockpit-transcript-permission-option").length, 0);
});

test("the existing 3-arg renderDerivedTranscript(host, doc, data) call still works (options optional)", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(host, doc, report());
  assertEquals(host.byData("turn-count", "1").length, 1);
  assertEquals(host.byData("permission-count", "0").length, 1);
});
