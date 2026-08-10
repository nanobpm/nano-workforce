// nano-workforce — planning fan-out logic (issue #14).
//
// A planning agent (`senior:plan`) decomposes an issue into a list of tasks; the
// `plan-fanout` process then fans those tasks out over a parallel multi-instance
// service task (`senior:feature`), one implementation agent per task. Each agent
// opens a PR, which `record-results` enrolls into the existing convergence loop.
//
// This module is the seam the start actions and the record workers call: it owns
// issue parsing, the plan/plan_tasks row shapes, the prompt assets, and starting
// the process. Data access goes through the record gateway (`data.table`), never
// hand-written SQL — matching app/service.ts.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import {
	blackboardUrl,
	mintBlackboardToken,
	renderCoordinationBrief,
} from "./blackboard.ts";
import { clearExclusions } from "./mergeExclusion.ts";
import { clearTaskDeltas } from "./taskDelta.ts";

/** The BPMN process this module drives (resources/processes/plan-fanout.bpmn). */
export const PLAN_PROCESS_ID = "plan-fanout";

const now = () => new Date().toISOString();

// Agent prompts are no longer read by the host. The `senior:plan`, `senior:plan-review`, and
// `senior:feature` prompts are authored in the model as `{{plan}}` / `{{plan-review}}` /
// `{{feature}}` deploy-time templates (see `models.templates` in nano.app.json) substituted into
// each task's `io.nanobpm.agentTask.task.prompt` header. Per-instance dynamic context (a plan's
// rejection findings, a task's brief) rides `appendPrompt`, which the harness concatenates onto
// the header base. The host only carries runtime identity + `planFindings`.

export interface Plan {
	plan_key: string;
	repo: string;
	issue_number: number;
	issue_url: string;
	title: string | null;
	status: string;
	task_count: number;
	process_key: string | null;
	outcome: string | null;
	// Denormalised "oldest open task escalation" pointer (issue #25): the plans page
	// detail has a single answer form per row, so the oldest still-open per-task
	// escalation is surfaced here; answering re-points these at the next one (or
	// clears them). See refreshOpenTaskEscalation.
	open_task_escalation_id: number | null;
	open_task_question: string | null;
	open_task_corr_key: string | null;
	open_task_id: string | null;
	// Wave-merge barrier (007_wave_gate.sql): the wave index whose PRs the plan is currently
	// waiting to see MERGED before dispatching the next wave, or null when not parked at the barrier.
	gate_wave: number | null;
	// Per-plan capability token for the coordination blackboard (009_plan_blackboard.sql, #51).
	// Minted at plan start; baked into the blackboard URL handed to implementer agents. NULL for
	// plans created before the blackboard shipped.
	blackboard_token: string | null;
	created_at: string;
	updated_at: string;
}

export interface PlanTask {
	id: number;
	plan_key: string;
	task_index: number;
	task_id: string;
	title: string | null;
	prompt: string | null;
	status: PlanTaskStatus;
	pr_key: string | null;
	summary: string | null;
	wave: number | null;
	// Implementation-phase escalation (issue #25): the agent's open question, the
	// human's answer, the work-preserving draft PR, and the message correlation key
	// (`<plan_key>:<task_id>`) the process parks on. NULL unless the task escalated.
	open_question: string | null;
	answer: string | null;
	draft_pr_key: string | null;
	corr_key: string | null;
	created_at: string;
	updated_at: string;
}

export const PLAN_TASK_STATUSES = [
	"pending",
	"opened",
	"blocked",
	"skipped",
	"escalated",
	"waiting-for-lane",
] as const;
export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number];

/** One implementation-phase escalation (issue #25) — the per-task analogue of the
 * review loop's `escalations` row. `status` is open | answered. */
export interface PlanEscalation {
	id: number;
	plan_key: string;
	task_id: string;
	corr_key: string;
	question: string;
	answer: string | null;
	draft_pr_key: string | null;
	status: string;
	asked_at: string;
	answered_at: string | null;
}

export const plans = (data: DataLayer) => data.table<Plan>("plans", "plan_key");
export const planTasks = (data: DataLayer) =>
	data.table<PlanTask>("plan_tasks", "id");
export const planEscalations = (data: DataLayer) =>
	data.table<PlanEscalation>("plan_escalations", "id");

/** The message the plan-fanout process catches to resume an escalated task; its
 * subscription correlates on `<plan_key>:<task_id>` (see plan-fanout.bpmn). */
export const FEATURE_ESCALATION_MESSAGE = "feature-escalation-answered";

/** Build the per-task message correlation key the process parks on. */
export const featureCorrKey = (planKey: string, taskId: string) =>
	`${planKey}:${taskId}`;

