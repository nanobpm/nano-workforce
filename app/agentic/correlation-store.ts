// nano-workforce — the DURABLE jobKey ⇄ worker-attribution store (#485, provisioning #232).
//
// The in-memory {@link ./correlation.ts | CorrelationRegistry} is the live join, but it is RELEASED
// on job end / worker disconnect (`releaseJob` / `releaseInstance`) and is empty after a restart. So a
// COMPLETED (past) session — the exact case the cockpit "past sessions" / worker-history view reads —
// loses which worker ran it (instance / identity / host) and its process-instance / plan context: the
// live registry no longer holds the row, and the package-mirrored transcript store
// (`db/migrations/024_agentic_transcript.sql`, byte-for-byte guarded) carries no correlation columns.
//
// This app-side table closes that gap WITHOUT touching the mirrored transcript schema (exactly the
// shape #232 called for): at job-completion time the relay slice records the attribution here, keyed
// by jobKey, so the transcript read path can recover a past session's worker + context after the
// worker has exited. Advisory / read-only (ADR 0056) — it NEVER gates a BPMN sequence flow.
//
// Single source of truth: {@link AGENTIC_CORRELATION_SCHEMA_SQL} is the canonical DDL, applied
// idempotently on store construction (so unit tests over an in-memory DB have the table). Its
// EFFECTIVE shape is reproduced by the forward-only migrations `db/migrations/078_agentic_correlation.sql`
// (base table) + `086_agentic_correlation_element_instance.sql` (#544 expand: the additive, nullable
// `element_instance_key`). A drift-guard test (`correlation-store.test.ts`) applies those migrations to
// one DB and the canonical DDL to another and asserts the two schemas are identical, so they can never
// diverge (the migrations, once merged, are immutable — the canonical DDL is what evolves).
import type { SqliteDb } from "@nanobpm/agentic/transcript";
import { jobKeyOfStream } from "./correlation.ts";

/**
 * The canonical DDL for the durable correlation table. The `078_*` + `086_*` migrations reproduce this
 * effective shape (see the drift-guard test); `element_instance_key` is appended LAST to match the
 * order SQLite gives a column added via `ALTER TABLE ... ADD COLUMN`.
 */
