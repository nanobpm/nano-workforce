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
import type { DataLayer, EngineClient, Logger } from "@nanobpm/urban";
import { isUniqueViolation, readBlackboard } from "./blackboard.ts";
import { gatherConformance, hasDeliveredImplementation } from "./conformance.ts";
import { TERMINAL_STATUSES } from "./delivery.ts";
import { planReviews, planTasks } from "./plan.ts";
import { aggregateEpicDeltas } from "./taskDelta.ts";

export const RETRO_PROCESS_ID = "retro";

/** Opt-out env toggle. Retro runs by default; set NANO_AUTO_RETRO=0/false to disable (e.g. in a
 * review-only deployment that doesn't want the fleet opening promotion PRs). */
export function autoRetroEnabled(): boolean {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.NANO_AUTO_RETRO;
  if (v == null) return true;
  const s = v.trim().toLowerCase();
  return s !== "0" && s !== "false" && s !== "off" && s !== "no";
}

const now = () => new Date().toISOString();

/** A PR is in a terminal state (derived from app/service.ts TERMINAL_STATUSES, the single source of
 * truth). A plan is settled only once every PR-producing task has reached one of these. */
const TERMINAL_PR_STATUSES = new Set(TERMINAL_STATUSES);

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
const retroStartsTbl = (data: DataLayer) =>
  data.table<{ plan_key: string; started_at: string }>("plan_retro_starts", "plan_key");

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
  // Plan-review trace (006_plan_review.sql): how many adversarial review rounds the plan needed
  // before fan-out, and the critique from every rejected round — the "what was wrong with the
  // first cut of the decomposition" signal, which is prime retro material even when implementers
  // posted no learnings of their own. `planApproved` reflects the final round's verdict.
  reviewRounds: number;
  reviewRejections: { round: number; findings: string }[];
  planApproved: boolean;
  // Execution shape: how the plan's tasks actually resolved (opened a PR, were skipped/blocked,
  // etc.). Lets the retro reason over decomposition accuracy — e.g. a high skipped/blocked ratio
  // hints the plan over-decomposed.
  taskOutcomes: { total: number; byStatus: Record<string, number> };
  counts: { learnings: number; deltas: number; notes: number };
}

/** Gather a plan's reflection material: the `learning` blackboard entries (the headline), plus the
 * task-delta rollup (contract changes, discovered constraints, cross-slice file touches), the
 * plan-review trace (rounds + rejection findings), the task-outcome shape, and any other
 * non-learning blackboard notes for colour. Reads only — no writes. */
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

  // Plan-review trace, ordered by round. A rejected round is `approved === 0`; only rounds that
  // carry findings are worth quoting (an empty rejection has nothing to teach).
  const reviews = (await planReviews(data).find({ plan_key: planKey }))
    .slice()
    .sort((a, b) => a.round - b.round);
  const reviewRejections = reviews
    .filter((r) => r.approved === 0 && (r.findings ?? "").trim() !== "")
    // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
    .map((r) => ({ round: r.round, findings: r.findings as string }));
  const planApproved = reviews.length > 0 && reviews[reviews.length - 1].approved === 1;

  // Task-outcome shape (counts by final status).
  const tasks = await planTasks(data).find({ plan_key: planKey });
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

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
    reviewRounds: reviews.length,
    reviewRejections,
    planApproved,
    taskOutcomes: { total: tasks.length, byStatus },
    counts: {
      learnings: learnings.length,
      deltas: deltas.deltas.length,
      notes: notes.length,
    },
  };
}

/** Render the digest as the compact markdown brief handed to the retro agent (rides `appendPrompt`,
 * concatenated after the base `retro.md` linked-resource prompt — so it owns its own leading separator). */
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
    `### Plan review — ${d.reviewRounds} round(s), ${d.planApproved ? "approved" : "not approved"}`,
  ];
  if (d.reviewRejections.length === 0) {
    lines.push(
      d.reviewRounds === 0
        ? "_(no review rounds recorded)_"
        : "_(approved with no recorded rejections)_",
    );
  } else {
    lines.push(`The plan was revised after ${d.reviewRejections.length} rejected round(s):`);
    for (const r of d.reviewRejections) lines.push(`- **round ${r.round}**: ${r.findings}`);
  }
  if (d.taskOutcomes.total > 0) {
    const shape = Object.entries(d.taskOutcomes.byStatus)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([s, n]) => `${s}: ${n}`)
      .join(", ");
    lines.push("", `### Task outcomes (${d.taskOutcomes.total} task(s))`, shape);
  }
  lines.push(
    "",
    `### Learnings agents posted while implementing (${d.learnings.length})`,
  );
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

/** True when a digest carries nothing worth an agent run. A plan is worth retrospecting when
 * implementers shared material (learnings/deltas/notes) OR the plan itself needed revision — a
 * rejected review round's findings are reflection material in their own right, even when no
 * learning was posted. (Task-outcome shape alone is NOT: a cleanly-approved plan whose tasks all
 * ran has nothing to teach.) */
