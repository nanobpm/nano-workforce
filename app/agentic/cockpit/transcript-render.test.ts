// Unit tests for the cockpit "past sessions" renderer + static-replay helper (H3 read path / #222).
//
// Covers: the history list DOM (rows keyed by stream/status, replay buttons, empty state, active
// highlight), and that replayTranscript feeds a real resume-from-offset TerminalSession so a closed
// stream's stored bytes render faithfully through the SAME renderer a live stream uses.
import { test } from "node:test";
import { TerminalSession } from "@nanobpm/agentic/cockpit";
import { assertEquals } from "#test-assert";
import { FakeDocument, FakeElement } from "../../../test/agentic-cockpit-doubles.ts";
import { renderTranscripts, replayTranscript, type TranscriptDataReport } from "./transcript-render.ts";
import { transcriptsView } from "./transcript-view.ts";

const doc = new FakeDocument();

function view() {
  return transcriptsView({
    count: 2,
    retentionMs: 86_400_000,
    transcripts: [
      { stream: "job:1", lifecycle: "ephemeral", status: "completed", createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:05:00Z", nextOffset: 1, byteLength: 5, chunkCount: 1, jobKey: "1", planKey: "o/r#1" },
      { stream: "job:2", lifecycle: "ephemeral", status: "open", createdAt: "2026-01-02T00:00:00Z", nextOffset: 1, byteLength: 5, chunkCount: 1, jobKey: "2" },
    ],
  });
}

test("renders a past-sessions row per captured session, keyed by stream + status", () => {
  const host = new FakeElement("div");
  renderTranscripts(host, doc, view());
  assertEquals(host.byData("stream", "job:1").length >= 1, true);
  assertEquals(host.byData("stream", "job:2").length >= 1, true);
  assertEquals(host.byData("session-count", "2").length, 1);
  const row1 = host.byData("stream", "job:1").find((n) => n.className.includes("cockpit-past-session"));
  assertEquals(row1?.getAttribute("data-status"), "completed");
});

test("clicking a session's replay button calls onReplay with its stream", () => {
  const host = new FakeElement("div");
  const replayed: string[] = [];
  renderTranscripts(host, doc, view(), { onReplay: (s) => replayed.push(s) });
  const button = host.byClass("cockpit-past-replay").find((b) => b.getAttribute("data-stream") === "job:2");
  button?.dispatch("click");
  assertEquals(replayed, ["job:2"]);
});

test("highlights the active (currently replayed) session", () => {
  const host = new FakeElement("div");
  renderTranscripts(host, doc, view(), { activeStream: "job:1" });
  const active = host.byData("active", "true");
  assertEquals(active.length, 1);
  assertEquals(active[0]?.getAttribute("data-stream"), "job:1");
});

test("renders an empty state when there are no captured sessions", () => {
  const host = new FakeElement("div");
  renderTranscripts(host, doc, transcriptsView({ count: 0, transcripts: [] }));
  assertEquals(host.byData("empty", "true").length, 1);
});

test("replayTranscript feeds a real TerminalSession so stored bytes render in offset order", () => {
  const writes: string[] = [];
  const gaps: number[] = [];
  const data: TranscriptDataReport = {
    stream: "job:9",
    from: 0,
    gap: false,
    nextOffset: 3,
    entries: [
      { offset: 0, chunk: "aa" },
      { offset: 1, chunk: "bb" },
      { offset: 2, chunk: "cc" },
    ],
  };
  const session = new TerminalSession({
    stream: "job:9",
    sink: { write: (c) => writes.push(c) },
    send: () => {},
    from: data.from,
    onGap: () => gaps.push(1),
  });
  const written = replayTranscript(session, data);
  assertEquals(written, 3);
  assertEquals(writes, ["aa", "bb", "cc"]);
  assertEquals(gaps.length, 0);
});

test("replayTranscript resumes from a later offset and reports a retention gap", () => {
  const writes: string[] = [];
  const gaps: number[] = [];
  const data: TranscriptDataReport = {
    stream: "job:9",
    from: 5,
    gap: true,
    nextOffset: 7,
    entries: [
      { offset: 5, chunk: "ee" },
      { offset: 6, chunk: "ff" },
    ],
  };
  const session = new TerminalSession({
    stream: "job:9",
    sink: { write: (c) => writes.push(c) },
    send: () => {},
    from: data.from,
    onGap: () => gaps.push(1),
  });
  const written = replayTranscript(session, data);
  assertEquals(written, 2);
  assertEquals(writes, ["ee", "ff"]);
  assertEquals(gaps.length, 1, "the retention gap in the fetched page is surfaced");
});
