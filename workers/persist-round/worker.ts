// pr.persist-round — records a completed round (an `addressed` round where the agent pushed
// changes, or a `waiting` round where there was nothing to triage yet) and parks the PR in
// `waiting_review` so the poller starts watching for / soliciting the next review.
//
// Data access goes through the injected app datasource gateway (`app.data.table<T>`), the RAD
// `Table<T>` surface — `rounds.insert(...)` / `pull_requests.update(...)`, not hand-written SQL.
import type { AppJobHandler } from "@nanobpm/urban";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
import { ensurePr, parsePr } from "../../app/service.ts";
import { type Effect, recordWorldCheckpoint, WorldStore } from "../../app/world/index.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input is typed off the model data envelope (`PrPersistRoundIn` in convergence-loop.bpmn),
// the single source of truth for this worker's wire contract (ADR 0040). Framework-injected
// variables the handler still reads (`io.nanobpm.agentResult`, `agent`) are accessed through the
// `Record<string, unknown>`-typed helpers below rather than the envelope.
type In = WorkerInputs["pr.persist-round"];

// The harness records the agent's full (byte-capped) stdout on the result envelope; keep it
// for audit so a human can see what the agent did this round.
const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

// The c8ctl harness completes each agent job with an `agent` variable (its profile name), which
// propagates here. Record it on the round so a human can identify the servicing worker from the
// durable history. Undefined (blank/absent) leaves the nullable `worker` column NULL.
function workerOf(vars: Record<string, unknown>): string | undefined {
  const v = vars.agent;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** The world-restore marker (issue #324, ADR 0062 Slice 4/5, the WORLD half). When a round pushed
 * changes, the c8ctl harness reports `{commitSha, effects?}` under this reserved key so the app
 * records a durable push-checkpoint: the pushed SHA a replacement activation reconstructs the working
 * tree to (inverting `git push` → `git fetch && git checkout <sha>`), plus the round's irreversible
 * effect ledger (each fence-keyed) so a resume skips an already-applied effect. Absent (a `waiting`
 * round, or a harness predating #324) → no checkpoint is recorded (nothing was pushed). */
const WORLD_MARKER_KEY = "worldMarker";

interface WorldMarker {
  readonly commitSha: string;
  readonly effects?: readonly Effect[];
}

function worldMarkerOf(vars: Record<string, unknown>): WorldMarker | null {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const m = vars[WORLD_MARKER_KEY] as { commitSha?: unknown; effects?: unknown } | undefined;
  if (!m || typeof m.commitSha !== "string" || m.commitSha.trim() === "") return null;
  const effects = Array.isArray(m.effects)
    ? // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      (m.effects as Effect[]).filter(
        (e) => e && typeof e.idempotencyKey === "string" && e.idempotencyKey.trim() !== "",
      )
    : undefined;
  return { commitSha: m.commitSha.trim(), ...(effects && effects.length > 0 ? { effects } : {}) };
}

const handler: AppJobHandler<In> = async (job, app) => {
  // This worker is the "addressed"/"waiting" path, so `status` resolves to one of those
  // domain values. `summary` is left undefined when absent: the write boundary omits it so the
  // nullable `rounds.summary` column stays NULL rather than being coerced to "".
  const { prKey, round, status = "addressed", summary, repo, prNumber, prUrl, abandonUrl } = job.variables;
  const now = new Date().toISOString();

  // Heal a missing FK parent (engine/app.db desync) before the child `rounds` insert so this
  // never dies with an opaque `FOREIGN KEY constraint failed` incident. Prefer the carried
  // repo/prNumber; if either is missing (an older in-flight instance, or a process-variable
  // regression) fall back to parsing them out of the canonical `owner/repo#N` prKey so the heal
  // still runs.
  const parsed = parsePr(prKey);
  const healRepo = repo ?? parsed?.repo;
  const healNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
  if (healRepo && typeof healNumber === "number") {
    await ensurePr(app.data, {
      prKey,
      repo: healRepo,
      number: healNumber,
      url: prUrl,
      round,
      abandonToken: abandonTokenFromUrl(abandonUrl),
    });
  }

  await app.data.table("rounds", "id").insert({
    pr_key: prKey,
    round_no: round,
    status,
    summary,
    transcript: transcriptOf(job.variables),
    worker: workerOf(job.variables),
    started_at: now,
    ended_at: now,
  });
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "waiting_review",
    current_round: round,
    waiting_since: now,
    updated_at: now,
  });

  // World checkpoint (issue #324, ADR 0062 Slice 4/5): when this round pushed, record the durable
  // push-checkpoint — the pushed SHA a replacement activation reconstructs the tree to, plus the
  // round's fence-keyed effect ledger. The JOIN to the mind's `session.checkpoint(...)` (Slice 1)
  // happens harness-side (out of process); here we persist the WORLD marker so restore can invert
  // the push. Best-effort: a checkpoint-store failure must not fail an already-recorded round.
  const marker = worldMarkerOf(job.variables);
  if (marker) {
    try {
      await recordWorldCheckpoint(new WorldStore(app.data), {
        prKey,
        roundNo: round,
        commitSha: marker.commitSha,
        ...(marker.effects ? { effects: marker.effects } : {}),
      });
    } catch (err) {
      app.log.warn("world checkpoint record failed", { prKey, round, err: String(err) });
    }
  }

  return {};
};

export default handler;
