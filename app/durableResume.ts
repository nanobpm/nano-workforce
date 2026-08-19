// nano-workforce — the `durable-resume` ENROLMENT GATE (issue #325, ADR 0062 Slice 5/5).
//
// Durable agent-session resume splits into two halves already landed by the earlier slices: the MIND
// (the harness conversation — Slices 1–3, restored harness-side via `session/load` / native
// `--resume`) and the WORLD (the git working tree + irreversible effect ledger — Slice 4,
// `app/world`, restored by inverting the round's `git push` into `git fetch && git checkout <sha>`).
// This slice is the INTEGRATION that wires both halves into the running orchestration, behind an
// enrolment gate, so a re-leased `senior:pr-review` round (ADR 0002 lease-expiry redrive) RESUMES at
// the last push-checkpoint on a participating harness and gracefully DEGRADES — redriven from scratch,
// exactly as today — on a harness that does not advertise durable-resume.
//
// THE GATE (ADR 0056 §7). `durable-resume` is a WORKER ATTRIBUTE declared at ENROLMENT — never a
// routing token. The routing token `network.role#seat` is unchanged; there is no BPMN change and no
// job-type change. A worker's harness advertises durable-resume at enrol (the probe result from Slice
// 2/3); this registry records that per instance so the app can ask, before it emits the world-restore
// marker, "does the fleet serving this role include a participant?".
//
// WHY FLEET-LEVEL. At the moment the app emits the repo-provisioning envelope it does not yet know
// WHICH worker will lease the `senior:pr-review` job — any worker enrolled for that role may. So the
// gate is a fleet-level existence probe ({@link DurableResumeRegistry.anyParticipant}). This is
// well-defined for a MIXED fleet: emitting the world-restore `commitSha` when at least one participant
// is enrolled lets a participant RESUME, while a non-participant harness simply ignores the marker
// (the envelope validators are structurally forward-compatible) and clones the head branch tip —
// redriving from scratch. When NO participant is enrolled the marker is omitted entirely, so nothing
// regresses: resume is purely additive.
//
// Advisory, app-tier only (ADR 0056): this registry NEVER hard-locks or gates a BPMN sequence flow —
// it only decides whether an OPTIMISATION (world-restore) is offered inside an activation.
import type { DataLayer } from "@nanobpm/urban";

/**
 * The canonical name of the durable-resume enrolment attribute. A worker advertises it at enrol; the
 * registry records it here. It is an ENROLMENT gate (ADR 0056 §7), never a routing token — do not put
 * it in `network.role#seat`.
 */
export const DURABLE_RESUME_ATTR = "durable-resume";

/** A persisted enrolment row (`worker_durable_resume`): one worker instance's durable-resume flag. */
interface WorkerDurableResumeRow {
  instance: string;
  durable_resume: number;
  updated_at: string;
}

/** True when `err` is the durable PRIMARY KEY fence firing — a SQLite `UNIQUE constraint failed`
 * raised because a concurrent/duplicate enrol inserted the SAME instance BETWEEN our `findOne` and our
 * `insert`. `recordEnrolment` is an upsert, so a collision means "the row now exists" — the same
 * intended outcome as the update branch, not a surfaced error. Matched on the message substring the
 * RAD `Table` surface propagates verbatim (mirrors `WorldStore`), because that surface hides the
 * concrete driver error type. */
function isFenceCollision(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * The durable registry of per-worker durable-resume participation, over the `worker_durable_resume`
 * table (`db/migrations/052_worker_durable_resume.sql`). Backed by the app's SQLite DataLayer through
 * the RAD `Table<T>` surface (`data.table(...)`) — NOT hand-written SQL — mirroring `WorldStore`.
 */
export class DurableResumeRegistry {
  readonly #data: DataLayer;

  constructor(data: DataLayer) {
    this.#data = data;
  }

  #table() {
    return this.#data.table<WorkerDurableResumeRow>("worker_durable_resume", "instance");
  }

  /**
   * Record a worker's durable-resume participation at enrolment (an idempotent UPSERT keyed by
   * `instance`). A re-enrol overwrites the flag so a harness that gains — or loses — durable-resume
   * support across a redeploy is reflected. The `findOne`-then-insert is racy under a concurrent
   * duplicate enrol, so a PRIMARY KEY fence collision folds into the update path rather than surfacing
   * as an error (the same end-state either way).
   */
  async recordEnrolment(instance: string, durableResume: boolean): Promise<void> {
    const table = this.#table();
    const now = new Date().toISOString();
    const flag = durableResume ? 1 : 0;
    const existing = await table.findOne({ instance });
    if (existing) {
      await table.update(instance, { durable_resume: flag, updated_at: now });
      return;
    }
    try {
      await table.insert({ instance, durable_resume: flag, updated_at: now });
    } catch (err) {
      if (!isFenceCollision(err)) throw err;
      await table.update(instance, { durable_resume: flag, updated_at: now });
    }
  }

  /** Whether a specific worker instance is a durable-resume participant. `false` for an unknown
   * instance (never enrolled) — the safe default (graceful degradation). */
  async isParticipant(instance: string): Promise<boolean> {
    const row = await this.#table().findOne({ instance });
    return row?.durable_resume === 1;
  }

  /** Whether the enrolled fleet includes AT LEAST ONE durable-resume participant — the fleet-level
   * gate the world-restore emission consults. `false` when none is enrolled (nobody advertises
   * durable-resume), so the resume marker is omitted and the round redrives from scratch. */
  async anyParticipant(): Promise<boolean> {
    const rows = await this.#table().find({ durable_resume: 1 });
    return rows.length > 0;
  }
}

/**
 * Whether the fleet supports durable resume — the app-tier gate for emitting the world-restore
 * `commitSha` (see `app/service.ts`). Best-effort: any read failure (a legacy DB predating migration
 * 052, an in-flight desync) degrades to `false`, so the round redrives from scratch rather than
 * blocking a submit/merge on the enrolment registry. When no data layer is mounted it is likewise
 * `false` — resume is purely additive, so its absence is always the safe direction.
 */
export async function fleetSupportsDurableResume(data: DataLayer | undefined): Promise<boolean> {
  if (!data) return false;
  try {
    return await new DurableResumeRegistry(data).anyParticipant();
  } catch (err) {
    console.warn(`[durable-resume] fleet participation read: ${err}`);
    return false;
  }
}
