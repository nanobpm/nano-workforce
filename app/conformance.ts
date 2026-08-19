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
import { isUniqueViolation, readBlackboard } from "./blackboard.ts";
import { TERMINAL_STATUSES } from "./delivery.ts";
import { planTasks } from "./plan.ts";

const now = () => new Date().toISOString();

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
const conformanceTbl = (data: DataLayer) =>
  data.table<{ plan_key: string } & Record<string, unknown>>("plan_conformance", "plan_key");

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
 * deviations raised during implementation. Reads only — no writes. */
export async function gatherConformance(
  data: DataLayer,
  planKey: string,
): Promise<ConformanceDigest> {
  const plan = await plansTbl(data).get(planKey);
  const tasks = (await planTasks(data).find({ plan_key: planKey }))
    .slice()
    .sort((a, b) => (a.task_index ?? 0) - (b.task_index ?? 0));

  const slices: ConformanceSlice[] = [];
  const deliveredPrs: string[] = [];
  for (const t of tasks) {
    let landed = false;
    if (t.pr_key) {
      const pr = await prsTbl(data).get(t.pr_key);
      landed = !!pr && LANDED_PR_STATUSES.has(pr.status);
      if (landed) deliveredPrs.push(t.pr_key);
    }
    slices.push({
      taskId: t.task_id,
      title: t.title ?? null,
      prompt: t.prompt ?? null,
      status: t.status,
      prKey: t.pr_key ?? null,
      landed,
    });
  }

  const scopeChanges = (await readBlackboard(data, planKey))
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
    updated_at: ts,
  };
  try {
    await conformanceTbl(data).insert({ plan_key: planKey, created_at: ts, ...fields });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await conformanceTbl(data).update(planKey, fields);
  }
}