/** One dependency edge in the plan DAG (issue #20): `task_id` waits for `depends_on_task_id`.
 * Keyed on `plan_key` so a single delete clears a plan's whole edge set (as pr_dependencies). */
export interface PlanTaskDep {
	plan_key: string;
	task_id: string;
	depends_on_task_id: string;
}
export const planTaskDeps = (data: DataLayer) =>
	data.table<PlanTaskDep>("plan_task_deps", "plan_key");

/** One adversarial plan-review round (006_plan_review.sql): the `senior:plan-review` agent's
 * verdict on the plan before fan-out. Append-only within a plan run; the current round is
 * `count(plan_reviews)`. Re-planning a finished issue clears the prior rows (see startPlan) so
 * the round index restarts at 0.
 * `job_key` is the engine job key that wrote the row — an idempotency guard so a retried job
 * (crash/timeout after the insert) reuses its row instead of appending a duplicate round. */
export interface PlanReview {
	plan_key: string;
	round: number;
	approved: number;
	findings: string | null;
	created_at: string;
	job_key: string | null;
}
export const planReviews = (data: DataLayer) =>
	data.table<PlanReview>("plan_reviews", "plan_key");

/** Read a positive-integer env override, falling back when unset/blank/invalid. A bad value
 * (e.g. "", "abc", "0", "2.5") must NOT silently become `NaN`/`0` — that would make the round
 * cap `round + 1 >= cap` always false and allow an unbounded revise loop. */
