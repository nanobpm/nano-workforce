// pr.select-wave — pick the tasks to run in the current wave (issue #20).
//
// The plan-fanout wave loop calls this before each parallel `implement` fan-out. It loads
// `plan_tasks` for the plan, keeps the still-`pending` tasks whose `wave` equals the process's
// `currentWave`, and emits them as `waveTasks: [{ id, title, prompt }]` — the multi-instance
// input collection.
//
// A task is only runnable when EVERY dependency it declared has an `opened` PR. If any
// dependency ended `blocked` / `skipped` (or is otherwise not opened), the dependent can't be
// built: this worker marks it `skipped` (recording which deps were unmet) and excludes it from
// the wave, so the failure cascades forward instead of dispatching an agent that can't succeed.
// A dependency in `waiting-for-lane` is different: its PR is good but parked behind a merge lane,
// so the dependent stays `pending` and simply waits for a later wave retry.
//
// Emitting an empty `waveTasks` is fine: the MI activity over an empty collection completes
// immediately (the same 0-task path the flat fan-out already relied on).
import type { AppJobHandler } from "@nanobpm/urban";
import type { CapabilityNeed } from "../../app/capabilityNeed.ts";
import { deriveEpicPhase } from "../../app/epicPhase.ts";
import { plans, planTaskDeps, planTaskNeeds, planTasks } from "../../app/plan.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`SelectWaveIn` in plan-fanout.bpmn) — ADR 0040.
type In = WorkerInputs["pr.select-wave"];
interface WaveTaskOut {
  id: string;
  title: string;
  prompt: string;
  // Cross-repo capability edges to gate this task on before its agent starts (issue #289). Empty
  // for a task with no upstream capability dependency; carried through so the fan-out can gate on
  // each need (readiness-gate) and late-bind the resolved `pkg@version` into the agent's prompt.
  needs: CapabilityNeed[];
}
interface Out extends Record<string, unknown> {
  waveTasks: WaveTaskOut[];
}

// Coerce a wave index to a non-negative integer, falling back to 0. A NaN currentWave would make
// the `(r.wave ?? 0) !== currentWave` filter always true, silently emitting an empty wave.
const toWave = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const currentWave = toWave(job.variables.currentWave);
  const ts = new Date().toISOString();

  const taskTable = planTasks(app.data);
  const rows = await taskTable.find({ plan_key: planKey });
  const statusById = new Map<string, string>();
  for (const r of rows) statusById.set(r.task_id, r.status);

  // Operator-visibility projection (issue #137): mark this as the wave the fleet is now
  // implementing, so the epics-index can show wave X/N at a glance. wave_count is derivable from
  // the levelized rows (max wave + 1), so the "X/N" label stays correct even if a re-levelize
  // changed the total. Best-effort + idempotent (a retry re-writes the same value) and
  // display-only — it must never gate control flow, which stays driven by the process
  // `currentWave`/`waveCount`/`gate_wave` state.
  const waveCount = rows.reduce((m, r) => Math.max(m, r.wave ?? 0), -1) + 1;
  // Domain-phase projection (#261): select-wave dispatches this wave and is the last host write
  // before the write-silent `implement` MI, so it durably marks the implementation phase for the
  // wave it launches — `Implementing (wave n/t)` from the levelize records (job.elementId +
  // current/total waves). A null derivation (element id absent) must not clobber the phase.
  const epicPhase = waveCount > 0
    ? deriveEpicPhase(job.elementId, { current: currentWave, total: waveCount })
    : null;
  // Inter-epic gate projection (#292 slice S4): reaching select-wave proves this epic's leading
  // capability PREFLIGHT (S3) already went GREEN, so capture the `resolvedArtifacts` the preflight
  // bound — the exact `pkg@version`s first carrying each producer's awaited capability — onto the
  // plan row. `pollWaitGate` (app/service.ts) reads this to show a satisfied dependent's bound
  // version. NULL for a root (no preflight → no resolved artifacts); display-only, control flow is
  // unchanged. Filter the MI output to non-blank strings (a probe may publish without a bind),
  // mirroring the `resolvedArtifacts[item != null]` filter the implement-task prompt uses.
  const boundArtifacts = Array.isArray(job.variables.resolvedArtifacts)
    ? job.variables.resolvedArtifacts.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  try {
    await plans(app.data).update(planKey, {
      // Keep the three progress fields consistent: with no levelized rows (waveCount 0) there is
      // no wave to implement, so current_wave is NULL too — never a stray index against NULL N.
      current_wave: waveCount > 0 ? currentWave : null,
      wave_count: waveCount > 0 ? waveCount : null,
      wave_label: waveCount > 0 ? `${currentWave + 1}/${waveCount}` : null,
      ...(epicPhase ? { epic_phase: epicPhase } : {}),
      ...(boundArtifacts.length > 0 ? { bound_artifacts: JSON.stringify(boundArtifacts) } : {}),
      updated_at: ts,
    });
  } catch (err) {
    app.log.error(`select-wave: projecting current_wave failed for ${planKey}`, {
      err: String(err),
    });
  }

  const deps = await planTaskDeps(app.data).find({ plan_key: planKey });
  const depsByTask = new Map<string, string[]>();
  for (const d of deps) {
    const list = depsByTask.get(d.task_id) ?? [];
    list.push(d.depends_on_task_id);
    depsByTask.set(d.task_id, list);
  }

  // Cross-repo capability edges (issue #289): loaded once and grouped per task so each dispatched
  // wave task carries its `needs[]` for the fan-out to gate on. A task with no needs gets [].
  const needRows = await planTaskNeeds(app.data).find({ plan_key: planKey });
  const needsByTask = new Map<string, CapabilityNeed[]>();
  for (const n of needRows) {
    const list = needsByTask.get(n.task_id) ?? [];
    list.push({
      capabilityRef: n.capability_ref,
      package: n.package,
      ...(n.verify_command ? { verifyCommand: n.verify_command } : {}),
    });
    needsByTask.set(n.task_id, list);
  }

  const waveTasks: WaveTaskOut[] = [];
  for (const r of rows) {
    if ((r.wave ?? 0) !== currentWave) continue;
    // Only fresh tasks are dispatchable; a retry of this wave must not re-run resolved ones.
    if (r.status !== "pending") continue;

    const depIds = depsByTask.get(r.task_id) ?? [];
    const unmet = depIds.filter((d) => {
      const status = statusById.get(d);
      return status !== "opened" && status !== "waiting-for-lane";
    });
    if (unmet.length > 0) {
      await taskTable.update(r.id, {
        status: "skipped",
        summary: `dependency not opened: ${unmet.join(", ")}`,
        updated_at: ts,
      });
      continue;
    }
    if (depIds.some((d) => statusById.get(d) === "waiting-for-lane")) continue;
    waveTasks.push({
      id: r.task_id,
      title: r.title ?? r.task_id,
      prompt: r.prompt ?? "",
      needs: needsByTask.get(r.task_id) ?? [],
    });
  }

  return { waveTasks };
};

export default handler;
