// Unit tests for the durable worker-attribution store (app/agentic/correlation-store.ts, #485).
//   - drift guard: db/migrations/078 mirrors AGENTIC_CORRELATION_SCHEMA_SQL;
//   - record/get/byStream round-trips, including the optional (nullable) engine-context columns;
//   - upsert semantics (re-recording a jobKey is last-write-wins).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SqliteDb } from "@nanobpm/agentic/transcript";
import { assert, assertEquals } from "#test-assert";
import { jobStream } from "./correlation.ts";
import { AGENTIC_CORRELATION_SCHEMA_SQL, AgenticCorrelationStore } from "./correlation-store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function memoryDb(): SqliteDb {
  const raw = new DatabaseSync(":memory:");
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] =>
      raw.prepare(sql).all(...params) as T[],
  };
}

test("drift guard: migration 078 mirrors AGENTIC_CORRELATION_SCHEMA_SQL", async () => {
  const migrationPath = join(HERE, "..", "..", "db", "migrations", "078_agentic_correlation.sql");
  const raw = await readFile(migrationPath, "utf8");
  const ddl = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const normalise = (s: string) => s.trim().replace(/\s+/g, " ");
  assertEquals(
    normalise(ddl),
    normalise(AGENTIC_CORRELATION_SCHEMA_SQL),
    "078_agentic_correlation.sql drifted from AGENTIC_CORRELATION_SCHEMA_SQL",
  );
  assert(ddl.includes("agentic_correlation"));
});

test("record + get round-trips full attribution, and byStream decodes the jobKey", () => {
  const store = new AgenticCorrelationStore(memoryDb());
  store.record({
    jobKey: "job-1",
    stream: jobStream("job-1"),
    instance: "worker-A",
    identity: "leaf:token",
    host: "merlin.local",
    processInstanceKey: "pi-9",
    bpmnProcessId: "pr-flow",
    elementId: "agent",
    planKey: "owner/repo#142",
    linkedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:05:00.000Z",
  });

  const got = store.get("job-1");
  assertEquals(got?.instance, "worker-A");
  assertEquals(got?.identity, "leaf:token");
  assertEquals(got?.host, "merlin.local");
  assertEquals(got?.processInstanceKey, "pi-9");
  assertEquals(got?.planKey, "owner/repo#142");
  assertEquals(got?.completedAt, "2026-08-23T00:05:00.000Z");
  // The same row is reachable from the stream id.
  assertEquals(store.byStream(jobStream("job-1"))?.instance, "worker-A");
});

test("optional context columns are omitted (not null) when unknown", () => {
  const store = new AgenticCorrelationStore(memoryDb());
  store.record({
    jobKey: "job-2",
    stream: jobStream("job-2"),
    instance: "worker-B",
    completedAt: "2026-08-23T01:00:00.000Z",
  });
  const got = store.get("job-2");
  assertEquals(got?.instance, "worker-B");
  assert(!("processInstanceKey" in (got ?? {})), "unknown context is omitted, never a null key");
  assert(!("identity" in (got ?? {})), "unknown identity is omitted");
});

test("record is an upsert: re-recording a jobKey is last-write-wins", () => {
  const store = new AgenticCorrelationStore(memoryDb());
  const base = { jobKey: "job-3", stream: jobStream("job-3"), completedAt: "2026-08-23T02:00:00.000Z" };
  store.record({ ...base, instance: "worker-C" });
  store.record({ ...base, instance: "worker-C", host: "second.local", completedAt: "2026-08-23T02:10:00.000Z" });
  const got = store.get("job-3");
  assertEquals(got?.host, "second.local");
  assertEquals(got?.completedAt, "2026-08-23T02:10:00.000Z");
});

test("get is undefined for an unknown jobKey and byStream undefined for a non-job stream", () => {
  const store = new AgenticCorrelationStore(memoryDb());
  assertEquals(store.get("nope"), undefined);
  assertEquals(store.byStream("worker-A"), undefined);
  assertEquals(store.get(""), undefined);
});
