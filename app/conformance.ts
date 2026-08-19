// Spec-conformance review — "did we build what the spec asked for?", examined against the ACTUAL
// implementation.
//
// It rides the existing `retro` process (app/retro.ts): when an epic's last PR lands, a
// `senior:conformance` agent runs BEFORE the lessons agent. Unlike retro — which reflects on what
// implementers *claimed* via `learning` blackboard entries and task deltas — conformance is
// deliberately grounded in the code: the digest it builds hands the agent the spec (the epic issue
// + every slice's `prompt`) and the set of PRs that actually LANDED, so the agent reads the real
// diffs/code/tests (`gh pr diff`, `git`) and verifies delivery rather than trusting the transcript.
//
// It surfaces two classes of deviation: those RAISED during implementation (`scope-change`
// blackboard entries — quoted here so the agent can reconcile them) and those it finds itself that
// were NEVER raised. The result is persisted to `plan_conformance` (052_plan_conformance.sql).
//
// Data access goes through the record gateway (`data.table`), never hand-written SQL — matching
// app/retro.ts, app/plan.ts, and app/blackboard.ts.
import type { DataLayer } from "@nanobpm/urban";
import { type BlackboardEntry, isUniqueViolation, readBlackboard } from "./blackboard.ts";
import { TERMINAL_STATUSES } from "./delivery.ts";
import { planTasks } from "./plan.ts";

const now = () => new Date().toISOString();

/** The BPMN `elementId` of the conformance escalation user task (retro.bpmn). The inbox reconciler
 * (`pollUserTasks`) and the human completer (`HUMAN_COMPLETABLE_ELEMENTS`) key off this. */
export const CONFORMANCE_ESCALATION_ELEMENT = "conformance-escalation";

/** The `review_status` a `plan_conformance` row carries while its escalation ack task is OPEN — the
 * only status `pollUserTasks` scans (migration 054). Every settled run is `reviewed`. */
export const CONFORMANCE_REVIEWING_STATUS = "reviewing";

/** A slice PR "landed" — its implementation is really in the tree and worth examining — when its
 * PR reached a terminal state that isn't `abandoned`. In auto-merge mode that terminal is `merged`;
 * in review-only mode it is `converged`. Derived from app/delivery.ts TERMINAL_STATUSES (the single
 * source of truth for PR-terminal states) minus `abandoned`, so conformance and retro can't drift
 * about what counts as landed. */
const LANDED_PR_STATUSES = new Set(TERMINAL_STATUSES.filter((s) => s !== "abandoned"));

interface PlanRow extends Record<string, unknown> {
  plan_key: string;
  repo: string;
  issue_url: string;
  title: string | null;
}

const plansTbl = (data: DataLayer) => data.table<PlanRow>("plans", "plan_key");
const prsTbl = (data: DataLayer) =>
  data.table<{ pr_key: string; status: string }>("pull_requests", "pr_key");

/** A slice's PR "landed" iff it exists and reached a non-abandoned terminal status. The single
 * predicate both {@link gatherConformance} and {@link hasDeliveredImplementationForPlan} apply, so
 * the full digest and the cheap trigger check can't disagree about what counts as landed. */
async function isLanded(data: DataLayer, prKey: string | null | undefined): Promise<boolean> {
  if (!prKey) return false;
  const pr = await prsTbl(data).get(prKey);
  return !!pr && LANDED_PR_STATUSES.has(pr.status);
}
const conformanceTbl = (data: DataLayer) =>
  data.table<{ plan_key: string } & Record<string, unknown>>("plan_conformance", "plan_key");

/** A `plan_conformance` row viewed as a retro-run tracking record, for the inbox reconciler. */
export interface ConformanceReviewRow extends Record<string, unknown> {
  plan_key: string;
  process_key: string | null;
  review_status: string;
  summary: string | null;
}

const conformanceReviewsTbl = (data: DataLayer) =>
  data.table<ConformanceReviewRow>("plan_conformance", "plan_key");

/** The conformance runs whose escalation ack task is still open (`review_status = 'reviewing'`) —
 * the set `pollUserTasks` scans for an open `conformance-escalation` user task. */
export async function activeConformanceReviews(data: DataLayer): Promise<ConformanceReviewRow[]> {
  return await conformanceReviewsTbl(data).find({ review_status: CONFORMANCE_REVIEWING_STATUS });
}

/** The escalation question shown in the inbox row: the agent's conformance summary (which names the
 * reduced / not-verified items and the unraised deviations). Best-effort — NULL when none recorded. */