export const AGENTIC_CORRELATION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS agentic_correlation (
  job_key TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  instance TEXT NOT NULL,
  identity TEXT,
  host TEXT,
  process_instance_key TEXT,
  bpmn_process_id TEXT,
  element_id TEXT,
  plan_key TEXT,
  linked_at TEXT,
  completed_at TEXT NOT NULL,
  element_instance_key TEXT
);
CREATE INDEX IF NOT EXISTS ix_agentic_correlation_instance ON agentic_correlation (instance);
CREATE INDEX IF NOT EXISTS ix_agentic_correlation_process_instance ON agentic_correlation (process_instance_key);
CREATE INDEX IF NOT EXISTS ix_agentic_correlation_plan ON agentic_correlation (plan_key);
CREATE INDEX IF NOT EXISTS ix_agentic_correlation_element_instance ON agentic_correlation (element_instance_key);
`;

/** One durable attribution row: which worker ran a job, plus its (best-effort) engine context. */
export interface DurableCorrelation {
  readonly jobKey: string;
  readonly stream: string;
  readonly instance: string;
  readonly identity?: string;
  readonly host?: string;
  readonly processInstanceKey?: string;
  readonly bpmnProcessId?: string;
  readonly elementId?: string;
  readonly planKey?: string;
  /** When the job was first linked (its first `produce`), ISO-8601, when known. */
  readonly linkedAt?: string;
  /** When the job completed (was flushed / released), ISO-8601. */
  readonly completedAt: string;
  /**
   * The engine element-instance key the job's token occupies (#544). Unlike {@link elementId} (the
   * STATIC BPMN id, ambiguous across a looping / retried job), this identifies the specific occupancy.
   * Best-effort: undefined for pre-#544 rows and whenever resolution did not land.
   */
  readonly elementInstanceKey?: string;
}

/** A row as stored (nullable columns come back as `null`). */
interface Row {
  job_key: string;
  stream: string;
  instance: string;
  identity: string | null;
  host: string | null;
  process_instance_key: string | null;
  bpmn_process_id: string | null;
  element_id: string | null;
  plan_key: string | null;
  linked_at: string | null;
  completed_at: string;
  element_instance_key: string | null;
}

function fromRow(r: Row): DurableCorrelation {
  const out: DurableCorrelation = {
    jobKey: r.job_key,
    stream: r.stream,
    instance: r.instance,
    completedAt: r.completed_at,
  };
  return {
    ...out,
    ...(r.identity !== null ? { identity: r.identity } : {}),
    ...(r.host !== null ? { host: r.host } : {}),
    ...(r.process_instance_key !== null ? { processInstanceKey: r.process_instance_key } : {}),
    ...(r.bpmn_process_id !== null ? { bpmnProcessId: r.bpmn_process_id } : {}),
    ...(r.element_id !== null ? { elementId: r.element_id } : {}),
    ...(r.plan_key !== null ? { planKey: r.plan_key } : {}),
    ...(r.linked_at !== null ? { linkedAt: r.linked_at } : {}),
    ...(r.element_instance_key !== null ? { elementInstanceKey: r.element_instance_key } : {}),
  };
}

/**
 * The durable worker-attribution store over the app's SQLite handle. Synchronous (mirrors
 * {@link SqliteDb} and the relay slice's sync frame handling), advisory — a persistence failure never
 * bubbles into a frame handler; callers wrap {@link record} defensively.
 */
export class AgenticCorrelationStore {
  readonly #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
    // Idempotent — the migration applies the same DDL at boot; this makes the table present for
    // unit tests over an in-memory DB (and is a no-op alongside the migration).
    this.#db.exec(AGENTIC_CORRELATION_SCHEMA_SQL);
  }

  /** Upsert a completed job's attribution (last write wins on jobKey). */
  record(entry: DurableCorrelation): void {
    this.#db.run(
      `INSERT INTO agentic_correlation
         (job_key, stream, instance, identity, host, process_instance_key, bpmn_process_id, element_id, plan_key, linked_at, completed_at, element_instance_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_key) DO UPDATE SET
         stream = excluded.stream,
         instance = excluded.instance,
         identity = excluded.identity,
         host = excluded.host,
         process_instance_key = excluded.process_instance_key,
         bpmn_process_id = excluded.bpmn_process_id,
         element_id = excluded.element_id,
         plan_key = excluded.plan_key,
         linked_at = excluded.linked_at,
         completed_at = excluded.completed_at,
         element_instance_key = excluded.element_instance_key`,
      [
        entry.jobKey,
        entry.stream,
        entry.instance,
        entry.identity ?? null,
        entry.host ?? null,
        entry.processInstanceKey ?? null,
        entry.bpmnProcessId ?? null,
        entry.elementId ?? null,
        entry.planKey ?? null,
        entry.linkedAt ?? null,
        entry.completedAt,
        entry.elementInstanceKey ?? null,
      ],
    );
  }

  /**
   * Backfill the element-instance key onto an ALREADY-RECORDED row (#544), for the race where the
   * asynchronous element-instance resolution returns AFTER the job completed and its attribution was
   * persisted (the live correlation is gone, so it can no longer be enriched in memory). A no-op when
   * no row exists yet (the resolution won the race — {@link record} will carry the key) or the key is
   * empty. Advisory, like the rest of the store — never keyed on for control flow.
   */
  setElementInstanceKey(jobKey: string, elementInstanceKey: string): void {
    if (jobKey === "" || elementInstanceKey === "") return;
    this.#db.run("UPDATE agentic_correlation SET element_instance_key = ? WHERE job_key = ?", [
      elementInstanceKey,
      jobKey,
    ]);
  }

  /** The durable attribution for a jobKey, or undefined when none was recorded. */
  get(jobKey: string): DurableCorrelation | undefined {
    if (jobKey === "") return undefined;
    const rows = this.#db.all<Row>("SELECT * FROM agentic_correlation WHERE job_key = ?", [jobKey]);
    return rows.length > 0 ? fromRow(rows[0]) : undefined;
  }

  /** The durable attribution for a `job:<jobKey>` stream id, or undefined for a non-job stream. */
  byStream(stream: string): DurableCorrelation | undefined {
    const jobKey = jobKeyOfStream(stream);
    return jobKey === undefined ? undefined : this.get(jobKey);
  }

  /** Every durable attribution recorded for a worker instance, newest completion first. */
  byInstance(instance: string): DurableCorrelation[] {
    if (instance === "") return [];
    const rows = this.#db.all<Row>(
      "SELECT * FROM agentic_correlation WHERE instance = ? ORDER BY completed_at DESC, job_key DESC",
      [instance],
    );
    return rows.map(fromRow);
  }

  /**
   * Every durable attribution recorded for an engine element-instance key (#544), newest completion
   * first. This is the #544 read axis: unlike a static {@link DurableCorrelation.elementId}, an
   * element-instance key names one specific occupancy, so a looping / retried activity's distinct
   * iterations resolve to distinct rows here.
   */
  byElementInstance(elementInstanceKey: string): DurableCorrelation[] {
    if (elementInstanceKey === "") return [];
    const rows = this.#db.all<Row>(
      "SELECT * FROM agentic_correlation WHERE element_instance_key = ? ORDER BY completed_at DESC, job_key DESC",
      [elementInstanceKey],
    );
    return rows.map(fromRow);
  }
}
