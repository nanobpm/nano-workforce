// pr.persist-round — records a completed round (an `addressed` round where the agent pushed
// changes, or a `waiting` round where there was nothing to triage yet) and advances the PR's
// `current_round`. It does NOT park the PR in `waiting_review`: that transition is owned by the
// downstream pr.progress-check step, the single writer of the post-round wait status. persist-round
// runs BEFORE the husk decision, so parking here would momentarily expose a husk-retry round (which
// re-enters review-round WITHOUT waiting for a review) to the poller's `waiting_review` scan and let
// it solicit a spurious Copilot review before progress-check flips the row back (#786).
//
// Data access goes through the injected app datasource gateway (`app.data.table<T>`), the RAD
// `Table<T>` surface — `rounds.insert(...)` / `pull_requests.update(...)`, not hand-written SQL.
import type { AppJobHandler } from "@nanobpm/urban";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
import { ensurePr, parsePr } from "../../app/service.ts";
import { type Effect, isCommitSha, isEffectKind, recordWorldCheckpoint, WorldStore } from "../../app/world/index.ts";
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

/** Normalize one externally-supplied effect from the harness `worldMarker`, or `null` when it is not
 * a usable effect. This is a CONTRACT BOUNDARY: the marker arrives from out-of-process, so both the
 * fence key AND the effect kind are untrusted. We (a) TRIM `idempotencyKey` so whitespace variants of
 * one real effect collapse to a single fence key rather than manufacturing distinct ledger rows that
 * defeat the fence, and (b) validate `kind` against the canonical {@link EFFECT_KINDS} so an unknown
 * kind can never enter the durable ledger. `description` is trimmed to a non-empty note or dropped. */
function normalizeEffect(raw: unknown): Effect | null {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const e = raw as { kind?: unknown; idempotencyKey?: unknown; description?: unknown } | null | undefined;
  if (!e || !isEffectKind(e.kind)) return null;
  if (typeof e.idempotencyKey !== "string") return null;
  const idempotencyKey = e.idempotencyKey.trim();
  if (idempotencyKey === "") return null;
  const description = typeof e.description === "string" ? e.description.trim() : "";
  return { kind: e.kind, idempotencyKey, ...(description !== "" ? { description } : {}) };
}