export function conformanceEscalationQuestion(row: { summary?: unknown } | undefined): string | null {
  const s = row?.summary;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

/** One item of the spec the agent must verify against the code: the slice's planner-supplied
 * `prompt` (its acceptance brief), where it landed, and whether it landed at all. */
export interface ConformanceSlice {
  taskId: string;
  title: string | null;
  prompt: string | null;
  status: string;
  prKey: string | null;
  landed: boolean;
}

/** The material a conformance review examines. Unlike {@link RetroDigest}, this is spec + delivery
 * pointers (not distilled claims) — the agent turns `deliveredPrs` into real diffs to inspect. */
export interface ConformanceDigest {
  planKey: string;
  repo: string;
  issueUrl: string;
  title: string | null;
  slices: ConformanceSlice[];
  /** The landed PR keys ("<owner>/<repo>#<n>") the agent must open and read the diff of. */
  deliveredPrs: string[];
  /** Deviations agents RAISED during implementation (`scope-change` blackboard entries). */
  scopeChanges: { author_task: string; body: string; created_at: string }[];
}

/** Assemble the conformance material for a plan: the spec (issue + each slice's `prompt`), the set
 * of PRs that actually landed (so the agent examines the real implementation), and the scope
 * deviations raised during implementation. Reads only — no writes.
 *
 * `entries` lets a caller that has already scanned the blackboard for this plan (e.g.
 * `pr.retro-gather`, which also runs {@link gatherRetro}) pass those entries in so the plan is
 * scanned once, not once per gatherer — see workers/retro-gather. Omitted, it reads them itself. */
export async function gatherConformance(
  data: DataLayer,
  planKey: string,
  entries?: BlackboardEntry[],
): Promise<ConformanceDigest> {
  const plan = await plansTbl(data).get(planKey);
  const tasks = (await planTasks(data).find({ plan_key: planKey }))
    .slice()
    .sort((a, b) => (a.task_index ?? 0) - (b.task_index ?? 0));

  const slices: ConformanceSlice[] = [];
  const deliveredPrs: string[] = [];
  for (const t of tasks) {
    const landed = await isLanded(data, t.pr_key);
    if (landed && t.pr_key) deliveredPrs.push(t.pr_key);
    slices.push({
      taskId: t.task_id,
      title: t.title ?? null,
      prompt: t.prompt ?? null,
      status: t.status,
      prKey: t.pr_key ?? null,
      landed,
    });
  }

  const scopeChanges = (entries ?? (await readBlackboard(data, planKey)))
    .filter((e) => e.kind === "scope-change")
    .map((e) => ({ author_task: e.author_task, body: e.body, created_at: e.created_at }));

  return {
    planKey,
    repo: plan?.repo ?? planKey.split("#")[0] ?? "",
    issueUrl: plan?.issue_url ?? "",
    title: plan?.title ?? null,
    slices,
    deliveredPrs,
    scopeChanges,
  };
}

/** True when there is real, landed implementation to examine. A plan whose slices were all
 * skipped/blocked/abandoned shipped nothing, so there is nothing to check for conformance — the
 * retro trigger uses this to decide whether the conformance run is worthwhile even when the retro
 * digest itself is empty. */
export function hasDeliveredImplementation(d: ConformanceDigest): boolean {
  return d.deliveredPrs.length > 0;
}

/** Cheap trigger check for the retro gate: does this plan have ANY landed implementation to examine?
 * Inspects only plan_tasks + pull_requests (short-circuiting on the first landed PR) and — unlike
 * {@link gatherConformance} — performs no blackboard scan, so the empty-digest trigger in
 * app/retro.ts doesn't pay to compute `scopeChanges` it would discard. Shares {@link isLanded} with
 * the full digest so the two can't drift on what "landed" means. */
export async function hasDeliveredImplementationForPlan(
  data: DataLayer,
  planKey: string,
): Promise<boolean> {
  const tasks = await planTasks(data).find({ plan_key: planKey });
  for (const t of tasks) {
    if (await isLanded(data, t.pr_key)) return true;
  }
  return false;
}

/** Render the digest as the compact markdown brief handed to the conformance agent (rides
 * `appendPrompt`, concatenated after the base `conformance.md` linked-resource prompt — so it owns
 * its own leading separator). It deliberately gives POINTERS (the spec text + the PRs to open), not
 * conclusions: the agent must reach the verdicts by reading the code. */
export function renderConformanceBrief(d: ConformanceDigest): string {
  const lines: string[] = [
    "",
    "",
    "---",
    "",
    `## Conformance input — epic ${d.planKey}`,
    "",
    `Target repo: **${d.repo}**${d.issueUrl ? ` · issue (the spec): ${d.issueUrl}` : ""}`,
    d.title ? `Epic: ${d.title}` : "",
    "",
    "### Delivered PRs to examine",
  ];
  if (d.deliveredPrs.length === 0) {
    lines.push("_(none landed — no implementation to verify)_");
  } else {
    lines.push(
      `Read the actual diff of each with \`gh pr diff <n> --repo ${d.repo}\` (and the code/tests it touches):`,
    );
    for (const pr of d.deliveredPrs) lines.push(`- ${pr}`);
  }

  lines.push("", `### Spec — the ${d.slices.length} slice(s) planned`);
  if (d.slices.length === 0) {
    lines.push("_(no slices recorded — verify the epic issue body directly)_");
  } else {
    for (const s of d.slices) {
      const where = s.landed && s.prKey ? `landed as ${s.prKey}` : `status: ${s.status}`;
      lines.push("", `#### ${s.taskId}${s.title ? ` — ${s.title}` : ""} (${where})`);
      lines.push(s.prompt ? s.prompt : "_(no per-slice prompt; verify against the epic issue body)_");
    }
  }

  lines.push("", `### Deviations RAISED during implementation (${d.scopeChanges.length})`);
  if (d.scopeChanges.length === 0) {
    lines.push("_(none — no `scope-change` entries were posted; treat any deviation you find as UNRAISED)_");
  } else {
    lines.push("Reconcile each against the delivered code — a raised deviation is still a deviation:");
    for (const c of d.scopeChanges) lines.push(`- **[${c.author_task}]** ${c.body}`);
  }
  return lines.join("\n");
}

/** The persisted conformance shape (written by pr.conformance-record from the agent's result). */
export interface ConformanceInput {
  status: string; // filed | skipped | blocked
  commentUrl?: string | null;
  slicesMet?: number;
  slicesReduced?: number;
  slicesNotVerified?: number;
  deviationsRaised?: number;
  deviationsUnraised?: number;
  hasDeviations?: boolean;
  summary?: string | null;
  report?: string | null;
  /** The retro process instance this conformance ran in — the tracking key `pollUserTasks` reads to
   * find an open escalation user task (migration 054). */
  processKey?: string | null;
  /** Escalation lifecycle: `reviewing` while the ack task is open (poller scans these), else
   * `reviewed`. Defaults to `reviewed` — only an escalation flips it to `reviewing`. */
  reviewStatus?: "reviewing" | "reviewed";
}

/** Upsert a plan's conformance row (idempotent on plan_key, so a job retry overwrites in place).
 *
 * Insert-first, then fall back to update only on a verified unique/PK violation — mirrors
 * {@link recordRetro}: a get-then-insert can race, so "row already exists" is the update path, but
 * any non-duplicate constraint failure must propagate rather than be silently swallowed. */
export async function recordConformance(
  data: DataLayer,
  planKey: string,
  input: ConformanceInput,
): Promise<void> {
  const ts = now();
  const fields = {
    status: input.status,
    comment_url: input.commentUrl ?? null,
    slices_met: input.slicesMet ?? 0,
    slices_reduced: input.slicesReduced ?? 0,
    slices_not_verified: input.slicesNotVerified ?? 0,
    deviations_raised: input.deviationsRaised ?? 0,
    deviations_unraised: input.deviationsUnraised ?? 0,
    has_deviations: input.hasDeviations ? 1 : 0,
    summary: input.summary ?? null,
    report: input.report ?? null,
    process_key: input.processKey ?? null,
    review_status: input.reviewStatus ?? "reviewed",
    updated_at: ts,
  };
  try {
    await conformanceTbl(data).insert({ plan_key: planKey, created_at: ts, ...fields });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await conformanceTbl(data).update(planKey, fields);
  }
}

/** Settle a conformance run's escalation once the operator acknowledges it: flip `review_status` to
 * `reviewed` so `pollUserTasks` stops scanning it (its inbox row is already gone once the ack task
 * closes) and stamp the disposition note into `summary` for the audit trail. Needed because the
 * `retro` instance COMPLETES normally after the ack — `instanceTracking.onTerminated` only fires on a
 * TERMINATED (crashed) instance, never a completed one, so nothing else would clear `reviewing`. */
export async function acknowledgeConformance(
  data: DataLayer,
  planKey: string,
  note?: string | null,
): Promise<void> {
  const trimmed = typeof note === "string" && note.trim() ? note.trim() : null;
  const existing = await conformanceTbl(data).get(planKey);
  if (!existing) return;
  const prior = typeof existing.summary === "string" ? existing.summary : null;
  const summary = trimmed ? (prior ? `${prior}\n\nOperator ack: ${trimmed}` : `Operator ack: ${trimmed}`) : prior;
  await conformanceTbl(data).update(planKey, {
    review_status: "reviewed",
    summary,
    updated_at: now(),
  });
}
