// Unit tests for the cockpit "past sessions" view-model (H3 read path / #222).
//
// Pure projection: a transcript LIST report → the renderable history view. Covers labelling (process
// instance / plan → single label, jobKey/stream fallback), human byte/duration formatting, newest-first
// ordering, and the retention surfacing.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { humanBytes, humanDuration, type TranscriptListReport, transcriptsView } from "./transcript-view.ts";

test("humanBytes renders B / KB / MB compactly", () => {
  assertEquals(humanBytes(0), "0 B");
  assertEquals(humanBytes(512), "512 B");
  assertEquals(humanBytes(2048), "2.0 KB");
  assertEquals(humanBytes(5 * 1024 * 1024), "5.0 MB");
  assertEquals(humanBytes(-1), "0 B");
});

test("humanDuration renders s / m / h / d, undefined for non-positive", () => {
  assertEquals(humanDuration(45_000), "45s");
  assertEquals(humanDuration(30 * 60_000), "30m");
  assertEquals(humanDuration(24 * 60 * 60_000), "24h");
  assertEquals(humanDuration(3 * 24 * 60 * 60_000), "3d");
  assertEquals(humanDuration(undefined), undefined);
  assertEquals(humanDuration(0), undefined);
});

test("projects sessions newest-first with a process/plan label and surfaces retention", () => {
  const report: TranscriptListReport = {
    count: 2,
    retentionMs: 86_400_000,
    transcripts: [
      { stream: "job:1", lifecycle: "ephemeral", status: "completed", createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:05:00Z", nextOffset: 2, byteLength: 2048, chunkCount: 2, jobKey: "1", bpmnProcessId: "plan-fanout", processInstanceKey: "4612", planKey: "o/r#142" },
      { stream: "job:2", lifecycle: "ephemeral", status: "completed", createdAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T00:05:00Z", nextOffset: 1, byteLength: 10, chunkCount: 1, jobKey: "2" },
    ],
  };
  const view = transcriptsView(report);
  assertEquals(view.count, 2);
  assertEquals(view.retention, "24h");
  // Newest capturedAt (job:2, completed 01-02) first.
  assertEquals(view.sessions[0]?.stream, "job:2");
  assertEquals(view.sessions[0]?.label, "job 2", "no engine context → job-key label");
  assertEquals(view.sessions[0]?.size, "10 B");
  assertEquals(view.sessions[1]?.stream, "job:1");
  assertEquals(view.sessions[1]?.label, "plan-fanout · inst 4612 · o/r#142");
  assertEquals(view.sessions[1]?.size, "2.0 KB");
  assertEquals(view.sessions[1]?.capturedAt, "2026-01-01T00:05:00Z");
});

test("falls back to the stream id when neither jobKey nor context is known, and uses createdAt when open", () => {
  const report: TranscriptListReport = {
    count: 1,
    transcripts: [
      { stream: "ctrl:x", lifecycle: "long-lived", status: "open", createdAt: "2026-01-01T00:00:00Z", nextOffset: 3, byteLength: 3, chunkCount: 3 },
    ],
  };
  const view = transcriptsView(report);
  assertEquals(view.sessions[0]?.label, "ctrl:x");
  assertEquals(view.sessions[0]?.status, "open");
  assertEquals(view.sessions[0]?.capturedAt, "2026-01-01T00:00:00Z", "open session uses createdAt");
  assertEquals(view.retention, undefined);
});