export function worldMarkerOf(vars: Record<string, unknown>): WorldMarker | null {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const m = vars[WORLD_MARKER_KEY] as { commitSha?: unknown; effects?: unknown } | undefined;
  if (!m || typeof m.commitSha !== "string") return null;
  // `commitSha` is used as an EXACT checkout target on restore (`git fetch && git checkout <sha>`),
  // so validate it is a well-formed 40-hex SHA — the SAME guard the emit boundary `repoEnvelopeVars`
  // applies (via `isCommitSha`) so the two boundaries can't drift. An arbitrary ref (e.g. `main`) or
  // an abbreviated SHA would reconstruct to a moved branch tip or fail restore, undermining the
  // "reconstruct the exact tree at <sha>" contract. Trim first so a whitespace-tainted valid SHA
  // still passes; a value that isn't a full object name degrades to no checkpoint (a `waiting` round).
  const commitSha = m.commitSha.trim();
  if (!isCommitSha(commitSha)) return null;
  const effects = Array.isArray(m.effects)
    ? m.effects.map(normalizeEffect).filter((e): e is Effect => e !== null)
    : undefined;
  return { commitSha, ...(effects && effects.length > 0 ? { effects } : {}) };
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

  // Idempotent round record (issue #786): a husk auto-retry re-enters `review-round` WITHOUT
  // advancing the round counter, so the SAME `(pr_key, round_no)` reaches this worker more than once.
  // The `rounds` table has no UNIQUE(pr_key, round_no), so an unconditional insert would manufacture
  // a DUPLICATE history row per retry — the durable round history is the SoT the cockpit and the
  // no-progress guard read, so a duplicate row corrupts both. Upsert on `(pr_key, round_no)`:
  // update the existing round-record row in place, else insert. Application-level (no
  // migration/UNIQUE) so it heals installs that already carry pre-#786 duplicates rather than
  // crashing on a new constraint.
  //
  // But the upsert MUST reuse only a row THIS run's `pr.persist-round` wrote — identity, not a
  // status heuristic. Two ways a stale-but-status-eligible row can share `(pr_key, round_no)`:
  //   • An escalation row: on a `needs_input`/`blocked` escalation, `pr.persist-escalation` inserts
  //     a `rounds` row (status `needs_input`/`blocked`) for the SAME `(pr_key, round_no)`, and the
  //     human-answered resume re-enters that numeric round → back here. Reusing it would overwrite
  //     the escalation to `addressed`, ERASING the escalation attempt from the durable history.
  //   • A prior RUN's row: `submitPr` re-opens a previously converged/abandoned/merged PR at
  //     `current_round = 1` WITHOUT deleting `rounds` history, so a fresh convergence run (a NEW
  //     process instance) at round 1 finds the prior run's `addressed`/`waiting`/`converged` round-1
  //     row. Reusing it (its status is not a human-hold) would clobber another run's canonical
  //     history — the resubmission drift the reviewer flagged.
  // The idempotency target is precisely "the row a husk auto-retry of THIS process instance wrote",
  // and a husk retry re-enters `review-round` in the SAME process instance while a resubmission is a
  // NEW one. So scope reuse by the writing `process_instance_key` (persisted below) AND exclude
  // human-hold rows: reuse a row only when it carries the current instance's key and a non-hold
  // status; otherwise insert a fresh row so every prior run's history — and every escalation — is
  // preserved. `job.processInstanceKey` is always present for an engine job; when it is absent (a
  // testkit/synthetic job) we fall back to the status-only heuristic so idempotency still holds
  // within that single run.
  const roundsTbl = app.data.table<{
    id: number;
    pr_key: string;
    round_no: number;
    status: string;
    summary?: string;
    transcript: string | null;
    worker?: string;
    started_at: string;
    ended_at: string;
    process_instance_key?: string | null;
  }>("rounds", "id");
  const HUMAN_HOLD_STATUSES = new Set(["needs_input", "blocked"]);
  const processInstanceKey = job.processInstanceKey != null ? String(job.processInstanceKey) : null;
  const matching = await roundsTbl.find({ pr_key: prKey, round_no: round });
  // Reuse only a round-record row written by THIS run (matching process instance, when known) and
  // never an escalation (human-hold) row; of those, the newest (greatest id).
  const reusable = matching
    .filter((r) => !HUMAN_HOLD_STATUSES.has(r.status))
    .filter((r) => processInstanceKey === null || r.process_instance_key === processInstanceKey)
    .reduce<{ id: number } | null>((newest, r) => (newest && newest.id >= r.id ? newest : r), null);
  const roundRow = {
    status,
    summary,
    transcript: transcriptOf(job.variables),
    worker: workerOf(job.variables),
    ended_at: now,
  };
  if (reusable) {
    await roundsTbl.update(reusable.id, roundRow);
  } else {
    await roundsTbl.insert({
      pr_key: prKey,
      round_no: round,
      started_at: now,
      process_instance_key: processInstanceKey,
      ...roundRow,
    });
  }
  // Advance the round pointer only; the PARK into `waiting_review` is owned by pr.progress-check,
  // the single writer of the post-round wait status. persist-round must NOT park here — it runs
  // BEFORE the husk decision, so writing `waiting_review` now would expose a husk-retry round (which
  // re-enters review-round WITHOUT waiting for a review) to the poller's `waiting_review` scan for
  // the window until progress-check resolves the outcome, letting the poller fire a spurious Copilot
  // re-request (#786). Leaving the row on its running `converging` status until progress-check
  // decides closes that window; only the genuine review-wait park sets `waiting_review`.
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    current_round: round,
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
