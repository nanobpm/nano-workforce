// Focused unit tests for the transcript READ projection's since/until time-bounding (#222 read path).
//
// The operation-level suite (operations/listAgenticTranscripts.test.ts) proves the projection and the
// jobKey/plan filters end-to-end and that a malformed since/until 400s. This file pins the createdAt
// time-window semantics directly on listTranscripts() — inclusive boundaries, ordering, and the
// interaction with a missing/invalid createdAt — where a hand-built store lets us fix exact timestamps.
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb, TranscriptRing, TranscriptStore, TranscriptStream } from "@nanobpm/agentic/transcript";
import { assert, assertEquals } from "#test-assert";
import { AgenticCorrelationStore } from "./correlation-store.ts";
import { correlationFieldsFor, listTranscripts, readTranscriptFrom } from "./transcript-read.ts";

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

function memoryStore(): SqliteDb {
  const raw = new DatabaseSync(":memory:");
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] =>
      raw.prepare(sql).all(...params) as T[],
  };
}

test("durable fallback: a released (past) job is attributed from the durable store when the live registry is empty", () => {
  // The exact past-session case: the live correlation registry no longer holds the job (undefined here),
  // so worker attribution + context must come from the durable store recorded at completion.
  const durable = new AgenticCorrelationStore(memoryStore());
  durable.record({
    jobKey: "k1",
    stream: "job:k1",
    instance: "worker-A",
    identity: "gpu-box-7",
    host: "us-east-1a",
    processInstanceKey: "pi-9",
    planKey: "acme/repo#42",
    completedAt: mid,
  });

  const fields = correlationFieldsFor("job:k1", undefined, durable);
  assertEquals(fields.jobKey, "k1");
  assertEquals(fields.instance, "worker-A");
  assertEquals(fields.identity, "gpu-box-7");
  assertEquals(fields.host, "us-east-1a");
  assertEquals(fields.processInstanceKey, "pi-9");
  assertEquals(fields.planKey, "acme/repo#42");
});

test("listTranscripts: the instance filter returns only sessions the durable store attributes to that worker", () => {
  const store = fakeStore([meta("job:k1", early), meta("job:k2", mid), meta("job:k3", late)]);
  const durable = new AgenticCorrelationStore(memoryStore());
  durable.record({ jobKey: "k1", stream: "job:k1", instance: "worker-A", completedAt: early });
  durable.record({ jobKey: "k2", stream: "job:k2", instance: "worker-B", completedAt: mid });
  durable.record({ jobKey: "k3", stream: "job:k3", instance: "worker-A", completedAt: late });

  const out = listTranscripts(store, undefined, { instance: "worker-A" }, durable);
  assertEquals(
    out.map((t) => t.stream),
    ["job:k3", "job:k1"],
    "only worker-A's sessions, newest-first",
  );
  assert(out.every((t) => t.instance === "worker-A"), "each row is attributed to worker-A");
});

// --- #486: the still-live-ring read fallback that makes a freshly-emitted transcriptUrl readable ---
//
// A multiplexing worker relays every job over one long-lived connection and only flushes a job's ring
// to the durable store when it disconnects or a NEW job supersedes it — NOT when the job completes. In
// the window between "job completed (transcriptUrl emitted)" and that flush, the durable store has no
// row, so the transcript endpoint must serve the live ring or it would 404 the URL it just emitted.

/** A minimal live ring double satisfying {@link TranscriptRing}: the whole retained window from `from`. */
function fakeRing(entries: { offset: number; chunk: string }[]): TranscriptRing {
  const nextOffset = entries.length === 0 ? 0 : entries[entries.length - 1].offset + 1;
  return {
    since: (from: number) => ({ entries: entries.filter((e) => e.offset >= from) }),
    nextOffset,
  };
}

/** A store double whose `get` returns a seeded row (or undefined), with the matching `since` window. */
function getStore(row: TranscriptStream | undefined, entries: { offset: number; chunk: string }[] = []): TranscriptStore {
  return {
    get: (_stream: string) => row,
    since: (_stream: string, from: number) => ({
      entries: entries.filter((e) => e.offset >= from),
      gap: false,
      nextOffset: row?.nextOffset ?? 0,
    }),
  } as unknown as TranscriptStore;
}

test("readTranscriptFrom: falls back to the live ring when the durable store has no row (#486)", () => {
  const ring = fakeRing([
    { offset: 0, chunk: "hello " },
    { offset: 1, chunk: "world" },
  ]);
  const out = readTranscriptFrom("job:live1", 0, getStore(undefined), undefined, undefined, {
    ring,
    createdAt: mid,
  });
  assert(out !== undefined, "a live-but-unflushed stream is readable, not a 404");
  assertEquals(out.status, "open", "an unflushed live stream reads as open");
  assertEquals(out.lifecycle, "ephemeral");
  assertEquals(out.createdAt, mid);
  assertEquals(out.nextOffset, 2);
  assertEquals(out.chunkCount, 2);
  assertEquals(
    out.entries.map((e) => e.chunk).join(""),
    "hello world",
    "the captured bytes are served straight from the ring",
  );
  assertEquals(out.jobKey, "live1", "the jobKey is still decoded from the stream id");
});

test("readTranscriptFrom: the live-ring fallback honours the resume-from offset", () => {
  const ring = fakeRing([
    { offset: 0, chunk: "a" },
    { offset: 1, chunk: "b" },
    { offset: 2, chunk: "c" },
  ]);
  const out = readTranscriptFrom("job:live2", 2, getStore(undefined), undefined, undefined, { ring, createdAt: mid });
  assert(out !== undefined);
  assertEquals(out.from, 2);
  assertEquals(
    out.entries.map((e) => e.chunk).join(""),
    "c",
    "only chunks at/after the requested offset are replayed",
  );
});

test("readTranscriptFrom: prefers the durable store once the ring has been flushed", () => {
  const row: TranscriptStream = {
    stream: "job:flushed",
    lifecycle: "ephemeral",
    status: "completed",
    createdAt: early,
    completedAt: late,
    nextOffset: 1,
  };
  const store = getStore(row, [{ offset: 0, chunk: "durable" }]);
  // A live ring is ALSO provided, but the flushed durable row wins (it is the source of truth once flushed).
  const out = readTranscriptFrom("job:flushed", 0, store, undefined, undefined, {
    ring: fakeRing([{ offset: 0, chunk: "stale-ring" }]),
    createdAt: mid,
  });
  assert(out !== undefined);
  assertEquals(out.status, "completed", "the flushed durable row is served, not the live ring");
  assertEquals(out.completedAt, late);
  assertEquals(out.entries.map((e) => e.chunk).join(""), "durable");
});

test("readTranscriptFrom: returns undefined when neither the store nor a live ring has the stream", () => {
  const out = readTranscriptFrom("job:gone", 0, getStore(undefined), undefined, undefined, undefined);
  assertEquals(out, undefined);
});
