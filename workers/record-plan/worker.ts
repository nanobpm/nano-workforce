// pr.record-plan — persists the plan the `senior:plan` agent emitted, LEVELIZES the task
// DAG into ordered waves (issue #20), and hands the process the first wave to run.
//
// The planner emits `{ tasks: [{ id?, title?, prompt, dependsOn? }] }`. This worker:
//   • assigns each task a stable `id` (planner slug, else `t<index>`) and an index,
//   • computes each task's `wave` from its `dependsOn` DAG (app/waves.ts): independent
//     tasks share a wave, a dependent task lands 1 + max(dep wave),
//   • writes one `plan_tasks` row per task (status `pending`, with its `wave`) and one
//     `plan_task_deps` row per dependency edge (idempotent: cleared + rewritten per plan),
//   • records the task count, moves the plan to `dispatched`, and emits `currentWave = 0`
//     plus `waveCount` so the wave loop (`select-wave → implement → record-wave`) can run.
//
// A TASKLESS plan (the planner emitted no tasks) is NOT terminal here (issue #624): "the planner
// produced nothing this pass" is an intermediate state, not an ended process — the plan-fanout
// instance is still live and may re-plan, escalate, or be cancelled. The plan stays NON-terminal
// (`planning`, with an `outcome` note for observability); terminal `plans.status` follows ENGINE
// instance liveness, reconciled by the poller (COMPLETED → `done`; TERMINATED → `abandoned`), never
// this empty-plan heuristic.
//
// If the planner emits a malformed DAG (cycle / unknown or self dependency / duplicate id),
// levelization can't order the tasks. Rather than dead-lock the plan we DEGRADE to the old
// flat behaviour — a single wave (wave 0) of all tasks, run fully in parallel — and log a
// warning; the ordering is lost but every task still runs. No `plan_task_deps` are recorded
// in that case (the edges were invalid).
import type { AppJobHandler } from "@nanobpm/urban";
import { type CapabilityNeed, parseCapabilityNeeds } from "../../app/capabilityNeed.ts";
import { plans, planTaskDeps, planTaskNeeds, planTasks } from "../../app/plan.ts";
import { computeWaves, WaveError, type WaveTask } from "../../app/waves.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordPlanIn` in plan-fanout.bpmn) — ADR 0040. The
// `tasks[]` array field is a `nano:reference` to the `RecordPlanTask` shape (`list="true"`), so it
// resolves to `RecordPlanTask[]` with no hand-written interface.
type In = WorkerInputs["pr.record-plan"];
interface NormalTask {
  id: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  // Cross-repo capability edges declared on the task (issue #289). Normalised + de-duped; empty when
  // the task consumes no upstream capability. Levelized into `plan_task_needs`, NOT the wave DAG —
  // a capability edge gates a task on an EXTERNAL publish, never on a sibling task's wave.
  needs: CapabilityNeed[];
}
interface Out extends Record<string, unknown> {
  currentWave: number;
  waveCount: number;
  // Task count of the recorded plan. The plan-fanout gateway (`gw-plan-empty`) reads this to route
  // an intentionally-empty plan (`{tasks:[]}`) to the OPERATOR empty-plan escalation
  // (`empty-plan-escalation`) — a human decides Accept (no-op done) or Revise (re-plan) — instead of
  // the adversarial plan-review gate (issues #623/#624). Feeding an empty plan into review caused a
  // plan↔plan-review livelock (it can neither be approved nor produce findings), and auto-terminating
  // it (issue #625) reached a terminal verdict from an intermediate signal while the instance was
  // still live; escalating for operator attention resolves both.
  taskCount: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter((s) => s !== "") : [];

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const { planKey, note } = job.variables;
  const raw = Array.isArray(job.variables.tasks) ? job.variables.tasks : [];
  const ts = new Date().toISOString();

  const tasks: NormalTask[] = raw.map((t, i) => {
    const id = str(t?.id).trim() || `t${i + 1}`;
    return {
      id,
      title: str(t?.title).trim() || id,
      prompt: str(t?.prompt),
      // Dedupe: a planner-emitted `["a","a"]` would otherwise violate the
      // `plan_task_deps` PK on the second edge insert and fail the job.
      dependsOn: [...new Set(strList(t?.dependsOn))],
      // Cross-repo capability edges (issue #289): tolerant-parse + de-dupe; a malformed need is
      // dropped, never fatal. Independent of the wave DAG — these gate on an external publish.
      needs: parseCapabilityNeeds(t?.needs),
    };
  });

