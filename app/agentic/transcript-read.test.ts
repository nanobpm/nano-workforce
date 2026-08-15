// Focused unit tests for the transcript READ projection's since/until time-bounding (#222 read path).
//
// The operation-level suite (operations/listAgenticTranscripts.test.ts) proves the projection and the
// jobKey/plan filters end-to-end and that a malformed since/until 400s. This file pins the createdAt
// time-window semantics directly on listTranscripts() — inclusive boundaries, ordering, and the
// interaction with a missing/invalid createdAt — where a hand-built store lets us fix exact timestamps.
import { test } from "node:test";
import type { TranscriptStore, TranscriptStream } from "@nanobpm/agentic/transcript";
import { assertEquals } from "#test-assert";
import { listTranscripts } from "./transcript-read.ts";

/** A read-only TranscriptStore double: list() returns the seeded metas; read() has no retained chunks. */
function fakeStore(metas: TranscriptStream[]): TranscriptStore {
  return {
    list: () => metas,
    read: () => [],
  } as unknown as TranscriptStore;
}

function meta(stream: string, createdAt: string): TranscriptStream {
  return { stream, lifecycle: "ephemeral", status: "completed", createdAt, nextOffset: 0 };
}

const early = "2026-01-01T00:00:00.000Z";
const mid = "2026-06-15T12:00:00.000Z";
const late = "2026-12-31T23:59:59.000Z";

test("listTranscripts: no since/until returns everything, newest-first", () => {
  const store = fakeStore([meta("job:a", early), meta("job:b", late), meta("job:c", mid)]);
  const out = listTranscripts(store, undefined);
  assertEquals(
    out.map((t) => t.stream),
    ["job:b", "job:c", "job:a"],
  );
});

test("listTranscripts: since is an inclusive lower bound on createdAt", () => {
  const store = fakeStore([meta("job:early", early), meta("job:mid", mid), meta("job:late", late)]);
  // A session created exactly at `since` is retained (inclusive); earlier ones are dropped.
  const out = listTranscripts(store, undefined, { since: mid });
  assertEquals(
    out.map((t) => t.stream),
    ["job:late", "job:mid"],
  );
});

test("listTranscripts: until is an inclusive upper bound on createdAt", () => {
  const store = fakeStore([meta("job:early", early), meta("job:mid", mid), meta("job:late", late)]);
  // A session created exactly at `until` is retained (inclusive); later ones are dropped.
  const out = listTranscripts(store, undefined, { until: mid });
  assertEquals(
    out.map((t) => t.stream),
    ["job:mid", "job:early"],
  );
});

test("listTranscripts: since+until bound a window on both sides (inclusive)", () => {
  const store = fakeStore([meta("job:early", early), meta("job:mid", mid), meta("job:late", late)]);
  const out = listTranscripts(store, undefined, { since: mid, until: mid });
  assertEquals(
    out.map((t) => t.stream),
    ["job:mid"],
  );
});

test("listTranscripts: a session with an unparseable createdAt is retained regardless of the window", () => {
  // Date.parse() of a garbage createdAt is NaN; the guard skips both bounds, so the row is never
  // silently dropped by a time filter (its context is still recoverable from the stream id).
  const store = fakeStore([meta("job:mid", mid), meta("job:bad", "not-a-date")]);
  const out = listTranscripts(store, undefined, { since: late });
  assertEquals(new Set(out.map((t) => t.stream)), new Set(["job:bad"]));
});
