// Unit tests for replay-by-reseed / fork of a transcript log (#251).
//
// Uses a real TranscriptStore over an in-memory node:sqlite db (the same double the relay-family suite
// uses), so the fork is exercised against the store's real idempotent, offset-keyed record/read path.
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { type SqliteDb, TranscriptStore } from "@nanobpm/agentic/transcript";
import { assert, assertEquals, assertThrows } from "#test-assert";
import { forkTranscript, TranscriptForkError } from "./transcript-fork.ts";

/** An in-memory {@link SqliteDb} over `node:sqlite`, matching the store's exec/run/all surface. */
function memoryDb(): SqliteDb {
  const raw = new DatabaseSync(":memory:");
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] => raw.prepare(sql).all(...params) as T[],
  };
}

function seededStore(): TranscriptStore {
  const store = new TranscriptStore(memoryDb());
  store.ensureSchema();
  return store;
}

/** Record chunks c0..c(n-1) into `stream` and complete it (an "exited" ephemeral session). */
function recordExited(store: TranscriptStore, stream: string, n: number): void {
  const entries = Array.from({ length: n }, (_, i) => ({ offset: i, chunk: `c${i}` }));
  store.record(stream, entries, "ephemeral");
  // Complete via a flush of a ring that reports the whole window, marking the stream completed.
  store.flush(stream, { since: () => ({ entries }), nextOffset: n }, "ephemeral");
}

test("forkTranscript: seeds a new stream from the whole source log, offset-parity preserved", () => {
  const store = seededStore();
  recordExited(store, "job:src", 4);

  const result = forkTranscript(store, "job:src", "fork:a");
  assertEquals(result.seeded, 4);
  assertEquals(result.throughOffset, 3);
  assertEquals(result.stream, "fork:a");
  // The fork replays the identical chunks at the identical offsets.
  assertEquals(store.read("fork:a"), [
    { offset: 0, chunk: "c0" },
    { offset: 1, chunk: "c1" },
    { offset: 2, chunk: "c2" },
    { offset: 3, chunk: "c3" },
  ]);
});

test("forkTranscript: throughOffset seeds only the prefix up to (and including) N", () => {
  const store = seededStore();
  recordExited(store, "job:src", 5);

  const result = forkTranscript(store, "job:src", "fork:b", { throughOffset: 2 });
  assertEquals(result.seeded, 3);
  assertEquals(result.throughOffset, 2);
  assertEquals(
    store.read("fork:b").map((c) => c.offset),
    [0, 1, 2],
  );
});

test("forkTranscript: the branch is independent — appending to the source never touches the fork", () => {
  const store = seededStore();
  recordExited(store, "job:src", 3);
  forkTranscript(store, "job:src", "fork:c", { throughOffset: 1, lifecycle: "long-lived" });

  // Continue the fork with a divergent chunk, and separately grow a long-lived source.
  store.record("fork:c", [{ offset: 2, chunk: "branch-continuation" }], "long-lived");
  assertEquals(
    store.read("fork:c").map((c) => c.chunk),
    ["c0", "c1", "branch-continuation"],
  );
  // The source is untouched by the fork's divergence.
  assertEquals(
    store.read("job:src").map((c) => c.chunk),
    ["c0", "c1", "c2"],
  );
});

test("forkTranscript: a fork replays through the SAME resume-from-offset (since) path as a native stream", () => {
  const store = seededStore();
  recordExited(store, "job:src", 4);
  forkTranscript(store, "job:src", "fork:d");

  const slice = store.since("fork:d", 2);
  assertEquals(slice.gap, false);
  assertEquals(
    slice.entries.map((c) => c.offset),
    [2, 3],
  );
});

test("forkTranscript: throughOffset below the log yields an empty — but real, listed — fork", () => {
  const store = seededStore();
  recordExited(store, "job:src", 3);

  const result = forkTranscript(store, "job:src", "fork:empty", { throughOffset: -1 });
  assertEquals(result.seeded, 0);
  assertEquals(result.throughOffset, undefined);
  assert(store.get("fork:empty") !== undefined);
  assertEquals(store.read("fork:empty"), []);
});

test("forkTranscript: refuses to fork a missing source", () => {
  const store = seededStore();
  assertThrows(() => forkTranscript(store, "job:nope", "fork:x"), TranscriptForkError, "no transcript");
});

test("forkTranscript: refuses an existing target unless allowExisting is set", () => {
  const store = seededStore();
  recordExited(store, "job:src", 2);
  forkTranscript(store, "job:src", "fork:e");

  assertThrows(() => forkTranscript(store, "job:src", "fork:e"), TranscriptForkError, "already exists");
  // With allowExisting the reseed is an idempotent no-op (offset-keyed record).
  const again = forkTranscript(store, "job:src", "fork:e", { allowExisting: true });
  assertEquals(again.seeded, 0);
});

test("forkTranscript: allowExisting refuses a target whose contents diverge from the reseed prefix", () => {
  const store = seededStore();
  recordExited(store, "job:src", 3);
  // A pre-existing target that carries DIFFERENT bytes at an overlapping offset — reseeding here would
  // leave an interleaved mixture (offset-keyed record silently no-ops the divergent offset).
  store.record("fork:diverge", [{ offset: 0, chunk: "not-c0" }], "ephemeral");
  assertThrows(
    () => forkTranscript(store, "job:src", "fork:diverge", { allowExisting: true }),
    TranscriptForkError,
    "does not match the reseed prefix",
  );
  // The target is left untouched — no partial interleave.
  assertEquals(
    store.read("fork:diverge").map((c) => c.chunk),
    ["not-c0"],
  );
});

test("forkTranscript: allowExisting refuses a target opened under a different lifecycle", () => {
  const store = seededStore();
  recordExited(store, "job:src", 2);
  store.open("fork:lc", "long-lived");
  assertThrows(
    () => forkTranscript(store, "job:src", "fork:lc", { allowExisting: true }),
    TranscriptForkError,
    "cannot reseed",
  );
});

test("forkTranscript: refuses to fork a stream onto itself", () => {
  const store = seededStore();
  recordExited(store, "job:src", 1);
  assertThrows(() => forkTranscript(store, "job:src", "job:src"), TranscriptForkError, "onto itself");
});