export function positiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw == null || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Max adversarial plan-review rounds. Reaching the cap WITHOUT approval is a hard failure: the
 * fan-out raises a `PLAN_REJECTED` incident rather than dispatching an un-approved plan (issue
 * #86). The last round's findings are still recorded. */
export const MAX_PLAN_REVIEW_ROUNDS = positiveIntEnv(
	"NANO_PLAN_REVIEW_ROUNDS",
	3,
);

/** A plan is "done" in exactly these states; everything else (planning, dispatched)
 * is in flight. The cancel guard and the active view key off this. */
export const PLAN_TERMINAL_STATUSES: readonly string[] = [
	"done",
	"failed",
	"abandoned",
];

export interface ParsedIssue {
	repo: string;
	number: number;
	url: string;
	planKey: string;
}

/** Parse "owner/repo#123" or a canonical issue URL into its parts. Mirrors parsePr
 * (app/service.ts) but for the /issues/ path. */
export function parseIssue(input: string): ParsedIssue | null {
	const s = input.trim();
	let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
	if (m) {
		const repo = `${m[1]}/${m[2]}`;
		const number = Number(m[3]);
		return {
			repo,
			number,
			url: `https://github.com/${repo}/issues/${number}`,
			planKey: `${repo}#${number}`,
		};
	}
	m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
	if (m) {
		const repo = m[1];
		const number = Number(m[2]);
		return {
			repo,
			number,
			url: `https://github.com/${repo}/issues/${number}`,
			planKey: `${repo}#${number}`,
		};
	}
	return null;
}

/** Register a plan row (if new) and start the plan-fanout process. Idempotent on
 * planKey: a plan already in flight is not restarted. */
export async function startPlan(
	data: DataLayer,
	engine: EngineClient,
	parsed: ParsedIssue,
) {
	const table = plans(data);
	const existing = await table.get(parsed.planKey);
	if (existing && !PLAN_TERMINAL_STATUSES.includes(existing.status)) {
		return { planKey: parsed.planKey, alreadyRunning: true };
	}
	const ts = now();
	// Mint (or reuse, on a re-plan) this plan's blackboard capability token, and render the
	// coordination brief that carries its concrete URL. The token is the credential; agents reach
	// the blackboard directly with the URL we seed into `appendPrompt` below (#51).
	const token = existing?.blackboard_token ?? mintBlackboardToken();
	const bbUrl = blackboardUrl(token);
	if (existing) {
		// Re-plan a previously finished issue: clear the old tasks and start fresh.
		for (const t of await planTasks(data).find({ plan_key: parsed.planKey })) {
			await planTasks(data).delete(t.id);
		}
		// `plan_reviews` is append-only and the review round is derived from
		// `count(plan_reviews)`, so stale rows from the prior run would inflate the
		// next round index and reach the review-round cap early (bypassing the gate).
		// Clear them here — the table is keyed on `plan_key`, so one delete drops the
		// whole set (mirrors how record-plan clears `plan_task_deps`).
		await planReviews(data).delete(parsed.planKey);
		// Same class of stale-row bug for the implementation-phase escalation state
		// (issue #25): `plan_escalations` is keyed on `id` (not `plan_key`), so drop
		// the prior run's rows one-by-one. Otherwise a still-"open" escalation from
		// the previous run survives the re-plan and `refreshOpenTaskEscalation`
		// re-surfaces a question for a `task_id` we just deleted from `plan_tasks`.
		for (const e of await planEscalations(data).find({
			plan_key: parsed.planKey,
		})) {
			await planEscalations(data).delete(e.id);
		}
		// Same for the structured impl-change deltas (D5, #55): keyed on `id`, so drop the prior run's
		// rows one-by-one, otherwise a stale delta lingers in the epic report for a task we just deleted.
		await clearTaskDeltas(data, parsed.planKey);
		// And the merge-exclusion graph (D1, #57): stale edges would mislead the merge-train.
		await clearExclusions(data, parsed.planKey);
		await table.update(parsed.planKey, {
			status: "planning",
			task_count: 0,
			issue_url: parsed.url,
			outcome: null,
			// Reset the denormalised "surfaced escalation" pointer so nothing from the
			// prior run lingers on the plan row (would otherwise show a dead answer form).
			open_task_escalation_id: null,
			open_task_question: null,
			open_task_corr_key: null,
			open_task_id: null,
			blackboard_token: token,
			updated_at: ts,
		});
	} else {
		await table.insert({
			plan_key: parsed.planKey,
			repo: parsed.repo,
			issue_number: parsed.number,
			issue_url: parsed.url,
			status: "planning",
			task_count: 0,
			blackboard_token: token,
			created_at: ts,
			updated_at: ts,
		});
	}
	const { processInstanceKey } = await engine.createInstance({
		processDefinitionId: PLAN_PROCESS_ID,
		variables: {
			planKey: parsed.planKey,
			repo: parsed.repo,
			issue: parsed.planKey,
			issueNumber: parsed.number,
			issueUrl: parsed.url,
			planFindings: null,
			// Coordination blackboard (#51): the capability URL + the protocol brief that each
			// implementer agent gets appended to its prompt (composed into `appendPrompt` in
			// plan-fanout.bpmn's implement-task). Advisory shared state, delivered in-band, used
			// out-of-band.
			blackboardUrl: bbUrl,
			blackboardBrief: renderCoordinationBrief(bbUrl),
		},
	});
	const processKey =
		processInstanceKey == null ? null : String(processInstanceKey);
	if (processKey != null) {
		await table.update(parsed.planKey, {
			process_key: processKey,
			updated_at: now(),
		});
	}
	return { planKey: parsed.planKey, processKey };
}

/** Re-point a plan's denormalised "open task escalation" fields at its OLDEST
 * still-open `plan_escalations` row (or clear them when none remain). The page
 * runtime binds a single answer form per plan row, so parallel escalations are
 * surfaced one at a time, oldest-first; this is called after opening an
 * escalation and after answering one. */
export async function refreshOpenTaskEscalation(
	data: DataLayer,
	planKey: string,
) {
	const open = (
		await planEscalations(data).find({ plan_key: planKey, status: "open" })
	).sort((a, b) => a.id - b.id)[0];
	await plans(data).update(planKey, {
		open_task_escalation_id: open ? open.id : null,
		open_task_question: open ? open.question : null,
		open_task_corr_key: open ? open.corr_key : null,
		open_task_id: open ? open.task_id : null,
		updated_at: now(),
	});
}

/** Answer an open implementation-phase escalation → record it, resume the parked
 * task via the correlated `feature-escalation-answered` message, and re-surface
 * the next-oldest open escalation (if any). Keyed by the correlation key
 * (`<plan_key>:<task_id>`) so an external webhook and the page share one path.
 * Idempotent-ish: a corr_key with no open escalation is a 404-style no-op. */
export async function answerTaskEscalation(
	data: DataLayer,
	engine: EngineClient,
	corrKey: string,
	answer: string,
) {
	const open = (
		await planEscalations(data).find({ corr_key: corrKey, status: "open" })
	).sort((a, b) => b.id - a.id)[0];
	if (!open) return { ok: false, reason: "no open escalation" };
	const ts = now();
	await planEscalations(data).update(open.id, {
		answer,
		status: "answered",
		answered_at: ts,
	});
	// Mirror onto the task row so a re-dispatched agent (and the UI) sees the answer.
	for (const t of await planTasks(data).find({
		plan_key: open.plan_key,
		task_id: open.task_id,
	})) {
		await planTasks(data).update(t.id, { answer, updated_at: ts });
	}
	// Resume the parked child: the process merges `answer` into the child scope and
	// loops back to re-dispatch the SAME task on its existing branch.
	await engine.publishMessage({
		name: FEATURE_ESCALATION_MESSAGE,
		correlationKey: corrKey,
		variables: { answer },
	});
	await refreshOpenTaskEscalation(data, open.plan_key);
	return {
		ok: true,
		escalationId: open.id,
		planKey: open.plan_key,
		taskId: open.task_id,
	};
}
