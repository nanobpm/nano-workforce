// Epic retrospective — the post-completion reflection stage (016_plan_retro.sql).
//
// The blackboard's `learning` kind (app/blackboard.ts) lets implementer agents share reusable
// gotchas *while they work*. This module closes the loop: when an epic finishes, a retro agent
// distils those learnings (plus task deltas and escalations) and promotes the recurring ones into
// the target repo's AGENTS.md / a script / a CI step, via a human-reviewed PR.
//
// "Epic finished" is emergent, not a single BPMN node: `plan-fanout` only DISPATCHES the fleet
// (it marks the plan `done` at dispatch time), after which each PR lands asynchronously on its own
// `merge-loop`. So the true completion signal is *the last of a plan's PRs reaching a terminal
// state*. `maybeStartRetro` is called from the two terminal points — `pr.mark-merged` (auto-merge)
// and `pr.finalize`'s review-only `converged` path — and fires the retro exactly once.
//
// Data access goes through the record gateway (`data.table`), never hand-written SQL — matching
// app/plan.ts, app/blackboard.ts, and app/taskDelta.ts.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { planTasks } from "./plan.ts";
import { readBlackboard } from "./blackboard.ts";
import { aggregateEpicDeltas } from "./taskDelta.ts";

export const RETRO_PROCESS_ID = "retro";

/** Opt-out env toggle. Retro runs by default; set NANO_AUTO_RETRO=0/false to disable (e.g. in a
 * review-only deployment that doesn't want the fleet opening promotion PRs). */
export function autoRetroEnabled(): boolean {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.NANO_AUTO_RETRO;
  if (v == null) return true;
  const s = v.trim().toLowerCase();
  return s !== "0" && s !== "false" && s !== "off" && s !== "no";
}

const now = () => new Date().toISOString();

/** A PR is in a terminal state (mirrors app/service.ts TERMINAL_STATUSES). A plan is settled only
 * once every PR-producing task has reached one of these. */
const TERMINAL_PR_STATUSES = new Set(["converged", "merged", "abandoned"]);

/** Task statuses that are settled WITHOUT a landed PR: the planner/dispatcher decided not to (or
 * could not) produce one, so they never block epic completion. `escalated`/`waiting-for-lane` are
 * still in flight; `pending`/`opened` are checked against their PR. */
const SETTLED_TASKLESS = new Set(["skipped", "blocked"]);

interface PlanRow extends Record<string, unknown> {
  plan_key: string;
  repo: string;
  issue_url: string;
  title: string | null;
  status: string;
  retro_started_at?: string | null;
}

const plansTbl = (data: DataLayer) => data.table<PlanRow>("plans", "plan_key");
const prsTbl = (data: DataLayer) =>
  data.table<{ pr_key: string; status: string }>("pull_requests", "pr_key");

/** Resolve the plan a PR belongs to, or undefined when the PR was submitted standalone (not part
 * of a fan-out). A PR is linked to a plan via the `plan_tasks.pr_key` it produced. */
export async function planKeyForPr(data: DataLayer, prKey: string): Promise<string | undefined> {
  if (!prKey) return undefined;
  const row = await planTasks(data).findOne({ pr_key: prKey });
  return row?.plan_key;
}

/** Is every one of a plan's tasks settled? Settled = skipped/blocked (never produced a landing
 * PR), or a task whose PR has reached a terminal state. A `pending`/`escalated`/`waiting-for-lane`
 * task, or an `opened` task whose PR is still in flight, means the epic is not done yet. */
export async function isPlanComplete(data: DataLayer, planKey: string): Promise<boolean> {
  const tasks = await planTasks(data).find({ plan_key: planKey });
  if (tasks.length === 0) return false; // an empty plan has nothing to retrospect
  for (const t of tasks) {
    if (SETTLED_TASKLESS.has(t.status)) continue;
    // Any task that is meant to yield a PR must have a terminal PR to be settled.
    if (!t.pr_key) return false; // pending/escalated/etc. with no PR yet → still in flight
    const pr = await prsTbl(data).get(t.pr_key);
    if (!pr || !TERMINAL_PR_STATUSES.has(pr.status)) return false;
  }
  return true;
}

/** The material a retro reflects on, assembled from a plan's advisory knowledge. */
export interface RetroDigest {
  planKey: string;
  repo: string;
  issueUrl: string;
  title: string | null;
  learnings: { author_task: string; body: string; created_at: string }[];
  touchedFiles: string[];
  contractChanges: { taskId: string; change: string }[];
  constraints: { taskId: string; constraint: string }[];
  notes: { author_task: string; kind: string; body: string }[];
  counts: { learnings: number; deltas: number; notes: number };
}

/** Gather a plan's reflection material: the `learning` blackboard entries (the headline), plus the
 * task-delta rollup (contract changes, discovered constraints, cross-slice file touches) and any
 * other non-learning blackboard notes for colour. Reads only — no writes. */
export async function gatherRetro(data: DataLayer, planKey: string): Promise<RetroDigest> {
  const plan = await plansTbl(data).get(planKey);
  const entries = await readBlackboard(data, planKey);
  const learnings = entries
    .filter((e) => e.kind === "learning")
    .map((e) => ({ author_task: e.author_task, body: e.body, created_at: e.created_at }));
  const notes = entries
    .filter((e) => e.kind !== "learning")
    .map((e) => ({ author_task: e.author_task, kind: e.kind, body: e.body }));
  const deltas = await aggregateEpicDeltas(data, planKey);
  return {
    planKey,
    repo: plan?.repo ?? planKey.split("#")[0] ?? "",
    issueUrl: plan?.issue_url ?? "",
    title: plan?.title ?? null,
    learnings,
    touchedFiles: deltas.touchedFiles,
    contractChanges: deltas.contractChanges,
    constraints: deltas.constraints,
    notes,
    counts: {
      learnings: learnings.length,
      deltas: deltas.deltas.length,
      notes: notes.length,
    },
  };
}