export function isDigestEmpty(d: RetroDigest): boolean {
  return d.counts.learnings === 0 && d.counts.deltas === 0 && d.counts.notes === 0 &&
    d.reviewRejections.length === 0;
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

async function claimRetroStart(data: DataLayer, planKey: string): Promise<boolean> {
  try {
    await retroStartsTbl(data).insert({ plan_key: planKey, started_at: now() });
    return true;
  } catch (err) {
    // Only a UNIQUE/PK collision means "another starter already elected itself" — a benign
    // duplicate the fire-once guard exists to detect. Any other constraint (e.g. a FOREIGN KEY
    // failure from a missing plan row) is real corruption and must propagate, not be swallowed.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Upsert a plan's retro row (idempotent on plan_key, so a job retry overwrites in place).
 *
 * Insert-first, then fall back to update only on a verified unique/PK violation: a get-then-insert
 * can race (two concurrent retries both see no row, then one insert wins and the other throws), so
 * we treat "row already exists" as the update path rather than an error. */
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
  try {
    await retrosTbl(data).insert({ plan_key: planKey, created_at: ts, ...fields });
  } catch (err) {
    // Fall back to update only on a verified UNIQUE/PK violation (the get-then-insert race, or a
    // job retry). Restrict to unique/duplicate/primary-key: a FOREIGN KEY (or other) constraint
    // failure would otherwise be swallowed here, making the write look successful while doing
    // nothing — so rethrow anything that isn't a duplicate-row collision.
    if (!isUniqueViolation(err)) throw err;
    await retrosTbl(data).update(planKey, fields);
  }
}

/** Called from a PR's terminal point (mark-merged / finalize review-only). If that PR was the last
 * of its plan to land AND there is anything to reflect on, start the `retro` process exactly once.
 *
 * Best-effort and non-blocking: any failure here must never fail the terminal job that called it —
 * the retro is advisory. The fire-once guard is `plan_retro_starts`: a PRIMARY KEY insert
 * atomically elects one starter across app processes before we stamp `plans.retro_started_at`
 * and start the instance. */
export async function maybeStartRetro(
  data: DataLayer,
  engine: EngineClient,
  prKey: string,
  log?: Logger,
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
    // The retro digest can be empty (no learnings/deltas/notes, cleanly-approved plan) yet the epic
    // still shipped real code — in which case conformance has something to verify even though the
    // lessons agent has nothing to distil. So run whenever there is EITHER reflection material OR
    // landed implementation to audit; only truly skip when there is neither.
    const conformance = await gatherConformance(data, planKey);
    if (isDigestEmpty(digest) && !hasDeliveredImplementation(conformance)) {
      if (!(await claimRetroStart(data, planKey))) return { started: false, planKey, reason: "already-started" };
      // Nothing to reflect on and nothing shipped to verify — stamp anyway so we don't re-check on
      // every future terminal PR of a (now settled) plan, and record a skipped retro for visibility.
      await plansTbl(data).update(planKey, { retro_started_at: now(), updated_at: now() });
      await recordRetro(data, planKey, { status: "skipped", summary: "No learnings, deltas, notes, or landed implementation to retrospect." });
      return { started: false, planKey, reason: "nothing-to-retro" };
    }

    if (!(await claimRetroStart(data, planKey))) return { started: false, planKey, reason: "already-started" };

    // Stamp before starting so restarts/retries can take the cheap already-started path.
    await plansTbl(data).update(planKey, { retro_started_at: now(), updated_at: now() });

    let processInstanceKey: string | number | undefined;
    try {
      ({ processInstanceKey } = await engine.createInstance({
        processDefinitionId: RETRO_PROCESS_ID,
        variables: {
          planKey,
          repo: digest.repo,
          issueUrl: digest.issueUrl,
        },
      }));
    } catch (err) {
      // The fire-once guard is already consumed (retro_started_at stamped, plan_retro_starts
      // claimed), so this plan will never re-enter the start path. If we returned here with no
      // record, the epic surface would show a plan that "started a retro" with nothing to show and
      // no way to retry. Persist a `blocked` retro instead so the failure stays visible and the
      // system state is consistent. Recording must not mask the original error in the log.
      log?.error(`retro: could not start process for epic ${planKey}`, { err: String(err) });
      // Persisting the blocked record is best-effort: recordRetro rethrows non-unique DB errors, and
      // if that escaped here it would fall through to the outer catch and return `error` instead of
      // `start-failed` — reintroducing the very silent-gap failure this path guards against (guard
      // consumed, no durable record). Swallow a secondary persistence failure and log it separately
      // so the createInstance failure path always reports `start-failed`.
      try {
        await recordRetro(data, planKey, {
          status: "blocked",
          summary: `Retro process could not be started: ${String(err)}`,
        });
      } catch (persistErr) {
        log?.error(`retro: could not persist blocked retro for epic ${planKey}`, {
          err: String(persistErr),
        });
      }
      return { started: false, planKey, reason: "start-failed" };
    }
    log?.info(`retro: started for epic ${planKey}`, { processInstanceKey, learnings: digest.counts.learnings });
    return { started: true, planKey };
  } catch (err) {
    log?.error(`retro: could not start for PR ${prKey}`, { err: String(err) });
    return { started: false, reason: "error" };
  }
}