  // Levelize the DAG. A malformed graph degrades to a single all-parallel wave (see header).
  const forLevel: WaveTask[] = tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn }));
  let waveOf = new Map<string, number>();
  let waveCount = tasks.length > 0 ? 1 : 0;
  let depsValid = true;
  try {
    const levelled = computeWaves(forLevel);
    waveOf = levelled.waveOf;
    waveCount = levelled.waveCount;
  } catch (err) {
    if (!(err instanceof WaveError)) throw err;
    depsValid = false;
    // The DAG is unusable (cycle / self / unknown dep, or a DUPLICATE task id). Rewrite every
    // task to a guaranteed-unique positional id and drop deps: the wave loop's task_id-keyed
    // maps (select-wave / record-wave) would otherwise collide on duplicate ids and silently
    // lose updates, leaving some rows stuck `pending`. Ordering is lost; all tasks run flat.
    tasks.forEach((t, i) => {
      t.id = `t${i + 1}`;
    });
    waveOf = new Map();
    for (const t of tasks) waveOf.set(t.id, 0);
    app.log.warn(`record-plan: ${planKey} plan not levelizable, running flat`, {
      err: err.message,
    });
  }

  // Idempotency: a retry (or re-run) of this job must not duplicate rows for the same plan.
  const taskTable = planTasks(app.data);
  const existing = await taskTable.find({ plan_key: planKey });
  for (const row of existing) await taskTable.delete(row.id);
  // `plan_task_deps` is keyed on `plan_key`, so one delete clears the plan's whole edge set.
  const depTable = planTaskDeps(app.data);
  await depTable.delete(planKey);
  // `plan_task_needs` is likewise keyed on `plan_key` — one delete clears the plan's capability
  // edges before rewrite (issue #289). Independent of the DAG-degrade path below.
  const needTable = planTaskNeeds(app.data);
  await needTable.delete(planKey);

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    await taskTable.insert({
      plan_key: planKey,
      task_index: i,
      task_id: t.id,
      title: t.title,
      prompt: t.prompt,
      status: "pending",
      wave: waveOf.get(t.id) ?? 0,
      created_at: ts,
      updated_at: ts,
    });
    if (depsValid) {
      for (const dep of t.dependsOn) {
        await depTable.insert({
          plan_key: planKey,
          task_id: t.id,
          depends_on_task_id: dep,
        });
      }
    }
    // Capability edges persist regardless of `depsValid` — they gate on an external publish, not on
    // the (possibly malformed) intra-epic DAG. The PK dedupes a task listing the same edge twice.
    for (const need of t.needs) {
      await needTable.insert({
        plan_key: planKey,
        task_id: t.id,
        capability_ref: need.capabilityRef,
        package: need.package,
        verify_command: need.verifyCommand ?? null,
      });
    }
  }

  const patch: Record<string, unknown> = {
    task_count: tasks.length,
    // Operator-visibility wave progress (wave_count / current_wave / wave_label) was RETIRED as a
    // stored projection (epic #412) — the epics-index reads it from the `plan_wave_label` /
    // `plan_read_model` SQL VIEWs (060/061) derived from `plan_tasks`, so this worker no longer
    // denormalises it onto the `plans` row.
    updated_at: ts,
  };
  if (tasks.length > 0) {
    patch.status = "dispatched";
  } else {
    // Taskless plan: DO NOT collapse to terminal `done` (issue #624). "The planner produced nothing
    // this pass" is an INTERMEDIATE state, NOT an ended process — the plan-fanout instance is still
    // live and may re-plan, escalate, or be cancelled. Terminal `plans.status` must follow ENGINE
    // instance liveness, not this per-pass empty-plan heuristic, or the epic renders "Done" over a
    // still-active (in fact looping) instance. So the plan stays NON-terminal (`planning`) until the
    // poller sees the instance actually end: COMPLETED → `done` (pollTasklessPlanTermination,
    // app/service.ts — the same poller that owns the delivery-graph COMPLETED→done transition) or
    // TERMINATED → `abandoned` (instanceTracking's `onTerminated` derived edge). The outcome note is
    // still recorded for observability; it is phase/label copy, not a terminal-status signal.
    patch.status = "planning";
    patch.outcome = note ? str(note) : "planner emitted no tasks";
  }
  await plans(app.data).update(planKey, patch);

  // Kick off the wave loop at wave 0. `taskCount` lets the BPMN gateway (`gw-plan-empty`) route an
  // empty plan to the operator empty-plan escalation instead of the review loop (issues #623/#624).
  return { currentWave: 0, waveCount, taskCount: tasks.length };
};

export default handler;