/** Render the digest as the compact markdown brief handed to the retro agent (rides `appendPrompt`,
 * concatenated after the base `{{retro}}` prompt — so it owns its own leading separator). */
export function renderRetroBrief(d: RetroDigest): string {
  const lines: string[] = [
    "",
    "",
    "---",
    "",
    `## Retro input — epic ${d.planKey}`,
    "",
    `Target repo: **${d.repo}**${d.issueUrl ? ` · issue: ${d.issueUrl}` : ""}`,
    d.title ? `Epic: ${d.title}` : "",
    "",
    `### Learnings agents posted while implementing (${d.learnings.length})`,
  ];
  if (d.learnings.length === 0) {
    lines.push("_(none — agents posted no `learning` entries for this epic)_");
  } else {
    for (const l of d.learnings) lines.push(`- **[${l.author_task}]** ${l.body}`);
  }
  if (d.constraints.length > 0) {
    lines.push("", `### Constraints discovered (${d.constraints.length})`);
    for (const c of d.constraints) lines.push(`- **[${c.taskId}]** ${c.constraint}`);
  }
  if (d.contractChanges.length > 0) {
    lines.push("", `### Contract changes (${d.contractChanges.length})`);
    for (const c of d.contractChanges) lines.push(`- **[${c.taskId}]** ${c.change}`);
  }
  if (d.touchedFiles.length > 0) {
    lines.push("", `### Files touched beyond original slices`, d.touchedFiles.map((f) => `\`${f}\``).join(", "));
  }
  if (d.notes.length > 0) {
    lines.push("", `### Other blackboard notes (${d.notes.length})`);
    for (const n of d.notes) lines.push(`- **[${n.author_task}]** _${n.kind}_: ${n.body}`);
  }
  return lines.join("\n");
}

/** True when a digest carries nothing worth an agent run — no learnings, no deltas, no notes. */
export function isDigestEmpty(d: RetroDigest): boolean {
  return d.counts.learnings === 0 && d.counts.deltas === 0 && d.counts.notes === 0;
}

/** The persisted retro shape (written by pr.retro-record). */
export interface RetroInput {
  status: string; // filed | skipped | blocked
  prKey?: string | null;
  learnings?: number;
  summary?: string | null;
  report?: string | null;
}

const retrosTbl = (data: DataLayer) =>
  data.table<{ plan_key: string } & Record<string, unknown>>("plan_retros", "plan_key");

/** Upsert a plan's retro row (idempotent on plan_key, so a job retry overwrites in place). */
export async function recordRetro(
  data: DataLayer,
  planKey: string,
  input: RetroInput,
): Promise<void> {
  const ts = now();
  const fields = {
    status: input.status,
    pr_key: input.prKey ?? null,
    learnings: input.learnings ?? 0,
    summary: input.summary ?? null,
    report: input.report ?? null,
    updated_at: ts,
  };
  const existing = await retrosTbl(data).get(planKey);
  if (existing) {
    await retrosTbl(data).update(planKey, fields);
  } else {
    await retrosTbl(data).insert({ plan_key: planKey, created_at: ts, ...fields });
  }
}

/** Called from a PR's terminal point (mark-merged / finalize review-only). If that PR was the last
 * of its plan to land AND there is anything to reflect on, start the `retro` process exactly once.
 *
 * Best-effort and non-blocking: any failure here must never fail the terminal job that called it —
 * the retro is advisory. The fire-once guard is `plans.retro_started_at`: we stamp it BEFORE
 * starting the instance, so a sibling PR of the same plan reaching terminal state concurrently
 * finds it non-null and bails. (Job handlers for one app run in a single process, so the
 * check-then-stamp window is not a practical race; the stamp still guards restarts and retries.) */
export async function maybeStartRetro(
  data: DataLayer,
  engine: EngineClient,
  prKey: string,
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void,
): Promise<{ started: boolean; planKey?: string; reason?: string }> {
  if (!autoRetroEnabled()) return { started: false, reason: "disabled" };
  try {
    const planKey = await planKeyForPr(data, prKey);
    if (!planKey) return { started: false, reason: "no-plan" };

    const plan = await plansTbl(data).get(planKey);
    if (!plan) return { started: false, reason: "no-plan" };
    if (plan.retro_started_at) return { started: false, planKey, reason: "already-started" };

    if (!(await isPlanComplete(data, planKey))) return { started: false, planKey, reason: "incomplete" };

    const digest = await gatherRetro(data, planKey);
    if (isDigestEmpty(digest)) {
      // Nothing to reflect on — stamp anyway so we don't re-check on every future terminal PR of a
      // (now settled) plan, and record a skipped retro for visibility.
      await plansTbl(data).update(planKey, { retro_started_at: now(), updated_at: now() });
      await recordRetro(data, planKey, { status: "skipped", summary: "No learnings, deltas, or notes to retrospect." });
      return { started: false, planKey, reason: "nothing-to-retro" };
    }

    // Fire-once: stamp before starting so a concurrent sibling terminal PR bails.
    await plansTbl(data).update(planKey, { retro_started_at: now(), updated_at: now() });

    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: RETRO_PROCESS_ID,
      variables: {
        planKey,
        repo: digest.repo,
        issueUrl: digest.issueUrl,
      },
    });
    log?.("info", `retro: started for epic ${planKey}`, { processInstanceKey, learnings: digest.counts.learnings });
    return { started: true, planKey };
  } catch (err) {
    log?.("error", `retro: could not start for PR ${prKey}`, { err: String(err) });
    return { started: false, reason: "error" };
  }
}
