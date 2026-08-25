// Unit tests for the durable worker-attribution store (app/agentic/correlation-store.ts, #485).
//   - drift guard: migrations 078 + 086 reproduce AGENTIC_CORRELATION_SCHEMA_SQL's effective schema;
//   - record/get/byStream round-trips, including the optional (nullable) engine-context columns;
//   - byElementInstance read axis (#544) and its per-occupancy uniqueness;
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

/**
 * The effective schema of `agentic_correlation` as SQLite reports it: the ordered column list
 * (name/type/nullability/default/pk) plus the set of indexes (name + normalised definition). This is
 * derivation-over-duplication: comparing the *observed* schema rather than raw DDL text means the
 * migration path and the canonical DDL are pinned to each other regardless of formatting, so the two
 * cannot silently drift even though (post expand-and-contract) they are no longer byte-identical text.
 */
function effectiveSchema(db: DatabaseSync): string {
  const columns = db
    .prepare("PRAGMA table_info(agentic_correlation)")
    .all()
    .map((c) => {
      const col = c as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
      return `${col.name}|${col.type}|${col.notnull}|${col.dflt_value ?? ""}|${col.pk}`;
    })
    .join("\n");
  const indexes = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agentic_correlation' ORDER BY name",
    )
    .all()
    .map((i) => {
      const idx = i as { name: string; sql: string | null };
      return `${idx.name}|${(idx.sql ?? "").trim().replace(/\s+/g, " ")}`;
    })
    .join("\n");
  return `COLUMNS\n${columns}\nINDEXES\n${indexes}`;
}

test("drift guard: migrations 078 + 086 reproduce AGENTIC_CORRELATION_SCHEMA_SQL's effective schema", async () => {
  const migrationsDir = join(HERE, "..", "..", "db", "migrations");
  const base = await readFile(join(migrationsDir, "078_agentic_correlation.sql"), "utf8");
  const expand = await readFile(join(migrationsDir, "086_agentic_correlation_element_instance.sql"), "utf8");

  const migrated = new DatabaseSync(":memory:");
  migrated.exec(base);
  migrated.exec(expand);

  const canonical = new DatabaseSync(":memory:");
  canonical.exec(AGENTIC_CORRELATION_SCHEMA_SQL);

  assertEquals(
    effectiveSchema(migrated),
    effectiveSchema(canonical),
    "migrations 078 + 086 drifted from AGENTIC_CORRELATION_SCHEMA_SQL",
  );
  // The #544 column and its index are present in both paths.
  assert(effectiveSchema(canonical).includes("element_instance_key"), "canonical DDL has element_instance_key");
  assert(
    effectiveSchema(canonical).includes("ix_agentic_correlation_element_instance"),
    "canonical DDL indexes element_instance_key",
  );
  migrated.close();
  canonical.close();
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

test("byElementInstance keys per-occupancy, distinguishing a looping/retried activity's iterations", () => {
  const store = new AgenticCorrelationStore(memoryDb());
  // Two runs of the SAME static element (`agent`) in the same process instance — a loop / retry —
  // occupy DISTINCT element instances. Keyed on element_id they'd be indistinguishable; keyed on the
  // element-instance key each resolves to its own attribution (the whole point of #544).
  store.record({
    jobKey: "job-iter-1",
    stream: jobStream("job-iter-1"),
    instance: "worker-A",
    processInstanceKey: "pi-9",
    elementId: "agent",
    elementInstanceKey: "ei-100",
    completedAt: "2026-08-23T00:05:00.000Z",
  });
  store.record({
    jobKey: "job-iter-2",
    stream: jobStream("job-iter-2"),
    instance: "worker-A",
    processInstanceKey: "pi-9",
    elementId: "agent",
    elementInstanceKey: "ei-200",
    completedAt: "2026-08-23T00:10:00.000Z",
  });

  assertEquals(store.get("job-iter-1")?.elementInstanceKey, "ei-100");
  const first = store.byElementInstance("ei-100");
  assertEquals(first.length, 1);
  assertEquals(first[0].jobKey, "job-iter-1");
  const second = store.byElementInstance("ei-200");
  assertEquals(second.length, 1);
  assertEquals(second[0].jobKey, "job-iter-2");
  assertEquals(store.byElementInstance("ei-nope").length, 0);
  assertEquals(store.byElementInstance("").length, 0);
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
