// nano-workforce — the app's business logic over the Urban runtime seams (ADR 0055).
//
// The action handlers (`actions/*.ts`) and the review-ready poller (`main.ts`) both call
// these functions. Actions receive `app.data` (the typed datasource gateway) and
// `app.engine` (the transport-agnostic engine client) from the injected `AppApi`; the
// poller passes the same `DataLayer` + `EngineClient` obtained from `main.ts`.
//
// Data access goes through the record-oriented gateway (`data.table<T>(name, pk)` — the RAD
// `Table<T>` surface), not hand-written SQL. Row shapes are declared inline here.
import { readFileSync } from "node:fs";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { ABANDONED_STATUS, abandonUrl, mintAbandonToken, renderAbandonBrief } from "./abandon.ts";
import { agentSlaTimeout } from "./agentSla.ts";
import {
  CAPS_RESOLVED_MESSAGE,
  type CapabilityNeed,
  capabilityGateKey,
  capabilityNeedToProbeInput,
  capabilityTaskBarrierKey,
  type ResolvedCapability,
  renderResolvedDepsBrief,
  UnresolvableCapabilityRefError,
} from "./capabilityNeed.ts";
import {
  activeConformanceReviews,
  CONFORMANCE_ESCALATION_ELEMENT,
  conformanceEscalationQuestion,
} from "./conformance.ts";
import { isUniqueConstraintFence } from "./dbFence.ts";
import { deriveDelivery, TERMINAL_STATUSES } from "./delivery.ts";
import { deliveryGraphRuns, deriveDeliveryPhase, parseHumanLabels } from "./deliveryGraphRun.ts";
import { isDeliveryHumanElement } from "./deliveryHuman.ts";
import { fleetSupportsDurableResume } from "./durableResume.ts";
import { deriveFeatureDelivery, FEATURE_BLOCKED_ELEMENT, FEATURE_ESCALATION_ELEMENT, FEATURE_RUN_STATUSES, type FeatureRunStatus, featureEscalations, featureRuns } from "./feature.ts";
import {
  classifyMergeability,
  classifyPrLiveness,
  coalesceTitle,
  ensureFreshHeadRun,
  ensurePromotionPr,
  fetchDefaultBranch,
  fetchPrHead,
  fetchPrMeta,
  fetchPrReviews,
  fetchPrState,
  hasPendingCopilotReviewer,
  isNotAPullRequestError,
  type MergeMethod,
  type PrState,
  requestCopilotReview,
} from "./github.ts";
import { pollLineage } from "./lineage.ts";
import { mergeLanes, readExclusions } from "./mergeExclusion.ts";
import {
  freshHeadRunAction,
  headRunPresenceCount,
  loadMergeProtocol,
  type MergeProtocol,
} from "./mergeProtocol.ts";
import { type PrLaneDecision, planPrLane, taskDependencyDepths } from "./mergeTrain.ts";
import {
  capabilityGates,
  inboundPlanDeps,
  type Plan,
  planReviews,
  plans,
  planTaskDeps,
  planTaskNeeds,
  planTasks,
} from "./plan.ts";
import { derivePromotionState, isEpicIntegrationBranch, isPromotable, promotionPrBody, promotionPrTitle } from "./promotion.ts";
import {
  defaultProbeExec,
  type ProbeExec,
  probeOnce,
  READINESS_READY_MESSAGE,
  type ReadinessProbe,
  readinessPollEvery,
  readinessTimeout,
} from "./readiness.ts";
import { clampNudgeMinutes, reviewWaitTimeout } from "./reviewWait.ts";
import { trialMergeAudits } from "./trialMerge.ts";
import {
  buildUserTaskRow,
  latestFeatureEscalationQuestion,
  latestOpenEscalationQuestion,
  latestPlanReviewFindings,
  latestTrialMergeQuestion,
  PLAN_REVIEW_ELEMENT,
  PR_WAIT_ANSWER_ELEMENT,
  PR_WAIT_MERGE_ANSWER_ELEMENT,
  prEscalations,
  reconcileUserTasks,
  TRIAL_MERGE_ELEMENT,
  type UserTaskContext,
  type UserTaskRow,
  userTaskKindLabel,
  userTasks,
} from "./userTasks.ts";
import { deriveWaitGate } from "./waitGate.ts";
import { waveMergeTargets } from "./waves.ts";
import { isCommitSha, WorldStore } from "./world/index.ts";

/** The BPMN process that drives review convergence (`resources/processes/convergence-loop.bpmn`). */
export const PROCESS_ID = "convergence-loop";
/** The BPMN process that lands a converged PR (`resources/processes/merge-loop.bpmn`). */
export const MERGE_PROCESS_ID = "merge-loop";
/** Job type of the external review agent (the `review-round` service task's `zeebe:taskDefinition`
 * in convergence-loop.bpmn). Deliberately NOT hosted here — an external harness services it; the
 * activation poll keys off it to tell "agent working" from "queued". */
const REVIEW_JOB_TYPE = "senior:pr-review";

/** Default round cap before the loop escalates to a human. A per-submit override (submit form /
 * webhook / start action) takes precedence; this env var sets the fleet-wide default. The cap
 * coercion + ceiling live in the pure `./rounds.ts` module (re-exported for callers). */
export { clampCiFixBudget, clampRounds, MAX_CI_FIX_CEILING, MAX_ROUNDS_CEILING } from "./rounds.ts";

import { clampCiFixBudget, clampRounds } from "./rounds.ts";
export const MAX_ROUNDS = clampRounds(process.env.NANO_PR_MAX_ROUNDS, 20);

/** How many times the merge stage will dispatch a `senior:fix-ci` agent to make a blocked PR's
 * failing required checks green before giving up and escalating to a human. Default 3; set
 * `NANO_PR_MAX_CI_FIX_ROUNDS=0` to disable auto-fix (a blocked PR escalates immediately). Unlike
 * the review-round cap this allows 0 (disable), so it parses directly rather than via clampRounds. */
export const MAX_CI_FIX_ROUNDS = clampCiFixBudget(process.env.NANO_PR_MAX_CI_FIX_ROUNDS, 3);

/** How many times the merge stage will dispatch a `senior:rebase` agent to bring a conflicting
 * (moved-base) PR up to date with its base before giving up and escalating to a human. Default 3;
 * set `NANO_PR_MAX_REBASE_ROUNDS=0` to disable auto-rebase (a conflicting PR escalates
 * immediately). Reuses the CI-fix budget clamp (allows 0 = disable, ceiling-capped). */
export const MAX_REBASE_ROUNDS = clampCiFixBudget(process.env.NANO_PR_MAX_REBASE_ROUNDS, 3);

/** How many times the merge stage will re-attempt a merge that GitHub aborted with a *transient*
 * base/head-moved race (see `isTransientMergeRace`) before giving up and escalating to a human.
 * The re-attempt runs on the settled base (no remediation agent); the cap keeps a continuously
 * moving base — or a persistently-failing merge — from spinning forever, escalating within
 * seconds-to-minutes instead. Default 5; set `NANO_PR_MAX_MERGE_RETRIES=0` to disable transient
 * retry (a race escalates immediately). Reuses the CI-fix budget clamp (allows 0 = disable). */
export const MAX_MERGE_RETRIES = clampCiFixBudget(process.env.NANO_PR_MAX_MERGE_RETRIES, 5);

/** How long a merge-loop AGENT service task (rebase / fix-ci) may sit without completing before its
 * interrupting timer boundary fires and the PR escalates for human attention. Seeded as the
 * `agentSlaTimeout` process variable at merge start and evaluated by those tasks' boundary timers.
 * Unlike a human-decision escalation (PT24H), an agent task has no human in the loop — if its
 * capability is unstaffed or the agent hangs/crashes without failing the job, the token would
 * otherwise park forever. Override with `NANO_PR_AGENT_SLA_TIMEOUT` (ISO-8601 duration). */
export const AGENT_SLA_TIMEOUT = agentSlaTimeout(process.env.NANO_PR_AGENT_SLA_TIMEOUT);

/** How long the convergence loop waits for a fresh review before escalating to a human. Seeded as
 * the `reviewWaitTimeout` process variable at submit and evaluated by the process's
 * `wait-review-timeout` timer catch (the timer arm of the event-based-gateway race against
 * `review-ready`). ISO-8601 duration; a malformed `NANO_PR_REVIEW_WAIT_TIMEOUT` falls back to the
 * default so an uninterpretable timer is never deployed. */
export const REVIEW_WAIT_TIMEOUT = reviewWaitTimeout(process.env.NANO_PR_REVIEW_WAIT_TIMEOUT);

/** Cooldown (ms) between the poller's automatic Copilot re-request nudges for a single waiting PR.
 * Copilot dismisses re-requests, so the poller retries — but not on every tick; this throttles it
 * to one attempt per window. Set via `NANO_PR_REVIEW_NUDGE_MINUTES` (minutes). */
export const REVIEW_NUDGE_MS = clampNudgeMinutes(process.env.NANO_PR_REVIEW_NUDGE_MINUTES) * 60_000;

/** Whether a converged PR is automatically driven to merge (the merge-loop). Default on; set
 * `NANO_PR_AUTO_MERGE=0` to stop at `converged` (review-only mode). */
export const AUTO_MERGE = !["0", "false", "off", "no"].includes(
  (process.env.NANO_PR_AUTO_MERGE ?? "1").trim().toLowerCase(),
);
/** Merge method passed to `gh pr merge` / the REST merge API. */
export const MERGE_METHOD: MergeMethod = (() => {
  const m = (process.env.NANO_PR_MERGE_METHOD ?? "squash").trim().toLowerCase();
  return m === "merge" || m === "rebase" ? m : "squash";
})();
/** Whether to pass `--admin` to `gh pr merge` (bypass branch policy where the operator is an
 * admin — mirrors the manual `gh pr merge --squash --admin` fallback some repos require). */
export const MERGE_ADMIN = ["1", "true", "on", "yes"].includes(
  (process.env.NANO_PR_MERGE_ADMIN ?? "0").trim().toLowerCase(),
);

// The `senior:pr-review` agent prompt is no longer read by the host: it is a generic resource
// (`resources/prompts/review-round.md`, deployed under the `resources/` deploy-by-convention layout
// — nano.app.json declares no `models`) linked into the task
// as `<zeebe:linkedResource resourceId="review-round.md" bindingType="latest" linkName="prompt"/>`
// and resolved by the engine at job activation. The host only carries runtime PR identity + the
// round counter now.

const now = () => new Date().toISOString();

export interface PullRequest {
  pr_key: string;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  status: string;
  current_round: number;
  process_key: string | null;
  waiting_since: string | null;
  last_review_id: number | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  converged_at: string | null;
  merged_at: string | null;
  // Job-activation visibility (005_job_activation.sql), written by the poller's
  // `pollJobActivation` pass. `active_worker` is the leasing worker's name while an
  // agent is actively working the `senior:pr-review` round; NULL means the job is
  // queued (created, not yet activated) or the process isn't at review-round.
  active_worker: string | null;
  lease_until: string | null;
  // Review-wait liveness (008_review_nudge.sql): ISO ts the poller last re-requested a Copilot
  // review for this PR, so the nudge is throttled to one attempt per REVIEW_NUDGE_MS window.
  // NULL means never nudged.
  last_nudge_at: string | null;
  // Merge-protocol liveness (012_merge_protocol_attempt.sql): head commit last nudged by the
  // frugal-CI fresh-head-run remedy. A rebase changes the head and therefore permits a new nudge.
  fresh_head_run_head: string | null;
  // Cooperative abandon check (015_pr_abandon_token.sql, issue #76): the per-PR capability token a
  // running agent curls (GET /app/api/hooks/abandon?token=…) to learn whether this run was cancelled before
  // it performs a side effect. Minted at submit, reused across the convergence + merge instances.
  abandon_token: string | null;
  // Technical-incident surfacing (017_pr_incident.sql, issue #94), written by the poller's
  // `pollIncidents` pass. `incident_key` is the engine incidentKey of the ACTIVE incident parking
  // this PR's instance and `incident_message` its errorMessage; both NULL when the instance has no
  // active incident. Orthogonal to `status` — an incident is a cross-cutting liveness fault, not a
  // workflow stage.
  incident_key: string | null;
  incident_message: string | null;
  // Lineage projection (037_lineage.sql, issue #245): the stable ORIGIN identity (the issue =
  // feature_key / plan_key) threaded onto this PR by `submitPr`, and passed as a `createInstance`
  // variable onto the convergence + merge instances so every descendant carries the root. For a
  // human-opened / webhook PR with no originating request, `submitPr` self-roots it to its own
  // `pr_key` so the Lineage UI join resolves; a legacy NULL is tolerated the same way by the
  // lineage read projection (`pollLineage`), which self-roots on `pr_key`.
  root_request_key: string | null;
}

interface PrDependency {
  pr_key: string;
  depends_on_key: string;
  created_at: string;
}

interface Escalation {
  id: number;
  pr_key: string;
  round_no: number;
  kind: string;
  question: string;
  answer: string | null;
  status: string;
  asked_at: string;
  answered_at: string | null;
}

const prs = (data: DataLayer) => data.table<PullRequest>("pull_requests", "pr_key");
const escs = (data: DataLayer) => data.table<Escalation>("escalations", "id");
const deps = (data: DataLayer) => data.table<PrDependency>("pr_dependencies", "pr_key");

export interface ParsedPr {
  repo: string;
  number: number;
  url: string;
  prKey: string;
}

/** Canonical GitHub PR URL for a repo + number. Matches the `url` `parsePr` derives, so a
 * reconstructed row is indistinguishable from one registered at submit time. */
export function canonicalPrUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

/**
 * Guarantee the `pull_requests` parent row exists before a FK-child row (`rounds`, `escalations`,
 * `merges`) is written. Idempotent and race-safe.
 *
 * The durable engine and the app's `app.db` are two INDEPENDENT stores. If they ever desync — the
 * DB is rebuilt, restored from a stale copy, or simply lags a live process instance while running
 * from a local checkout — a persist/finalize/merge job would otherwise insert a child row whose
 * FK parent is absent and die with an opaque `FOREIGN KEY constraint failed` incident that a human
 * has to hand-resolve (observed on convergence-loop instance 94). The PR's `repo`/`prNumber` are
 * normally carried as process variables; where they may be absent (older in-flight instances) the
 * call sites derive them from the canonical `owner/repo#N` prKey, so the parent can always be
 * reconstructed deterministically: we heal the missing row (a minimal `converging` aggregate) and
 * let the loop continue instead of parking a dead-end incident. Callers pass the instance's
 * `abandonToken` (recovered from its `abandonUrl` var) so the healed row keeps the token the
 * running agent was handed and its cooperative-abort check keeps resolving. When the row already
 * exists this is a no-op, so the healthy path is unchanged.
 */
export async function ensurePr(
  data: DataLayer,
  pr: { prKey: string; repo: string; number: number; url?: string; round?: number; abandonToken?: string },
): Promise<void> {
  const table = prs(data);
  if (await table.get(pr.prKey)) return;
  const ts = now();
  console.warn(
    `[ensurePr] pull_requests row for ${pr.prKey} was missing — reconstructing it so the FK-child ` +
      `write can proceed (engine/app.db desync heal)`,
  );
  try {
    await table.insert({
      pr_key: pr.prKey,
      repo: pr.repo,
      number: pr.number,
      url: pr.url ?? canonicalPrUrl(pr.repo, pr.number),
      status: "converging",
      current_round: pr.round ?? 1,
      // Reuse the token the running agent was already handed (recovered from the instance's
      // `abandonUrl` var) so its abort check keeps resolving; only mint a fresh one when the caller
      // has no token to preserve (e.g. an old instance predating the `abandonUrl` variable).
      abandon_token: pr.abandonToken ?? mintAbandonToken(),
      created_at: ts,
      updated_at: ts,
    });
  } catch (err) {
    // Lost a race with a concurrent writer (submitPr or another job created the row first): the
    // parent now exists, which is exactly the goal, so swallow. Only a still-absent row is a real
    // failure worth surfacing.
    if (await table.get(pr.prKey)) return;
    throw err;
  }
}

/** Parse "owner/repo#123" or a canonical PR URL into its parts. */
export function parsePr(input: unknown): ParsedPr | null {
  // Total on any input: a process-variable regression (or an older in-flight instance) can carry a
  // non-string prKey, and `.trim()` on a non-string throws — turning a should-fail-open caller into
  // a retrying job. Fail closed to `null` here so every caller resolves safely instead of throwing.
  if (typeof input !== "string") return null;
  const s = input.trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  return null;
}

/** Extract `Depends-on: owner/repo#N[, owner/repo#N …]` (or PR URLs) from a PR body. Multiple
 * `Depends-on:` lines accumulate; each line may list several comma/space-separated refs. Returns
 * the normalized `owner/repo#N` keys. Unparseable tokens are ignored. */
export function parseDependsOn(body: string): string[] {
  const out = new Set<string>();
  for (const line of (body ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*depends[-\s]?on\s*:\s*(.+)$/i);
    if (!m) continue;
    for (const tok of m[1].split(/[,\s]+/)) {
      const p = parsePr(tok);
      if (p) out.add(p.prKey);
    }
  }
  return [...out];
}

/** Replace a PR's dependency set (idempotent on resubmit). Self-references are dropped so a PR
 * can never wait on itself. */
async function registerDependencies(data: DataLayer, prKey: string, depKeys: string[]) {
  const table = deps(data);
  // The gateway keys this table on `pr_key`, so a single delete clears the PR's whole dep set
  // (DELETE ... WHERE pr_key = ?) — then we re-insert the current set.
  await table.delete(prKey);
  const ts = now();
  for (const depKey of new Set(depKeys)) {
    if (depKey === prKey) continue;
    await table.insert({ pr_key: prKey, depends_on_key: depKey, created_at: ts });
  }
}

/** The reserved namespace key the c8ctl nano worker harness reads the agent-task envelope from
 * (headers ∪ variables, deep-merged). See c8ctl `normalizeTaskEnvelope`. */
const AGENT_TASK_NS = "io.nanobpm.agentTask";

/** Build the repository slice of the agent-task envelope for a PR-based agent job (review-round,
 * fix-ci, rebase). Delivered as a *process variable* under the reserved `io.nanobpm.agentTask`
 * key so the harness provisions an isolated clone checked out on the PR's head branch — instead of
 * the agent inheriting whatever directory the worker was launched from (which only happened to be
 * a usable checkout for repos already present locally). `ref` MUST be the PR head branch; when it
 * is unresolved we emit nothing (no `repository.url`) so the harness falls back to the legacy
 * launch-dir behavior rather than silently cloning the repo's default branch. The static
 * `task.prompt` header on the service task deep-merges with this over the same namespace.
 *
 * The clone is requested **branch-scoped and blobless** (`singleBranch: true` + `filter:
 * "blob:none"`) so large monorepos (e.g. `camunda/camunda`, ~1.16 GB) provision within the c8ctl
 * clone timeout instead of full-cloning the whole history (issue #287). `blob:none` is a *blobless*
 * partial clone (trees are still fetched up-front — a *treeless* clone would be `--filter=tree:0`); it
 * keeps the full *commit graph* (so `git merge-base` / the review 3-dot diff stays correct) while
 * fetching file blobs lazily — small upfront, correct diffs. `--depth 1` is deliberately NOT used:
 * it would drop the merge-base and break `git diff origin/<base>...HEAD`. When the PR base branch
 * is known we also emit `baseRef` so the harness fetches the base tip alongside the head, keeping
 * that base reachable for the diff.
 *
 * World-restore (issue #324, ADR 0062 Slice 4/5): when a PR already has a durable push-checkpoint,
 * `commitSha` is emitted so a REPLACEMENT activation (a fresh worktree after a lease loss)
 * reconstructs the working tree to the EXACT pushed SHA — the inversion of the round's outbound
 * `git push` into an inbound `git fetch && git checkout <sha>` — rather than to a branch tip that may
 * have moved. Omitted (no key) when the PR has no checkpoint yet, so a first activation clones the
 * head branch normally. */
export function repoEnvelopeVars(
  repo: string,
  ref: string | null,
  baseRef: string | null = null,
  commitSha: string | null = null,
): Record<string, unknown> {
  if (!ref) return {};
  // Defence in depth: every current caller derives `repo` from parsePr/parseIssue (regex-bounded to
  // `owner/repo`), but this is an exported helper the fan-out epic gives many new callers. A repo
  // that is not exactly `owner/repo` would build a bogus clone URL, so emit nothing (the harness
  // then falls back to the launch-dir behaviour) rather than handing the harness a malformed URL.
  // The owner is a GitHub login (alphanumeric + hyphen); the repo-name segment additionally allows
  // `.` and `_`. A trailing `.git` is rejected outright so we never emit a double-suffixed
  // `…/owner/repo.git.git`, and the anchored allowlist bars query/fragment/host-injection chars.
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || /\.git$/i.test(repo)) return {};
  return {
    [AGENT_TASK_NS]: {
      repository: {
        provider: "github",
        url: `https://github.com/${repo}.git`,
        ref,
        // Branch-scoped, blobless partial clone (issue #287): fetch only the head branch with lazy
        // blobs so large monorepos provision within the clone timeout. Single-branch + blob:none
        // (not --depth 1) preserves the commit graph so the review's `git diff origin/<base>...HEAD`
        // has a valid merge-base. Gated on c8ctl provisioner support (jwulf/c8ctl-plugin-nano#91).
        singleBranch: true,
        filter: "blob:none",
        // The base branch this PR targets — emitted so the harness fetches its tip alongside the
        // single-branch head, keeping `origin/<base>` reachable for the diff. Omitted when unknown.
        ...(baseRef ? { baseRef } : {}),
        // World-restore (issue #324): the last pushed SHA a replacement activation reconstructs the
        // working tree to (inverting the round's push into a fetch+checkout). Only emitted when it is
        // a well-formed 40-hex commit SHA: `commitSha` is forwarded to the harness as an EXACT
        // checkout target, so a non-SHA ref or a whitespace-tainted value could reconstruct to an
        // unintended ref (a moved branch tip) or fail provisioning. A malformed value degrades to
        // omission — the harness then clones the head branch tip, the pre-#324 behaviour. Omitted too
        // when the PR has no durable push-checkpoint yet.
        ...(isCommitSha(commitSha) ? { commitSha } : {}),
      },
    },
  };
}

/** The last durable push-checkpoint SHA for a PR (issue #324, ADR 0062 Slice 4/5), or `null` when it
 * has none yet. Threaded into `repoEnvelopeVars` so a replacement activation reconstructs the exact
 * pushed tree. Best-effort: any store read failure (a legacy DB predating migration 049, an in-flight
 * desync) degrades to `null` — the harness then clones the head branch tip, the pre-#324 behaviour —
 * rather than blocking a submit/merge on the world store. */
async function lastPushedSha(data: DataLayer, prKey: string): Promise<string | null> {
  try {
    return (await new WorldStore(data).lastCheckpoint(prKey))?.commitSha ?? null;
  } catch (err) {
    console.warn(`[world] ${prKey} last-checkpoint read: ${err}`);
    return null;
  }
}

/** The world-restore SHA to emit into the repo-provisioning envelope for a PR, GATED on the
 * `durable-resume` enrolment (issue #325, ADR 0062 Slice 5/5). Only when the enrolled fleet includes a
 * durable-resume participant (`fleetSupportsDurableResume`) do we hand the harness the last
 * push-checkpoint so a replacement activation RESUMES by reconstructing the exact pushed tree
 * (inverting `git push` → `git fetch && git checkout <sha>`). With no participant the marker is
 * omitted (`null`), so the round redrives from scratch — graceful degradation, exactly as today.
 * Resume is purely additive: gating on the enrolment attribute, not a sequence flow, keeps the
 * engine/C8 job protocol untouched (ADR 0056 boundary). */
export async function worldRestoreSha(data: DataLayer, prKey: string): Promise<string | null> {
  if (!(await fleetSupportsDurableResume(data))) return null;
  return lastPushedSha(data, prKey);
}

/** Register a PR row (if new) and start the convergence process. Idempotent on prKey. Optional
 * `dependsOn` (explicit refs) is unioned with any `Depends-on:` line parsed from the PR body and
 * recorded as the PR's merge-stage dependency set. */
export async function submitPr(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedPr,
  dependsOn: string[] = [],
  maxRounds: number = MAX_ROUNDS,
  convergeOnly = false,
  rootRequestKey: string | null = null,
) {
  const table = prs(data);
  const existing = await table.get(parsed.prKey);
  if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
    return { prKey: parsed.prKey, alreadyRunning: true };
  }

  // Best-effort GitHub read: the title labels the row and the body may carry `Depends-on:` refs.
  // A transport failure (no gh/token) must not block submission — we just skip enrichment.
  const token = process.env.GITHUB_TOKEN ?? "";
  let title: string | null = null;
  let headRef: string | null = null;
  let baseRef: string | null = null;
  const depKeys = new Set(dependsOn.map((d) => parsePr(d)?.prKey).filter((k): k is string => !!k));
  try {
    const meta = await fetchPrMeta(parsed.repo, parsed.number, token);
    if (meta) {
      title = meta.title;
      headRef = meta.headRef;
      baseRef = meta.baseRef;
      for (const k of parseDependsOn(meta.body)) depKeys.add(k);
    }
  } catch (err) {
    console.warn(`[submit] ${parsed.prKey} meta fetch: ${err}`);
  }
  if (!headRef) {
    // Without the head branch the harness can't check out the PR; the review agent then falls
    // back to the worker's launch dir (the legacy behavior) and escalates if it isn't a checkout.
    console.warn(`[submit] ${parsed.prKey} head branch unresolved — agent workspace won't be provisioned`);
  }
  await registerDependencies(data, parsed.prKey, [...depKeys]);

  const ts = now();
  // Cooperative abandon check (#76): reuse the PR's existing capability token across re-runs (and
  // the later merge instance), or mint one for a first submission.
  const abandonToken = existing?.abandon_token ?? mintAbandonToken();
  // Lineage (issue #245): the origin identity threaded onto this PR + its convergence/merge
  // instances. A caller (feature/epic hand-off) supplies it on the first submit; a resubmit that
  // omits it must not clobber a root already learned, so coalesce onto the existing row's value. A
  // human/webhook submit supplies none → the PR is its OWN root, so self-root on its `pr_key`
  // (never NULL): the Lineage page drills into a thread's member PRs by joining
  // `lineage_threads.root_request_key` → `pull_requests.root_request_key`, and a self-rooted
  // thread's key IS the `pr_key`, so leaving the PR row NULL would render an empty PR list for it.
  // Persisting `pr_key` keeps that join honest (the projection self-roots the same key either way).
  const effectiveRoot = rootRequestKey ?? existing?.root_request_key ?? parsed.prKey;
  if (existing) {
    // A prior run (cancelled, converged, or otherwise superseded) may have left an OPEN
    // escalation row. A fresh convergence run must not inherit that stale answer — the
    // "(no question provided)" bleed-through on resubmit (Magikcraft/nano-bpm #597/#599).
    // Mark any still-open escalations `stale`, mirroring the plan re-plan cleanup (issue #25
    // in plan.ts). The review-loop escalation is now a native userTask; its open state is derived
    // from the canonical `escalations` row status, so there is no denormalised PR-row pointer to clear.
    for (const e of await escs(data).find({ pr_key: parsed.prKey, status: "open" })) {
      await escs(data).update(e.id, { status: "stale" });
    }
    // Re-open a previously converged/abandoned/merged PR for a fresh convergence run.
    await table.update(parsed.prKey, {
      status: "converging",
      current_round: 1,
      url: parsed.url,
      // Coalesce to the key so `pull_requests.title` stays non-blank for the title-led grids
      // (issue #248): a fresh fetch wins, else the prior title, else the `owner/repo#N` key.
      // A blank/whitespace title counts as missing (matches the 036 backfill), so an empty
      // external title never lands as an unlabeled row.
      title: coalesceTitle(title, existing.title, parsed.prKey),
      waiting_since: null,
      last_review_id: null,
      last_nudge_at: null,
      outcome: null,
      converged_at: null,
      merged_at: null,
      abandon_token: abandonToken,
      root_request_key: effectiveRoot,
      updated_at: ts,
    });
  } else {
    await table.insert({
      pr_key: parsed.prKey,
      repo: parsed.repo,
      number: parsed.number,
      url: parsed.url,
      // Coalesce to the key so the title-led grids never render a blank identity (issue #248);
      // a blank/whitespace external title counts as missing (matches the 036 backfill).
      title: coalesceTitle(title, parsed.prKey),
      status: "converging",
      current_round: 1,
      abandon_token: abandonToken,
      root_request_key: effectiveRoot,
      created_at: ts,
      updated_at: ts,
    });
  }
  const abUrl = abandonUrl(abandonToken);
  // World-restore (issue #324, ADR 0062 Slice 4/5): a re-run of convergence for a PR that already
  // pushed is a resume — carry its last durable push-checkpoint so a replacement activation on a
  // fresh worktree reconstructs the tree to the EXACT pushed SHA. GATED (issue #325, Slice 5/5) on the
  // fleet advertising `durable-resume`: with no participant it stays null, so the round redrives from
  // scratch (graceful degradation). Absent (null) on a first submit, which leaves the envelope
  // unchanged.
  const worldSha = await worldRestoreSha(data, parsed.prKey);
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: PROCESS_ID,
    variables: {
      repo: parsed.repo,
      prNumber: parsed.number,
      prUrl: parsed.url,
      prKey: parsed.prKey,
      round: 1,
      maxRounds: clampRounds(maxRounds, MAX_ROUNDS),
      reviewWaitTimeout: REVIEW_WAIT_TIMEOUT,
      // Lineage (issue #245): carry the origin identity onto the convergence instance so every
      // descendant (and any message it correlates) is stitched back to the originating request.
      // A human/webhook PR that is its own root carries its own `pr_key` (never NULL — see above).
      rootRequestKey: effectiveRoot,
      // Per-request review-only override: carried on the instance so `pr.finalize` can stop at
      // `converged` for this PR without handing off to the merge-loop, independent of the global
      // NANO_PR_AUTO_MERGE default. Only ever narrows (never forces merge on when auto-merge is off).
      convergeOnly,
      // Cooperative abandon check (#76): the capability URL + the abort brief appended to the
      // review-round agent's prompt, so it can stop before pushing if the run is cancelled.
      abandonUrl: abUrl,
      abandonBrief: renderAbandonBrief(abUrl),
      // Host-git provisioning (c8ctl): deliver the repository envelope so the `senior:pr-review`
      // harness clones an isolated workspace checked out on the PR head branch. Spread last so an
      // unresolved head (`{}`) leaves the other vars untouched.
      ...repoEnvelopeVars(parsed.repo, headRef, baseRef, worldSha),
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.prKey, { process_key: processKey });
  }
  return { prKey: parsed.prKey, processKey };
}

/** Start the merge-loop for a converged PR (called by the `pr.finalize` worker when AUTO_MERGE
 * is on). Carries the same PR identity + the converged round so the merge stage can escalate
 * with a round number. Idempotent-ish: the caller only invokes this once per convergence. */
export async function startMerge(
  data: DataLayer,
  engine: EngineClient,
  pr: { repo: string; number: number; url: string; prKey: string; round: number },
) {
  // Cooperative abandon check (#76): reuse the token minted at submit so the merge agents
  // (fix-ci, rebase) share the PR's abandon URL; mint one if an older row predates the column.
  const existing = await prs(data).get(pr.prKey);
  const abandonToken = existing?.abandon_token ?? mintAbandonToken();
  if (!existing?.abandon_token) {
    await prs(data).update(pr.prKey, { abandon_token: abandonToken, updated_at: now() });
  }
  // Lineage (issue #245): the origin identity was persisted on the PR row at submit; carry it onto
  // the merge instance too so the merge stage stays stitched to the originating request. A
  // self-rooted PR carries its own `pr_key`; `?? null` only tolerates a legacy row predating the
  // column.
  const rootRequestKey = existing?.root_request_key ?? null;
  const abUrl = abandonUrl(abandonToken);
  // Resolve the PR head branch so the merge agents (fix-ci, rebase) get an isolated clone checked
  // out on it (same host-git provisioning path as review-round). Best-effort: an unresolved head
  // means the envelope is omitted and the agent falls back to the worker's launch dir.
  const token = process.env.GITHUB_TOKEN ?? "";
  let headRef: string | null = null;
  let baseRef: string | null = null;
  try {
    const head = await fetchPrHead(pr.repo, pr.number, token);
    headRef = head?.headRef ?? null;
    baseRef = head?.baseRef ?? null;
  } catch (err) {
    console.warn(`[startMerge] ${pr.prKey} head branch fetch: ${err}`);
  }
  if (!headRef) {
    console.warn(`[startMerge] ${pr.prKey} head branch unresolved — merge-agent workspace won't be provisioned`);
  }
  // World-restore (issue #324): the merge stage runs on the same durable working tree; carry the
  // last push-checkpoint so a replacement fix-ci/rebase activation reconstructs the exact SHA. GATED
  // (issue #325, Slice 5/5) on the fleet advertising `durable-resume` — otherwise null, so the merge
  // agents redrive from scratch (graceful degradation).
  const worldSha = await worldRestoreSha(data, pr.prKey);
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: MERGE_PROCESS_ID,
    variables: {
      repo: pr.repo,
      prNumber: pr.number,
      prUrl: pr.url,
      prKey: pr.prKey,
      round: pr.round,
      ciFixRound: 0,
      ciFixMax: MAX_CI_FIX_ROUNDS,
      rebaseRound: 0,
      rebaseMax: MAX_REBASE_ROUNDS,
      mergeRetryRound: 0,
      mergeRetryMax: MAX_MERGE_RETRIES,
      agentSlaTimeout: AGENT_SLA_TIMEOUT,
      // Lineage (issue #245): thread the origin identity onto the merge instance (see startMerge).
      rootRequestKey,
      abandonUrl: abUrl,
      abandonBrief: renderAbandonBrief(abUrl),
      // Host-git provisioning (c8ctl): same repository envelope as the convergence loop, so the
      // fix-ci/rebase agents operate on an isolated checkout of the PR head branch.
      ...repoEnvelopeVars(pr.repo, headRef, baseRef, worldSha),
    },
  });
  if (processInstanceKey != null) {
    await prs(data).update(pr.prKey, { process_key: String(processInstanceKey), updated_at: now() });
  }
  return { prKey: pr.prKey, mergeProcessKey: processInstanceKey };
}

/** A PR currently in flight, as reported by the status endpoint. */
export interface ActivePr {
  prKey: string;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  status: string;
  round: number;
  processKey: string | null;
  waitingSince: string | null;
  openEscalation: string | null;
  updatedAt: string;
  /** Leasing worker while an agent is actively working the review round; null when queued
   * (job created, not yet activated) or not at the review-round task. */
  activeWorker: string | null;
  /** ISO ts the current activation lease expires; null when not activated. */
  leaseUntil: string | null;
}

/** Every tracked PR not in a terminal state (converged/abandoned), newest-updated first. Backs
 * the GET status endpoint so an operator or an external harness can see what is in flight
 * without reading the datasource directly. The open-escalation question is derived from the
 * canonical `escalations` audit row — the single source of truth (no denormalised PR-row
 * pointer). A PR reads `status="escalated"` only while a token is parked awaiting a human answer,
 * and the row it raised carries `status="open"` until that answer is recorded — by the
 * `pr.answer-escalation` step on the `wait-answer` (review loop) or `wait-merge-answer` (merge loop)
 * user-task completion. Both loops now park on a native user task answered through the one canonical
 * `completeUserTask` door (#256), so deriving from the row (not a per-loop wait mechanism) surfaces
 * BOTH loops' escalations uniformly. Once answered the row leaves `open`, so `openEscalation`
 * derives back to null. */
export async function activePrs(data: DataLayer): Promise<ActivePr[]> {
  const all = await prs(data).all();
  const active = all
    .filter((p) => !TERMINAL_STATUSES.includes(p.status))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  // Only an `escalated` PR is parked awaiting a human answer (either loop). Surface the question
  // from its latest still-open `escalations` row; a resubmit retires stale rows and finalize/merge
  // move the PR off `escalated`, so an open row on an escalated PR is a genuinely live escalation.
  // Fetch every open row in one query (avoids an N+1 over escalated PRs), then keep the newest per PR.
  const openEscByPr = new Map<string, string>();
  const escalatedPrs = new Set(active.filter((p) => p.status === "escalated").map((p) => p.pr_key));
  for (const e of (await escs(data).find({ status: "open" })).sort((a, b) => b.id - a.id)) {
    if (!escalatedPrs.has(e.pr_key) || openEscByPr.has(e.pr_key)) continue;
    if (e.question) openEscByPr.set(e.pr_key, e.question);
  }
  return active.map((p) => ({
    prKey: p.pr_key,
    repo: p.repo,
    number: p.number,
    url: p.url,
    title: p.title ?? null,
    status: p.status,
    round: p.current_round,
    processKey: p.process_key ?? null,
    waitingSince: p.waiting_since ?? null,
    openEscalation: openEscByPr.get(p.pr_key) ?? null,
    updatedAt: p.updated_at,
    activeWorker: p.active_worker ?? null,
    leaseUntil: p.lease_until ?? null,
  }));
}

/** One review-ready poll pass (SPEC §10): for every PR waiting on a review, fetch its GitHub
 * reviews (via the host `gh` CLI or a token — see `app/github.ts`) and, on a fresh one,
 * correlate the canonical `readiness-ready` message to resume the loop.
 *
 * This is the review-ready wait re-expressed on the ONE `ReadinessProbe` wait-gate contract
 * (ADR 0001 §2, issue #259): the convergence-loop parks on the canonical `readiness-ready` gate
 * (event-based gateway racing the signal against the bounded `reviewWaitTimeout` timer), and this
 * canonical self-scheduling poller publishes that signal out-of-band when a fresh review lands —
 * the "out-of-band poller-correlated shape" #258 pinned decision 3 reserved for exactly this
 * migration. There is no bespoke `review-ready` message any more: one mechanism, no drift. The
 * fresh-review detection + Copilot nudge below stay here because review freshness is inherently
 * STATEFUL (keyed off `last_review_id`/`waiting_since`), which the stateless probe matchers cannot
 * subsume — the poller owns the forward-progress guarantee, the gate owns the bounded wait. */
async function pollReviews(data: DataLayer, engine: EngineClient, token: string) {
  const waiting = await prs(data).find({ status: "waiting_review" });
  for (const pr of waiting) {
    const { repo, number, pr_key: prKey } = pr;
    const lastId = pr.last_review_id ?? 0;
    try {
      const reviews = await fetchPrReviews(repo, number, token);
      if (reviews === null) return; // no usable transport (no gh, no token) → idle
      const fresh = reviews
        .filter((rv) =>
          rv.id > lastId && rv.submitted_at && (!pr.waiting_since || rv.submitted_at >= pr.waiting_since)
        )
        .sort((a, b) => a.id - b.id)
        .pop();
      if (!fresh) {
        // No fresh review yet. Copilot won't re-review a round with no new commit and dismisses
        // re-requests, so actively (re-)solicit the next review — throttled to one attempt per
        // REVIEW_NUDGE_MS window. The process's timer arm is the backstop if this never lands.
        await maybeRerequestReview(data, pr, token);
        continue;
      }
      await prs(data).update(prKey, { last_review_id: fresh.id, status: "converging", updated_at: now() });
      await engine.publishMessage({
        name: READINESS_READY_MESSAGE,
        correlationKey: prKey,
        // The canonical readiness-signal payload (`ReadinessReady` shape): the gate only needs to
        // know the probe went green. The fresh review's id/state is bookkept above on the PR row,
        // not carried on the message — the convergence-loop consumes only the round increment.
        variables: { ready: true, detail: `review ${fresh.id} (${fresh.state})` },
      });
      console.log(`[poller] review ${fresh.id} (${fresh.state}) -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] ${prKey}: ${err}`);
    }
  }
}

/** Ensure a Copilot review is in flight for a PR still waiting, throttled to one attempt per
 * REVIEW_NUDGE_MS window. Skips when Copilot is already a pending reviewer (a review is coming);
 * otherwise re-requests one and records the nudge. This is the primary liveness mechanism — the
 * process's `wait-review-timeout` timer arm only fires (escalating to a human) when even repeated
 * nudges fail to produce a review. A transport failure logs-and-returns without burning the
 * cooldown, so it retries next tick. */
async function maybeRerequestReview(data: DataLayer, pr: PullRequest, token: string) {
  const since = pr.last_nudge_at ? Date.parse(pr.last_nudge_at) : 0;
  if (Number.isFinite(since) && Date.now() - since < REVIEW_NUDGE_MS) return; // within cooldown
  try {
    const pending = await hasPendingCopilotReviewer(pr.repo, pr.number, token);
    if (pending === null) return; // no usable transport → don't spend the cooldown
    if (pending) {
      // A review is already in flight — record the check so the cooldown holds and we don't
      // re-poll reviewer state until the next window (bounds calls to one per window).
      await prs(data).update(pr.pr_key, { last_nudge_at: now() });
      return;
    }
    const res = await requestCopilotReview(pr.repo, pr.number, token);
    // Burn the cooldown only once the request itself succeeded: a transient transport failure
    // throws past this point, so `last_nudge_at` stays put and we retry on the next tick.
    await prs(data).update(pr.pr_key, { last_nudge_at: now() });
    if (res === "requested") console.log(`[poller] re-requested Copilot review -> ${pr.pr_key}`);
    else if (res === "unavailable") {
      console.warn(`[poller] Copilot not an assignable reviewer on ${pr.pr_key}; relying on timeout`);
    }
  } catch (err) {
    console.error(`[poller] ${pr.pr_key} re-request: ${err}`);
  }
}

/** Is a dependency PR merged? Prefer our own tracked row (cheap, authoritative once we've
 * merged it); otherwise ask GitHub whether that PR has merged (it may be an untracked PR, or
 * one merged out-of-band). A transport failure surfaces as "not merged yet" (caller retries). */
async function isDepMerged(data: DataLayer, depKey: string, token: string): Promise<boolean> {
  const tracked = await prs(data).get(depKey);
  if (tracked && tracked.status === "merged") return true;
  const parsed = parsePr(depKey);
  if (!parsed) return true; // unparseable dep can't be checked on GitHub → treat as cleared so it never wedges the PR
  try {
    const st = await fetchPrState(parsed.repo, parsed.number, token);
    return st?.merged ?? false;
  } catch (err) {
    // A ref that GitHub cannot resolve to a *pull request* — it's an issue (issues and PRs share
    // GitHub's number space) or the number doesn't exist — can never merge, so it cannot gate a
    // merge queue. Treat it as cleared (non-blocking) rather than wedging the run at `wait-deps`
    // forever, as happened when a PR body declared `Depends-on:` its epic tracking *issue*
    // (Magikcraft/nano-bpm#806 → #796). Transient failures rethrow so the poller logs and retries.
    if (isNotAPullRequestError(err)) {
      console.warn(
        `[poller] dep ${depKey} is not a mergeable pull request (issue or missing) — treating as non-blocking`,
      );
      return true;
    }
    throw err;
  }
}

/** Canonically retire a **closed-unmerged** PR's read model. Writes the terminal `merges` audit row
 * and flips BOTH the `pull_requests` row and every `plan_tasks` row keyed to the PR to `abandoned`.
 *
 * This is the ONE canonical abandon implementation, reached from BOTH entry points that observe a
 * wave/merge member closed on GitHub without merging (#352):
 *   • the merge stage — `workers/merge` `attempt-merge` closed short-circuit (#342), and
 *   • the wave-merge gate — `pollWaveGatesImpl`'s self-heal for a PR closed out-of-band while its
 *     task was still `opened` (never reached the merge stage, so `pollMerges` never saw it).
 *
 * Flipping the **task** row (not only the PR row) is essential: `waveMergeTargets` keys on
 * `plan_tasks.status`, so a still-`opened` task keeps a dead PR in the blocking set and wedges the
 * wave barrier forever; an `abandoned` task drops out (the wave completes on its surviving merged
 * members) and stops `isPlanComplete`/the Epics table counting a phantom open task. Idempotent for a
 * poller retry (or the two observers — merge worker + wave gate — racing the same closed PR):
 * re-running just re-stamps the same terminal status, and the terminal `merges` audit row is written
 * only once: the fast-path guard skips the insert when an `abandoned`/`pr-closed` row already exists,
 * and — because that check-then-insert is racy under the two observers (merge worker + wave gate)
 * racing the same closed PR — a DB-level partial UNIQUE fence (`ux_merges_abandon_pr_closed`,
 * migration 053) rejects a concurrent duplicate, which we swallow as the same idempotent outcome. So
 * retries (sequential OR concurrent) can't spam the audit with duplicate rows and skew reporting.
 *
 * Self-heals the FK parent first: the `merges` audit row is an FK child of `pull_requests.pr_key`, so
 * before writing it we ensure the parent row exists via the idempotent {@link ensurePr}. The merge
 * worker already pre-heals, but the wave-gate self-heal path does not — and in an engine/app.db
 * desync (the exact class `ensurePr` heals) it can observe a closed member whose `pull_requests` row
 * is missing. Healing inside the ONE canonical writer covers BOTH callers symmetrically, so the
 * FK-child insert can never hit `FOREIGN KEY constraint failed` and wedge the poller pass. */
export async function abandonClosedPr(data: DataLayer, prKey: string, detail: string): Promise<void> {
  const ts = now();
  const parsed = parsePr(prKey);
  // Self-heal the FK parent, but ONLY when `prKey` is well-formed. A malformed key can't be healed
  // (there's no repo/number to `ensurePr`), and silently skipping the heal would let the downstream
  // `merges.insert` fail with an opaque `FOREIGN KEY constraint failed` — the exact incident this
  // helper exists to prevent. Fail closed with a clear, actionable error instead.
  if (!parsed) {
    throw new Error(`abandonClosedPr: malformed prKey ${JSON.stringify(prKey)} — cannot self-heal the pull_requests FK parent`);
  }
  await ensurePr(data, { prKey, repo: parsed.repo, number: parsed.number });
  const merges = data.table("merges", "id");
  const alreadyAudited =
    (await merges.findOne({ pr_key: prKey, outcome: "abandoned", method: "pr-closed" })) !== null;
  if (!alreadyAudited) {
    try {
      await merges.insert({
        pr_key: prKey,
        outcome: "abandoned",
        method: "pr-closed",
        detail,
        at: ts,
      });
    } catch (err) {
      // The `find`-then-`insert` guard above is racy: the merge worker and the wave-gate self-heal
      // path can both observe "no row" and both insert. The partial UNIQUE fence
      // (`ux_merges_abandon_pr_closed`, migration 053) rejects the loser — tolerate that collision as
      // the SAME idempotent outcome the guard intends, and only that. Any other error rethrows.
      if (!isUniqueConstraintFence(err)) throw err;
    }
  }
  await prs(data).update(prKey, { status: ABANDONED_STATUS, updated_at: ts });
  const tasks = planTasks(data);
  for (const t of await tasks.find({ pr_key: prKey })) {
    await tasks.update(t.id, { status: ABANDONED_STATUS, updated_at: ts });
  }
}

/** Classify a wave-merge target PR against GitHub ground truth for the wave gate (#352):
 *   • `cleared` — merged (tracked `merged` row, an out-of-band `merged` live state, or an
 *     already-`abandoned` tracked row / non-PR ref that can never block) → non-blocking.
 *   • `closed`  — live GitHub state is closed WITHOUT merging → non-blocking, and the caller must
 *     reconcile it terminal via {@link abandonClosedPr} so it leaves the target set.
 *   • `pending` — still open, or read successfully but in an ambiguous (`unknown`) live state → still
 *     blocks the wave. A *thrown* transport error (network/5xx) is NOT swallowed here: it rethrows so
 *     the poller pass logs and retries — behaviourally identical for the barrier (it stays armed and
 *     re-checks next pass), and canonical with {@link isDepMerged}, which rethrows transient failures
 *     the same way. Only a `not-a-pull-request` error is caught (→ `cleared`).
 *
 * Mirrors {@link isDepMerged} (tracked-row fast path, then a live read, `not-a-pull-request` treated
 * as cleared, transient errors rethrown) but adds the closed-unmerged branch the wave barrier lacked
 * — the direct analogue of the merge stage's `classifyPrLiveness === "closed"` abandon. Conservative:
 * an unreadable PR never resolves to a terminal `cleared`/`closed`, so a false negative only costs a
 * retry while a false positive that would drop a live member is impossible. */
async function classifyWaveTarget(
  data: DataLayer,
  prKey: string,
  token: string,
): Promise<"cleared" | "closed" | "pending"> {
  const tracked = await prs(data).get(prKey);
  if (tracked && tracked.status === "merged") return "cleared";
  if (tracked && tracked.status === ABANDONED_STATUS) return "cleared"; // already reconciled terminal → non-blocking, no re-reconcile needed
  const parsed = parsePr(prKey);
  if (!parsed) return "cleared"; // unparseable ref can't be checked → never wedge the barrier
  let st: Awaited<ReturnType<typeof fetchPrState>>;
  try {
    st = await fetchPrState(parsed.repo, parsed.number, token);
  } catch (err) {
    if (isNotAPullRequestError(err)) return "cleared"; // an issue/missing number can never merge
    throw err;
  }
  const liveness = classifyPrLiveness(st);
  if (liveness === "merged") return "cleared";
  if (liveness === "closed") return "closed";
  return "pending"; // read OK but open or ambiguous (`unknown`) live state → stay conservative and keep blocking
}

/** Flip a PR into the transient `merging` status and publish the correlating message, reverting
 * to `prevStatus` if the publish fails. `merging` is deliberately a status no poll branch scans
 * (so a slow pass can't double-signal), which means a publish failure *after* the flip would
 * otherwise wedge the PR there forever — the next pass would never pick it back up. Reverting on
 * failure keeps the PR on a pollable status so the next pass retries. Single source of truth for
 * the flip-then-publish handoff shared by all merge-stage waits below. */
async function flipToMergingThenPublish(
  data: DataLayer,
  engine: EngineClient,
  prKey: string,
  prevStatus: string,
  message: Parameters<EngineClient["publishMessage"]>[0],
) {
  await prs(data).update(prKey, { status: "merging", updated_at: now() });
  try {
    await engine.publishMessage(message);
  } catch (err) {
    try {
      await prs(data).update(prKey, { status: prevStatus, updated_at: now() });
    } catch (revertErr) {
      console.error(`[poller] revert ${prKey} -> ${prevStatus} failed: ${revertErr}`);
    }
    throw err;
  }
}

async function mergeLaneDecisionForPr(data: DataLayer, prKey: string): Promise<PrLaneDecision | null> {
  const taskRows = await planTasks(data).find({ pr_key: prKey });
  const task = taskRows[0];
  if (!task) return null;
  const planKey = task.plan_key;
  const allTasks = await planTasks(data).find({ plan_key: planKey });
  const taskToPr = new Map<string, string>();
  const laneTasks: string[] = [];
  for (const t of allTasks) {
    laneTasks.push(t.task_id);
    if (t.pr_key) taskToPr.set(t.task_id, t.pr_key);
  }
  const edges = await readExclusions(data, planKey);
  if (edges.length === 0) return null;
  const lanes = mergeLanes(edges, laneTasks);
  const lanePrKeys = new Set([...taskToPr.values()]);
  const completedPrKeys = new Set<string>();
  for (const lanePrKey of lanePrKeys) {
    const lanePr = await prs(data).get(lanePrKey);
    if (lanePr && (lanePr.status === "merged" || lanePr.status === "abandoned")) {
      completedPrKeys.add(lanePr.pr_key);
    }
  }
  const depths = taskDependencyDepths(await planTaskDeps(data).find({ plan_key: planKey }));
  return planPrLane(lanes, taskToPr, completedPrKeys, prKey, depths);
}

async function mirrorTaskStatusForPr(data: DataLayer, prKey: string, status: "opened" | "waiting-for-lane") {
  const ts = now();
  for (const t of await planTasks(data).find({ pr_key: prKey })) {
    await planTasks(data).update(t.id, { status, updated_at: ts });
  }
}

/** The escape message a merge-stage durable wait must publish when its PR has gone terminal
 * (merged/closed) OUT-OF-BAND — i.e. someone landed or closed it on GitHub while the process was
 * parked, so the wait's own declared trigger (deps clearing, a mergeable verdict, a lane release, a
 * queue landing) may never fire. Each wait subscribes to a DIFFERENT message, so the escape MUST be
 * the one its parked catch actually correlates to (publishing any other name is dropped by the
 * engine and re-wedges the PR in the transient `merging` status). All roads lead to the same proven
 * terminal path — `attempt-merge`'s idempotent already-merged / closed short-circuits (#368):
 *   • waiting_deps  → parked at `wait-deps`, subscribes ONLY `deps-cleared`. Deps are moot once the
 *     PR itself landed, so clear them regardless of liveness; `deps-cleared` → `arm-merge` →
 *     `wait-mergeable`, where block 2 (below) reads the terminal state and drives merged→mark-merged
 *     / closed→abandon. This is the gap the incident hit — `wait-deps` had NO self-merged escape.
 *   • waiting_merge / waiting_lane → both parked at `wait-mergeable` (waiting_lane is an app-internal
 *     hold that leaves the process on `wait-mergeable`), which subscribes `merge-ready`. Route a
 *     `ready` verdict through `gw-mergeable → attempt-merge`, whose short-circuits complete/abandon.
 *   • queued → parked at `wait-landed`, subscribes `merge-landed` (→ mark-merged) and `merge-evicted`
 *     (→ arm-merge). A merged queue PR lands (`merge-landed`); a closed-unmerged one can NEVER land,
 *     so publishing `merge-landed` would falsely mark it merged — re-arm via `merge-evicted` instead
 *     and let block 2 abandon it on the next pass. */
function outOfBandEscapeMessage(
  status: string,
  liveness: "merged" | "closed",
  prKey: string,
): Parameters<EngineClient["publishMessage"]>[0] {
  switch (status) {
    case "waiting_deps":
      return { name: "deps-cleared", correlationKey: prKey, variables: {} };
    case "waiting_merge":
    case "waiting_lane":
      return {
        name: "merge-ready",
        correlationKey: prKey,
        variables: { mergeState: "ready", failingChecks: 0, failingChecksList: "" },
      };
    case "queued":
      return liveness === "merged"
        ? { name: "merge-landed", correlationKey: prKey, variables: {} }
        : { name: "merge-evicted", correlationKey: prKey, variables: {} };
    default:
      // Unreachable: only the four merge-stage durable waits call this. Fail loud rather than
      // mis-route a message the parked catch can't correlate (which would silently re-wedge the PR).
      throw new Error(`outOfBandEscapeMessage: unexpected merge-stage status ${JSON.stringify(status)}`);
  }
}

/** ONE shared out-of-band terminal pre-check for EVERY merge-stage durable wait (#368). A PR parked
 * at any durable GitHub wait can be merged or closed out-of-band; without a per-branch check on the
 * PR's OWN state, a wait that keys only off its declared trigger (e.g. `waiting_deps`' declared
 * deps) strands its instance forever — ACTIVE, no incident, no timer boundary. `waiting_merge`
 * already guarded this; centralising the check here closes the whole class so no merge stage can
 * silently wedge on an out-of-band terminal transition.
 *
 * Reads the PR's live state (reusing an already-fetched `st` when the caller has one, e.g. block 2)
 * and, if terminal, publishes the escape message its parked catch subscribes to via
 * {@link flipToMergingThenPublish} — flipping to the transient `merging` so a slow pass can't
 * double-signal, reverting on a failed publish. Returns `true` when it advanced the PR (the caller
 * must `continue`), `false` when the PR is still live / unreadable and the caller should run its
 * normal per-status logic. Conservative: an unreadable (`null`) or ambiguous (`unknown`/open) state
 * never resolves terminal, so a false negative only costs a retry while dropping a live PR is
 * impossible. */
async function advanceIfTerminalOutOfBand(
  data: DataLayer,
  engine: EngineClient,
  pr: { repo: string; number: number | string; pr_key: string; status: string },
  token: string,
  st?: PrState | null,
): Promise<boolean> {
  const state = st !== undefined ? st : await fetchPrState(pr.repo, pr.number, token);
  const liveness = classifyPrLiveness(state);
  if (liveness !== "merged" && liveness !== "closed") return false;
  const fromStatus = pr.status; // capture before flip: flipToMergingThenPublish mutates it to `merging`
  await flipToMergingThenPublish(
    data,
    engine,
    pr.pr_key,
    fromStatus,
    outOfBandEscapeMessage(fromStatus, liveness, pr.pr_key),
  );
  console.log(`[poller] out-of-band ${liveness} (${fromStatus}) -> ${pr.pr_key}`);
  return true;
}

/** Frugal-CI fresh-head-run self-heal, shared by the `"waiting"` and `"draft"` merge verdicts
 * (issue #454). Both verdicts feed the same {@link freshHeadRunAction} decision — when the repo's
 * merge protocol wants a fresh head run and this head has not been nudged yet, produce one
 * (mark-ready / reopen) and record the head so we fire at most once per landing attempt. Returns
 * `true` only when the self-heal was **actually applied** (the caller should re-poll); returns
 * `false` when no self-heal applies **or** the action was selected but failed (`ok === false`, e.g.
 * missing permission / repo policy) — so a caller that gates escalation on this (the `"draft"`
 * branch) falls through to the actionable escalation instead of `continue`-looping forever on a
 * self-heal that can never succeed. One implementation so the two verdicts can never drift (attempt
 * de-dupe, persistence, logging). `ensure` is injectable for tests; production uses the real
 * {@link ensureFreshHeadRun}. */
export async function maybeEnsureFreshHeadRun(
  data: DataLayer,
  repo: string,
  number: number,
  prKey: string,
  protocol: MergeProtocol,
  verdict: "ready" | "waiting" | "conflict" | "blocked" | "draft",
  st: PrState,
  pr: PullRequest,
  ensure: typeof ensureFreshHeadRun = ensureFreshHeadRun,
): Promise<boolean> {
  const action = freshHeadRunAction(protocol, verdict, headRunPresenceCount(protocol, st), st.isDraft, {
    headRefOid: st.headRefOid,
    lastActionHeadRefOid: pr.fresh_head_run_head,
  });
  if (!action) return false;
  const ok = await ensure(repo, number, action).catch(() => false);
  if (ok && st.headRefOid) {
    await prs(data).update(prKey, { fresh_head_run_head: st.headRefOid, updated_at: now() });
  }
  console.log(`[poller] ${verdict} -> fresh head run (${action}) ${ok ? "requested" : "skipped"} -> ${prKey}`);
  return ok;
}

/** Merge-stage poll pass (SPEC §11). Four durable waits, each keyed off the PR's `status`, are
 * advanced by correlating a message — mirroring the review-ready pattern so the process owns
 * the wait and this glue only signals when a GitHub condition is met:
 *   • waiting_deps  → every declared dependency has merged        → `deps-cleared`
 *   • waiting_merge → GitHub settled the PR as mergeable/blocked  → `merge-ready` {mergeState}
 *   • waiting_lane  → predecessor in same exclusion lane merged    → re-arm `waiting_merge`
 *   • queued        → the queued PR landed → `merge-landed`; or it conflicts (DIRTY) → `merge-evicted`
 * On publish we flip status to the transient `merging` (which no branch scans) so a slow pass
 * can't double-signal, exactly as `pollReviews` flips to `converging`; `flipToMergingThenPublish`
 * reverts the flip if the publish fails so a failed handoff can't wedge the PR.
 *
 * EVERY branch first runs {@link advanceIfTerminalOutOfBand} — one shared "is this PR already
 * terminal (merged/closed) out-of-band?" pre-check — so no merge stage can silently strand when a PR
 * is landed/closed outside the loop (the `waiting_deps` self-merged wedge, #368). */
export async function pollMerges(data: DataLayer, engine: EngineClient, token: string) {
  // 1) Dependencies merged?
  for (const pr of await prs(data).find({ status: "waiting_deps" })) {
    const prKey = pr.pr_key;
    try {
      // Out-of-band terminal FIRST: a PR merged/closed outside the loop while parked at `wait-deps`
      // must converge even if its declared deps never clear (the #368 wedge). `wait-deps` subscribes
      // only `deps-cleared`, so the shared pre-check publishes exactly that.
      if (await advanceIfTerminalOutOfBand(data, engine, pr, token)) continue;
      const depRows = await deps(data).find({ pr_key: prKey });
      let allMerged = true;
      for (const d of depRows) {
        if (!(await isDepMerged(data, d.depends_on_key, token))) {
          allMerged = false;
          break;
        }
      }
      if (!allMerged) continue;
      await flipToMergingThenPublish(data, engine, prKey, "waiting_deps", {
        name: "deps-cleared",
        correlationKey: prKey,
        variables: {},
      });
      console.log(`[poller] deps cleared -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] deps ${prKey}: ${err}`);
    }
  }

  // 2) Mergeable / blocked?
  for (const pr of await prs(data).find({ status: "waiting_merge" })) {
    const { repo, number, pr_key: prKey } = pr;
    try {
      const st = await fetchPrState(repo, number, token);
      if (st === null) continue; // no transport → skip this PR (others may still advance)
      // Out-of-band terminal (merged/closed) → the shared pre-check publishes `merge-ready {ready}`,
      // routing through `gw-mergeable → attempt-merge` whose idempotent already-merged check completes
      // the loop (`mark-merged`) and whose closed short-circuit abandons a PR closed without merging
      // (#342/#350). Reuse the `st` we just read so we don't double-fetch. This is the proven terminal
      // path the whole class (#368) now shares.
      if (await advanceIfTerminalOutOfBand(data, engine, pr, token, st)) continue;
      // Load the repo's merge protocol ONCE per PR iteration and pass it into the classifier so the
      // protocol-aware backstop (#392) can gate a red DECLARED-required check even when GitHub reports
      // the PR as UNSTABLE. The same handle is reused by the frugal-CI fresh-head-run branch below.
      const protocol = await loadMergeProtocol(repo, token).catch(() => null);
      const verdict = classifyMergeability(st, protocol ?? undefined);
      if (verdict === "draft") {
        // A draft PR is never landable — GitHub refuses the merge outright (issue #454). Two remedies,
        // in order: (1) self-heal — when the repo's merge protocol has a mark-ready capability
        // (`freshHeadRun: "ready"`/`"ready-or-reopen"`), mark the PR ready ourselves (the frugal-CI
        // path), which both un-drafts it and produces the required run, then re-poll; a `"reopen"`-only
        // protocol has NO mark-ready capability, so `freshHeadRunAction` returns null for a draft (a
        // reopen can't un-draft) and this falls straight through to (2). (2) otherwise — no self-heal
        // applies, OR the self-heal was attempted but could not be performed (e.g. missing permission /
        // repo policy) — escalate with an ACTIONABLE "mark it ready" message, instead of
        // `continue`-looping forever on a self-heal that can never succeed or surfacing GitHub's opaque
        // "blocked" refusal.
        if (protocol) {
          if (await maybeEnsureFreshHeadRun(data, repo, number, prKey, protocol, verdict, st, pr)) {
            continue; // re-poll: the mark-ready both un-drafts the PR and produces the required run
          }
        }
        // No applicable (or successful) protocol-driven self-heal → escalate so a human marks it ready.
        await flipToMergingThenPublish(data, engine, prKey, "waiting_merge", {
          name: "merge-ready",
          correlationKey: prKey,
          variables: {
            mergeState: verdict, // "draft" → gw-mergeable default → merge-esc-conflict (draft-aware FEEL)
            failingChecks: st.failingChecks,
            failingChecksList: st.failingCheckNames.join("\n"),
          },
        });
        console.log(`[poller] draft (no self-heal) -> escalate mark-ready -> ${prKey}`);
        continue;
      }
      if (verdict === "waiting") {
        // Frugal-CI remedy (#43): when the repo publishes a merge protocol that wants a fresh
        // head run and the PR has NO required head run yet, review has converged but the last push
        // produced no CI run — so branch protection's required checks read as "expected" forever
        // and this PR would wait indefinitely. Judge "no run yet" by the protocol's *required*
        // checks (headRunPresenceCount), not the raw rollup length, so an incidental always-on
        // check (e.g. Mergify's "Merge Queue") doesn't mask a missing run. Produce a fresh
        // `pull_request` run once per head (mark ready / close+reopen); rebases change
        // `headRefOid`, so downstream merge-train PRs get a new nudge after every post-rebase
        // landing attempt.
        if (protocol) {
          await maybeEnsureFreshHeadRun(data, repo, number, prKey, protocol, verdict, st, pr);
        }
        continue; // GitHub still computing / checks pending
      }
      if (verdict === "ready") {
        const lane = await mergeLaneDecisionForPr(data, prKey);
        if (lane?.isHeld) {
          await prs(data).update(prKey, { status: "waiting_lane", updated_at: now() });
          await mirrorTaskStatusForPr(data, prKey, "waiting-for-lane");
          console.log(`[poller] merge lane held by ${lane.laneHeadOf ?? "unknown"} -> ${prKey}`);
          continue;
        }
      }
      await flipToMergingThenPublish(data, engine, prKey, "waiting_merge", {
        name: "merge-ready",
        correlationKey: prKey,
        variables: {
          mergeState: verdict,
          // Carried for the senior:fix-ci branch (verdict "blocked" = a failed required check).
          // Joined to a scalar so it rides the message payload without a list projection; the
          // fix-ci task appends it to the agent prompt so the agent knows which gates to green.
          failingChecks: st.failingChecks,
          failingChecksList: st.failingCheckNames.join("\n"),
        },
      });
      console.log(`[poller] mergeable=${verdict} (${st.mergeStateStatus}) -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] merge ${prKey}: ${err}`);
    }
  }

  // 3) Lane-held PR released?
  for (const pr of await prs(data).find({ status: "waiting_lane" })) {
    const prKey = pr.pr_key;
    try {
      // Out-of-band terminal FIRST: a lane-held PR merged/closed outside the loop must converge even
      // if its lane predecessor never releases the hold. waiting_lane leaves the process parked at
      // `wait-mergeable`, so the shared pre-check publishes `merge-ready {ready}` (→ attempt-merge).
      if (await advanceIfTerminalOutOfBand(data, engine, pr, token)) continue;
      const lane = await mergeLaneDecisionForPr(data, prKey);
      if (lane?.isHeld) continue;
      await prs(data).update(prKey, { status: "waiting_merge", updated_at: now() });
      await mirrorTaskStatusForPr(data, prKey, "opened");
      console.log(`[poller] merge lane released -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] lane ${prKey}: ${err}`);
    }
  }

  // 4) Queued PR landed — or fell out of the merge queue?
  //
  // A PR enqueued by `attempt-merge` (mergeStatus="queued") parks the process at `wait-landed`.
  // Two things can end that wait: the queue lands the PR (→ `merge-landed`), or the PR is EVICTED
  // from the queue because its base moved under it and it now conflicts (`DIRTY`). Without the
  // eviction path a conflicted-after-enqueue PR waits forever (nothing ever publishes
  // `merge-landed`), which is exactly how #727/instance 729 wedged. We must NOT treat a merely
  // "not yet landed" PR as evicted: while it is legitimately queuing GitHub often reports it as
  // BLOCKED (a pending queue check) or UNSTABLE, which `classifyMergeability` calls not-ready. Only
  // a genuine merge CONFLICT (`DIRTY`) means it has dropped out — evict on that alone and re-arm the
  // merge poller (`merge-evicted` → `arm-merge`), which re-runs the mergeable gate so the existing
  // auto-rebase / escalate machinery resolves the conflict.
  for (const pr of await prs(data).find({ status: "queued" })) {
    const { repo, number, pr_key: prKey } = pr;
    try {
      const st = await fetchPrState(repo, number, token);
      if (st === null) continue; // no transport → skip this PR (others may still advance)
      // Out-of-band terminal FIRST (reusing `st`): a queued PR merged out-of-band lands
      // (`merge-landed` → mark-merged); one CLOSED out-of-band without merging can never land, so the
      // pre-check re-arms it (`merge-evicted` → arm-merge) and block 2 abandons it — a closed queued
      // PR would otherwise wedge, since `queuedVerdict` calls a non-DIRTY closed PR merely "waiting"
      // (#368). The DIRTY-while-open eviction below still handles a live-but-conflicted queue drop.
      if (await advanceIfTerminalOutOfBand(data, engine, pr, token, st)) continue;
      // Terminal states (merged/closed) are handled by the shared pre-check above; here the PR is
      // still open, so the only remaining reason to leave `wait-landed` is a live queue DROP — a real
      // merge CONFLICT (`DIRTY`). `queuedVerdict` stays the canonical classifier for that.
      if (queuedVerdict(st) === "evicted") {
        await flipToMergingThenPublish(data, engine, prKey, "queued", {
          name: "merge-evicted",
          correlationKey: prKey,
          variables: {},
        });
        console.log(`[poller] queued PR evicted (conflict) -> ${prKey}`);
      }
      // otherwise: still legitimately in the queue — keep waiting.
    } catch (err) {
      console.error(`[poller] queued ${prKey}: ${err}`);
    }
  }
}

/** Decide what to do with a PR the process enqueued (parked at `wait-landed`), from its current
 *  GitHub merge state:
 *   • `landed`  — the queue merged it → publish `merge-landed` (advance to mark-merged).
 *   • `evicted` — it fell out of the queue with a real merge CONFLICT (`DIRTY`) → publish
 *     `merge-evicted` so the process re-arms the merge poller and the mergeable gate re-runs
 *     (auto-rebase / escalate). Without this a conflicted-after-enqueue PR waits forever.
 *   • `waiting` — still legitimately in the queue. Crucially, a queuing PR is frequently reported
 *     BLOCKED/UNSTABLE (a pending queue check), which is NOT eviction — only `DIRTY` is. */
export function queuedVerdict(st: PrState): "landed" | "evicted" | "waiting" {
  if (st.merged) return "landed";
  if (st.mergeStateStatus === "DIRTY") return "evicted";
  return "waiting";
}

/** The subset of a Camunda-8 `/v2/jobs/search` result item this app reads. `worker` is the
 * leasing worker's name (empty/absent until an agent activates the job); `deadline` is the
 * activation lock's expiry (ISO ts). */
interface JobSearchItem {
  worker?: string;
  deadline?: string | null;
  state?: string;
}

/** One job-activation poll pass. The `converging` status means the process is parked at the
 * `review-round` service task with a `senior:pr-review` job outstanding — but it does not say
 * whether an external agent has *activated* (leased) that job yet. This pass reads that off the
 * engine's Camunda-8 `/v2/jobs/search`: an activated job carries a leasing `worker` + a lock
 * `deadline`; a merely-created (queued) one carries neither. (The wire `state` can't tell them
 * apart — Camunda's JobStateEnum has no ACTIVATED value, so the engine projects Activated ->
 * CREATED; the `worker`/`deadline` fields are the compatible activation signal.)
 *
 * It writes `active_worker` + `lease_until` onto the PR row so the pages surface can show
 * "agent working" vs "queued (awaiting an agent)", updating (and bumping `updated_at`) only on
 * an actual change so a steady state doesn't churn the grid. Best-effort: any transport failure
 * leaves the last-known values untouched and the next pass retries. */
async function pollJobActivation(
  data: DataLayer,
  restAddress: string,
  engineToken: string | undefined,
) {
  const base = restAddress.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (engineToken) headers.authorization = `Bearer ${engineToken}`;

  const all = await prs(data).all();
  for (const pr of all) {
    // Only a `converging` PR has a live review-round job. Any other status with a stale worker
    // set (e.g. it just moved to `waiting_review`) gets cleared so the grid can't show a
    // phantom "agent working".
    if (pr.status !== "converging") {
      if (pr.active_worker || pr.lease_until) {
        await prs(data).update(pr.pr_key, {
          active_worker: null,
          lease_until: null,
          updated_at: now(),
        });
      }
      continue;
    }
    // A `converging` PR without a `process_key` has no engine instance to query (creation
    // failed or is mid-transition), so clear any stale activation lease before skipping —
    // otherwise the grid could show a phantom "agent working".
    if (!pr.process_key) {
      if (pr.active_worker || pr.lease_until) {
        await prs(data).update(pr.pr_key, {
          active_worker: null,
          lease_until: null,
          updated_at: now(),
        });
      }
      continue;
    }

    let worker: string | null = null;
    let leaseUntil: string | null = null;
    try {
      const res = await fetch(`${base}/jobs/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: { type: REVIEW_JOB_TYPE, processInstanceKey: pr.process_key, state: "CREATED" },
          page: { limit: 20 },
        }),
      });
      if (!res.ok) continue; // engine unhappy → keep last-known, retry next pass
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = (await res.json()) as { items?: JobSearchItem[] };
      // An open job with a leasing worker means an agent has activated it. Prefer the one with
      // the latest deadline if several are open (there is normally at most one).
      const activated = (body.items ?? [])
        .filter((j) => typeof j.worker === "string" && j.worker.length > 0)
        .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""))
        .pop();
      if (activated) {
        worker = activated.worker ?? null;
        leaseUntil = activated.deadline ?? null;
      }
    } catch (err) {
      console.error(`[poller] job-activation ${pr.pr_key}: ${err}`);
      continue;
    }

    if (worker !== (pr.active_worker ?? null) || leaseUntil !== (pr.lease_until ?? null)) {
      await prs(data).update(pr.pr_key, {
        active_worker: worker,
        lease_until: leaseUntil,
        updated_at: now(),
      });
    }
  }
}

/** The subset of a Camunda-8 `/v2/incidents/search` result item this app reads. `incidentKey` is
 * the unique incident id; `errorMessage` is the human-readable fault; `state` is the incident
 * lifecycle (`ACTIVE` while it parks the token, `RESOLVED` once cleared); `creationTime` orders
 * concurrent incidents. */
interface IncidentSearchItem {
  incidentKey?: string;
  errorMessage?: string | null;
  state?: string;
  creationTime?: string | null;
}

/** Incident-surfacing poll pass (issue #94). A convergence or merge process instance can hit a
 * *technical* incident — an unhandled engine error that parks the token — and nothing on the PR
 * row reflected it: the grid kept showing the last workflow status (`converging`, `merging`, …)
 * while the run was actually dead in the water (a PR sat "converging" all day on an incident).
 *
 * This pass reads the engine's Camunda-8 `/v2/incidents/search` for each PR that still has a live
 * instance (has a `process_key`, non-terminal status) and mirrors an ACTIVE incident onto two
 * orthogonal columns — `incident_key` + `incident_message` — leaving `status` untouched. An
 * incident is a cross-cutting liveness fault, not a workflow stage, so it must not overload the
 * status machine. Clearing is idempotent: when the instance has no active incident (resolved, or
 * never had one) the columns are nulled, so an incident raised or resolved out-of-band converges
 * to the truth on the next pass. Best-effort transport: a failed query leaves the last-known
 * values untouched and the next pass retries. Updates (and bumps `updated_at`) only on an actual
 * change so a steady state doesn't churn the grid. */
async function pollIncidents(
  data: DataLayer,
  restAddress: string,
  engineToken: string | undefined,
) {
  const base = restAddress.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (engineToken) headers.authorization = `Bearer ${engineToken}`;
  await pollIncidentsImpl(data, base, headers);
}

/** Testable core of {@link pollIncidents}: given the normalised `base` URL and prepared auth
 * `headers`, reconcile every PR row against the engine's active incidents. Split out so tests can
 * exercise the reconciliation with a stubbed `fetch` without re-deriving transport wiring. */
export async function pollIncidentsImpl(
  data: DataLayer,
  base: string,
  headers: Record<string, string>,
) {
  const all = await prs(data).all();
  for (const pr of all) {
    // No live instance to inspect (never created, mid-transition, or terminal — the run has
    // finished or was given up, so its instance is gone) → make sure no stale incident lingers on
    // the row, then move on. Reuses the canonical `TERMINAL_STATUSES` so incident logic can't drift
    // from the rest of the status machine.
    if (!pr.process_key || TERMINAL_STATUSES.includes(pr.status)) {
      if (pr.incident_key || pr.incident_message) {
        await prs(data).update(pr.pr_key, {
          incident_key: null,
          incident_message: null,
          updated_at: now(),
        });
      }
      continue;
    }

    let incidentKey: string | null = null;
    let incidentMessage: string | null = null;
    try {
      const res = await fetch(`${base}/incidents/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: { processInstanceKey: pr.process_key, state: "ACTIVE" },
          page: { limit: 20 },
        }),
      });
      if (!res.ok) continue; // engine unhappy → keep last-known, retry next pass
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = (await res.json()) as { items?: IncidentSearchItem[] };
      // Surface the oldest ACTIVE incident (the first thing that broke — a stable choice if the
      // instance somehow parks more than one). Re-filter on state defensively in case the wire
      // filter is ignored. An incident with no `creationTime` sorts *last*, so a missing timestamp
      // can never masquerade as the oldest.
      const active = (body.items ?? [])
        .filter((i) => (i.state ?? "ACTIVE") === "ACTIVE")
        .sort((a, b) =>
          (a.creationTime ?? "\uffff").localeCompare(b.creationTime ?? "\uffff")
        )[0];
      if (active) {
        incidentKey = active.incidentKey ?? null;
        incidentMessage = active.errorMessage ?? null;
      }
    } catch (err) {
      console.error(`[poller] incidents ${pr.pr_key}: ${err}`);
      continue;
    }

    if (
      incidentKey !== (pr.incident_key ?? null) ||
      incidentMessage !== (pr.incident_message ?? null)
    ) {
      await prs(data).update(pr.pr_key, {
        incident_key: incidentKey,
        incident_message: incidentMessage,
        updated_at: now(),
      });
    }
  }
}

/** The `wave-merged` message name (`resources/processes/plan-fanout.bpmn`): the `wait-wave-merged`
 * catch event opens a subscription for it (correlated on `=planKey`) once the token arrives, and
 * the poller publishes it to release the next wave. Single source of truth for the string shared by
 * the publish and the subscription probe. */
const WAVE_MERGED_MESSAGE = "wave-merged";

/** The subset of a Camunda-8 `/v2/message-subscriptions/search` result item this app reads to tell
 * whether the plan-fanout instance is *currently parked* at `wait-wave-merged`. `messageName` is the
 * awaited message; `correlationKey` is the plan key the catch event binds; `messageSubscriptionState`
 * is `CREATED` while the subscription is open (waiting) and `CORRELATED`/`DELETED` once consumed. */
interface MessageSubscriptionSearchItem {
  messageName?: string;
  correlationKey?: string | null;
  messageSubscriptionState?: string;
}

/** Is the plan-fanout instance `processKey` right now parked at `wait-wave-merged` with an OPEN
 * (`CREATED`) subscription correlated on `planKey`? Reads the engine's Camunda-8
 * `/v2/message-subscriptions/search` (the same raw-REST search surface `pollIncidents`/
 * `pollJobActivation` use). Returns `true` (open — safe to release), `false` (no open subscription —
 * the token is either upstream of the wait or has already passed through it), or `null` (transport
 * unhappy / unparseable body — "unknown", so the caller neither publishes nor acts on a guess and
 * simply retries next tick). This is the load-bearing check that makes the barrier level-triggered:
 * we only ever publish `wave-merged` into a subscription we've observed OPEN, so a signal can never
 * be dropped into the void (the #262 wedge) nor buffered to trip a *later* wave's barrier. */
async function waveMergedSubscriptionOpen(
  base: string,
  headers: Record<string, string>,
  processKey: string,
  planKey: string,
): Promise<boolean | null> {
  try {
    const res = await fetch(`${base}/message-subscriptions/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        filter: {
          processInstanceKey: processKey,
          messageName: WAVE_MERGED_MESSAGE,
          messageSubscriptionState: "CREATED",
        },
        page: { limit: 20 },
      }),
    });
    if (!res.ok) return null; // engine unhappy → "unknown", retry next pass
    // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
    const body = (await res.json()) as { items?: MessageSubscriptionSearchItem[] };
    // Re-filter defensively in case the engine ignores a filter field: an OPEN (`CREATED`)
    // subscription for the `wave-merged` message, correlated on THIS plan key, is the barrier we may
    // publish into. Every field must be PRESENT and match explicitly — we never default a
    // missing/null `messageName`, `correlationKey`, or `messageSubscriptionState` to its expected
    // value. Doing so would treat an unverifiable item as OPEN and re-introduce the exact #262
    // failure class (publishing into a subscription we never confirmed open, buffering a message that
    // trips a later wave's barrier). An item that omits a field is "unknown", so we simply don't
    // match it: a false negative only costs a retry next pass, whereas a false positive is a wedge.
    // State is compared case-insensitively so a future casing tweak can't silently drop the match.
    return (body.items ?? []).some(
      (it) =>
        it.messageName === WAVE_MERGED_MESSAGE &&
        it.correlationKey === planKey &&
        typeof it.messageSubscriptionState === "string" &&
        it.messageSubscriptionState.toUpperCase() === "CREATED",
    );
  } catch (err) {
    console.error(`[poller] wave-merged subscription ${planKey}: ${err}`);
    return null; // transport threw → "unknown", retry next pass
  }
}

/** Wave-merge barrier poll pass (issue #262). After `record-wave` hands off a wave that has a
 * successor, the plan-fanout instance eventually parks at the `wait-wave-merged` catch event and
 * `plans.gate_wave` records that wave's index. Here we reconcile, on EVERY pass and idempotently,
 * the external GitHub fact "every OPENED PR in that wave has MERGED" against the engine fact "is
 * there an OPEN `wait-wave-merged` subscription for this plan right now?", publishing `wave-merged`
 * (correlated on the plan key) to release the next wave's implementation whenever BOTH hold.
 *
 * This is deliberately LEVEL-triggered, not the old single-shot edge trigger. The gate is armed at
 * wave handoff — long before the token traverses `select-wave → trial-merge (a slow agent job) →
 * … → wait-wave-merged` and opens the subscription. If the wave's PRs merged while the token was
 * still upstream, the old code published its one `wave-merged` into NO open subscription (dropped)
 * AND cleared `gate_wave`, so it never republished and the epic wedged forever once the token
 * finally arrived (#262). We fix the class:
 *   • We publish ONLY when {@link waveMergedSubscriptionOpen} confirms the token is parked at the
 *     wait — never into the void — so a merged-before-arrival wave simply waits, and a later pass
 *     (once the token arrives) republishes and correlates.
 *   • We NEVER clear `gate_wave` here. `record-wave` owns its lifecycle (it re-arms it to the next
 *     wave, or clears it to `null` on the final wave), so a signal published into the void can't
 *     strand the gate, and double-advance is guarded by the open-subscription check — which, by the
 *     handoff ordering, always matches the wave whose wait is currently open — not by a premature
 *     clear. A wave whose tasks all ended `blocked`/`skipped` (no opened PR to wait on) has an empty
 *     merge-target set and so is treated as merged; `record-wave` advances it on the next pass. */
export async function pollWaveGatesImpl(
  data: DataLayer,
  engine: EngineClient,
  token: string,
  base: string,
  headers: Record<string, string>,
) {
  for (const plan of await plans(data).all()) {
    const gateWave = plan.gate_wave;
    if (gateWave == null) continue;
    const planKey = plan.plan_key;
    try {
      let allMerged = true;
      const tasks = await planTasks(data).find({ plan_key: planKey });
      for (const prKey of waveMergeTargets(tasks, gateWave)) {
        const state = await classifyWaveTarget(data, prKey, token);
        if (state === "closed") {
          // Self-heal (#352): a wave-target PR closed on GitHub WITHOUT merging (abandoned /
          // superseded / perpetually conflicting) can never reach `merged`, so it must NOT keep the
          // barrier armed forever. Retire it through the canonical abandon writer — flipping the
          // `plan_tasks` row terminal so it drops out of `waveMergeTargets` and the epic read model —
          // and treat it as non-blocking: the wave completes on its surviving merged members. This is
          // the wave-gate reach of the SAME abandon path the merge stage uses for a closed member.
          await abandonClosedPr(
            data,
            prKey,
            "wave-target PR was closed on GitHub without merging — reconciling terminal so the wave gate can advance",
          );
          console.log(`[poller] wave-target closed without merging -> ${prKey}`);
          continue;
        }
        if (state === "pending") {
          allMerged = false;
          break;
        }
      }
      if (!allMerged) continue; // wave not landed yet → leave the gate armed, retry next pass
      // The wave has landed on GitHub. Release the barrier ONLY if the token is actually parked at
      // `wait-wave-merged` (an OPEN subscription for this plan): otherwise publishing would be a
      // silent no-op that the old code paired with a gate clear — the edge-triggered wedge (#262).
      if (!plan.process_key) continue; // no instance key to correlate against yet
      const open = await waveMergedSubscriptionOpen(base, headers, plan.process_key, planKey);
      if (open !== true) continue; // not parked here yet / already released / unknown → NEVER clear the gate; retry next pass
      await engine.publishMessage({ name: WAVE_MERGED_MESSAGE, correlationKey: planKey, variables: {} });
      console.log(`[poller] wave ${gateWave} merged -> ${planKey}`);
    } catch (err) {
      console.error(`[poller] wave-gate ${planKey}: ${err}`);
    }
  }
}

/** The readiness-gate process id (`resources/processes/readiness-gate.bpmn`) the capability reconciler
 * starts one instance of per unresolved need — the durable, bounded, resumable wait that escalates to
 * an operator if the capability never ships (#258). Single source of truth for the string. */
const READINESS_GATE_PROCESS_ID = "readiness-gate";

/** Generic sibling of {@link waveMergedSubscriptionOpen}: is `processKey` right now parked at a catch
 * event with an OPEN (`CREATED`) subscription for `messageName` correlated on `correlationKey`? The
 * capability barrier (`wait-caps-resolved`) uses this to stay level-triggered exactly like the
 * wave-merge barrier — we publish `caps-resolved` ONLY into a subscription we've observed open, so a
 * signal is never dropped into the void nor buffered to trip a later task's barrier. Returns `true`
 * (open — safe to release), `false` (no open subscription), or `null` (transport unhappy / unparseable
 * — "unknown", retry next pass). Every field must be present and match explicitly (an item omitting a
 * field is "unknown", not a match) — a false negative only costs a retry, a false positive is a wedge.
 *
 * Unlike the wave-merge barrier (one subscription per plan, correlated on `planKey`), the capability
 * barrier opens ONE subscription PER TASK (each on its own `<planKey>:<taskId>` key), so a single
 * plan-fanout instance can have MANY `caps-resolved` subscriptions open at once. We therefore scope the
 * search server-side by `correlationKey` too — filtering only on process + message could return a page
 * of sibling tasks' subscriptions that overflows the page limit and omits THIS task's, a false negative
 * that wedges the gate forever. The client-side re-filter below is retained defensively. */
async function messageSubscriptionOpen(
  base: string,
  headers: Record<string, string>,
  processKey: string,
  messageName: string,
  correlationKey: string,
): Promise<boolean | null> {
  try {
    const res = await fetch(`${base}/message-subscriptions/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        filter: { processInstanceKey: processKey, messageName, correlationKey, messageSubscriptionState: "CREATED" },
        page: { limit: 50 },
      }),
    });
    if (!res.ok) return null;
    // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
    const body = (await res.json()) as { items?: MessageSubscriptionSearchItem[] };
    return (body.items ?? []).some(
      (it) =>
        it.messageName === messageName &&
        it.correlationKey === correlationKey &&
        typeof it.messageSubscriptionState === "string" &&
        it.messageSubscriptionState.toUpperCase() === "CREATED",
    );
  } catch (err) {
    console.error(`[poller] caps-resolved subscription ${correlationKey}: ${err}`);
    return null;
  }
}

/** The gate timeout (ISO-8601) seeded onto every capability readiness-gate. A capability need carries
 * no per-probe poll policy, so the bound is always the env/default (`NANO_READINESS_POLL_TIMEOUT`,
 * else 30m) — derived from readiness.ts's ONE place so it can't drift from the worker's local budget. */
function capabilityGateTimeout(env: Record<string, string | undefined>): string {
  return readinessTimeout({ kind: "capability", target: "" } satisfies ReadinessProbe, env);
}

function capabilityGatePollEvery(env: Record<string, string | undefined>): string {
  return readinessPollEvery({ kind: "capability", target: "" } satisfies ReadinessProbe, env);
}

/** Capability-edge reconcile pass (issue #289). The host half of the "consumer readiness edge":
 * plan-fanout's per-task fan-out parks at the `wait-caps-resolved` message barrier for any task that
 * declared cross-repo capability `needs` (049_plan_task_needs.sql). Here we reconcile, on EVERY pass
 * and idempotently, each such parked task against the external fact "has every one of its needed
 * capabilities shipped as a published `pkg@version`?", publishing `caps-resolved` (correlated on the
 * per-task barrier key) with the late-bound resolved-dependencies brief to release the agent whenever
 * ALL its needs resolve.
 *
 * The bounded/durable/resumable WAIT is NOT re-implemented here — it lives in the EXISTING
 * `readiness-gate` process (#258), which we start exactly once per need (recording its instance key on
 * `capability_gates.process_key`) so a capability that never ships escalates to an operator instead of
 * wedging the epic. This pass only (a) starts those gates and (b) performs a single DETERMINISTIC
 * provenance lookup per unresolved need (`probeOnce`, the gate's OWN matcher, reused verbatim — never a
 * second poll loop) to capture the resolved `pkg@version` for the late-bind. All state is durable in
 * `capability_gates`, so a host restart re-derives the picture from the DB: it never re-starts a gate,
 * never re-probes a resolved need, and — being level-triggered on the open subscription — never
 * re-publishes into a released barrier.
 *
 * Concurrency correctness (issue #289 §4, inherited from #274): an unrelated upstream release during
 * the wait does NOT resolve the edge (the provenance predicate matches only the capability-bearing
 * version) and does NOT spin an agent (this pass uses the deterministic lookup only — the gated
 * empirical `verifyCommand` fallback lives solely in the gate's worker, never here, so it can never
 * fire per unrelated release). */
export async function pollCapabilityGatesImpl(
  data: DataLayer,
  engine: EngineClient,
  base: string,
  headers: Record<string, string>,
  exec: ProbeExec = defaultProbeExec(),
  env: Record<string, string | undefined> = process.env,
) {
  const gateTable = capabilityGates(data);
  const probeTimeout = capabilityGateTimeout(env);
  const probePollEvery = capabilityGatePollEvery(env);
  for (const plan of await plans(data).all()) {
    const planKey = plan.plan_key;
    const processKey = plan.process_key;
    if (!processKey) continue; // no instance key to correlate the barrier against yet
    const needRows = await planTaskNeeds(data).find({ plan_key: planKey });
    if (needRows.length === 0) continue;
    // Group needs by consuming task — a task's barrier releases ONCE, fanning in ALL its needs.
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
    for (const [taskId, needs] of needsByTask) {
      const barrierKey = capabilityTaskBarrierKey(planKey, taskId);
      try {
        // Only reconcile a task whose fan-out is actually parked at `wait-caps-resolved` (an OPEN
        // subscription): otherwise publishing would be a signal into the void (the #262 wedge class).
        const open = await messageSubscriptionOpen(base, headers, processKey, CAPS_RESOLVED_MESSAGE, barrierKey);
        if (open !== true) continue; // not parked here yet / already released / unknown → retry next pass

        const resolved: ResolvedCapability[] = [];
        let allResolved = true;
        for (const need of needs) {
          const gateKey = capabilityGateKey(planKey, taskId, need.capabilityRef, need.package);
          let row = await gateTable.findOne({ gate_key: gateKey });

          // Shape the need into the readiness-gate's probe input. A handle that names no owner/repo
          // releases source is un-pollable — record it so the operator sees the wedge, and treat the
          // need as unresolved (it can only clear once the handle is corrected on a re-plan).
          let probeInput: ReturnType<typeof capabilityNeedToProbeInput>;
          try {
            probeInput = capabilityNeedToProbeInput(need, { planKey, taskId, probeTimeout, probePollEvery });
          } catch (err) {
            if (err instanceof UnresolvableCapabilityRefError) {
              if (!row) {
                await gateTable.insert({
                  gate_key: gateKey,
                  plan_key: planKey,
                  task_id: taskId,
                  capability_ref: need.capabilityRef,
                  package: need.package,
                  status: "pending",
                  resolved_artifact: null,
                  process_key: null,
                  created_at: now(),
                  updated_at: now(),
                });
              }
              console.error(`[poller] capability-gate ${gateKey}: ${err.message}`);
              allResolved = false;
              continue;
            }
            throw err;
          }

          // First sighting: record the gate row so we start it exactly once and survive a restart.
          if (!row) {
            await gateTable.insert({
              gate_key: gateKey,
              plan_key: planKey,
              task_id: taskId,
              capability_ref: need.capabilityRef,
              package: need.package,
              status: "pending",
              resolved_artifact: null,
              process_key: null,
              created_at: now(),
              updated_at: now(),
            });
            row = await gateTable.findOne({ gate_key: gateKey });
          }

          // Start the EXISTING durable readiness-gate exactly once (bounded wait + operator escalation
          // if the capability never ships). Idempotent: guarded on `process_key`, so a restart never
          // double-starts. A start failure is non-fatal — we retry the start next pass.
          if (row && !row.process_key) {
            try {
              const { processInstanceKey } = await engine.createInstance({
                processDefinitionId: READINESS_GATE_PROCESS_ID,
                variables: {
                  gateKey: probeInput.gateKey,
                  probeTimeout: probeInput.probeTimeout,
                  probePollEvery: probeInput.probePollEvery,
                  onTimeout: probeInput.onTimeout,
                  probe: probeInput.probe,
                },
              });
              await gateTable.update(gateKey, { process_key: processInstanceKey, updated_at: now() });
              row.process_key = processInstanceKey;
            } catch (err) {
              console.error(`[poller] capability-gate ${gateKey} start: ${err}`);
            }
          }

          // Already resolved on an earlier pass → reuse the pinned artifact (never re-probe).
          if (row && row.status === "resolved" && row.resolved_artifact) {
            resolved.push({ capabilityRef: need.capabilityRef, resolvedArtifact: row.resolved_artifact });
            continue;
          }

          // One deterministic provenance lookup (NOT a wait loop): has the capability shipped?
          const result = await probeOnce(probeInput.probe, exec, env);
          const artifact = result.bind?.resolvedArtifact;
          if (result.ready && artifact) {
            await gateTable.update(gateKey, { status: "resolved", resolved_artifact: artifact, updated_at: now() });
            resolved.push({ capabilityRef: need.capabilityRef, resolvedArtifact: artifact });
          } else {
            allResolved = false;
          }
        }

        // Fan-in: release the task ONLY when every need resolved. The brief pins each
        // `capabilityRef → pkg@version` into the agent's prompt (late-bind, issue #289 §3).
        if (allResolved && resolved.length === needs.length) {
          const resolvedDepsBrief = renderResolvedDepsBrief(resolved);
          await engine.publishMessage({
            name: CAPS_RESOLVED_MESSAGE,
            correlationKey: barrierKey,
            variables: { resolvedDepsBrief },
          });
          console.log(`[poller] capabilities resolved -> ${barrierKey} (${resolved.length})`);
        }
      } catch (err) {
        console.error(`[poller] capability-gate ${barrierKey}: ${err}`);
      }
    }
  }
}

/** Sentinel status fed to `deriveDelivery` for a `plan_tasks.pr_key` whose `pull_requests` row is
 * missing (DB desync). It is deliberately non-terminal and not `merged`, so a dangling PR counts as
 * in-flight — never a false-positive `landed` from a silently-dropped slice. */
const MISSING_PR_STATUS = "missing";

/** Recompute an epic's derived `delivery` signal at READ TIME (epic #412) from the SAME pure
 * `deriveDelivery` the `plan_delivery` VIEW encodes — by joining each slice `plan_tasks.pr_key` →
 * `pull_requests.status` (a dangling `pr_key` counts as in-flight, never false-`landed`). The
 * `plans.delivery` column was RETIRED, so the pollers that still need the signal derive it here
 * rather than reading a denormalised column. Non-`done` plans short-circuit to `null` (the view's
 * behaviour) without the per-plan task join. `statusByPrKey` is an optional once-per-pass PR-status
 * map (the pollers preload it to avoid an N+1); when omitted (a one-off caller like the
 * acknowledge-epic op) it loads only THIS plan's slice PRs on demand — never the whole table. */
export async function derivePlanDelivery(
  data: DataLayer,
  plan: Plan,
  statusByPrKey?: Map<string, string>,
): Promise<string | null> {
  if (plan.status !== "done") return null;
  const tasks = await planTasks(data).find({ plan_key: plan.plan_key });
  const prStatuses: string[] = [];
  for (const t of tasks) {
    if (!t.pr_key) continue;
    let status = statusByPrKey?.get(t.pr_key);
    if (status === undefined && !statusByPrKey) {
      // On-demand caller: fetch just this slice's PR row rather than loading the whole table.
      status = (await prs(data).get(t.pr_key))?.status;
    }
    prStatuses.push(status ?? MISSING_PR_STATUS);
  }
  return deriveDelivery(plan.status, prStatuses).delivery;
}

/** Idempotent read-model pass (issue #292 slice S4): project each DEPENDENT epic's inter-epic gate
 * state onto its `plans` row so the epic index/detail views can show — as flat columns — which
 * producer/package a parked dependent is blocked on, its poll cadence + escalation deadline, and the
 * bound `pkg@version` once green. Mirrors `pollDelivery`: joins each plan against its inbound
 * `plan_deps` edges (the S1 read API) and stamps the pure `deriveWaitGate` (app/waitGate.ts) result,
 * writing only when the projection actually changes so a steady-state pass is a no-op. Read-only over
 * the state S1–S3 produce — it NEVER touches admission, scheduling, or `plan.status`.
 *
 * A ROOT epic (no inbound edge) derives `{ null, null }` — no wait-gate; any stale projection left by
 * a prior edge (e.g. an edge later removed) is cleared defensively so the read model never keeps a
 * phantom gate. */
export async function pollWaitGate(data: DataLayer) {
  // Preload every plan_tasks row once per pass and group by plan_key, so deriving each plan's
  // fanned-out signal below is a map lookup rather than a per-plan `planTasks(data).find` (avoids
  // an N+1 that would double this pass's DB work alongside the per-plan `inboundPlanDeps` lookup).
  const wavesByPlanKey = new Map<string, number[]>();
  for (const t of await planTasks(data).all()) {
    if (t.wave == null) continue;
    const list = wavesByPlanKey.get(t.plan_key) ?? [];
    list.push(t.wave);
    wavesByPlanKey.set(t.plan_key, list);
  }
  for (const plan of await plans(data).all()) {
    try {
      const edges = await inboundPlanDeps(data, plan.plan_key);
      // `plans.current_wave` was retired (epic #412); `deriveWaitGate` only consumes its
      // NULL-ness (proof the epic's fan-out began). Derive that at read time: an epic has fanned out
      // iff it has ≥1 levelized `plan_tasks` row (a wave assigned). The value's magnitude is never
      // surfaced here — the epic index/detail read the display `current_wave` off the
      // `plan_wave_label`/`plan_read_model` VIEWs — so any non-null (the frontier's min wave) is
      // faithful for the gate's "has this epic ever fanned out?" test.
      const assignedWaves = wavesByPlanKey.get(plan.plan_key) ?? [];
      const current_wave = assignedWaves.length > 0 ? Math.min(...assignedWaves) : null;
      const { wait_gate, wait_gate_label } = deriveWaitGate(edges, {
        status: plan.status,
        current_wave,
        bound_artifacts: plan.bound_artifacts,
        created_at: plan.created_at,
      });
      if (plan.wait_gate !== wait_gate || plan.wait_gate_label !== wait_gate_label) {
        await plans(data).update(plan.plan_key, {
          wait_gate,
          wait_gate_label,
          updated_at: now(),
        });
      }
    } catch (err) {
      console.error(`[poller] wait-gate ${plan.plan_key}: ${err}`);
    }
  }
}

/** Idempotent promotion pass (issue #299): open — and then track — the `epic/* → <default>`
 * promotion PR for every epic that has LANDED on a custom integration branch. This is the missing
 * counterpart to `ensureBaseBranch`: that creates the `epic/*` branch slices merge into; this
 * delivers the fully-landed branch to the default branch. Derives each epic's `delivery` signal at
 * read time (epic #412 — the `plans.delivery` column was retired) via the same pure `deriveDelivery`.
 *
 * Per promotable plan (`isPromotable`: `delivery = landed` AND base is `epic/*`):
 *   • No promotion PR yet → open ONE `epic/* → <default>` PR (idempotent against a remote head-branch
 *     lookup, so a crash between GitHub-create and the `promotion_pr` write can't duplicate it),
 *     record `promotion_pr`, mark `promotion_state = open`, and enroll it into the convergence + merge
 *     loop via `submitPr` (a real PR that must go green + converge before it merges — never an
 *     auto-merge). If the PR can't be opened this pass (no default branch resolvable, no transport),
 *     leave it at `promotion_state = ready` and retry next pass.
 *   • Promotion PR already recorded → project `promotion_state` from its live status
 *     (`merged → promoted`, else `open`); if its `pull_requests` row is absent (a prior `submitPr`
 *     failed / DB desync) re-enroll it (idempotent).
 *
 * A `main`-based epic (base is not `epic/*`) is never promotable — its slices already landed on the
 * default branch, so there is nothing to promote. Best-effort + per-plan isolated. */
export async function pollPromotion(data: DataLayer, engine: EngineClient, token: string) {
  // Preload every PR status once per pass (mirrors pollDelivery — avoids an N+1 `prs(data).get`).
  const statusByPrKey = new Map<string, string>();
  for (const pr of await prs(data).all()) statusByPrKey.set(pr.pr_key, pr.status);
  for (const plan of await plans(data).all()) {
    const base = plan.base_branch;
    // A non-`epic/*` base is never promotable — short-circuit before the per-plan delivery join.
    if (!isEpicIntegrationBranch(base)) continue;
    try {
      // `plans.delivery` was retired (epic #412) — derive the landed signal at READ TIME from the
      // slice PRs (same pure `deriveDelivery` the `plan_delivery` VIEW encodes) instead of reading a
      // denormalised column, then apply the pure `isPromotable` predicate.
      const delivery = await derivePlanDelivery(data, plan, statusByPrKey);
      if (!isPromotable({ delivery, base_branch: base })) continue;
      // Already opened → project state from the promotion PR's live status, and re-enroll it if its
      // convergence row went missing (a prior submit failed, or the app/engine store desynced).
      if (plan.promotion_pr) {
        const prStatus = statusByPrKey.get(plan.promotion_pr) ?? null;
        const nextState = derivePromotionState(true, prStatus === "merged");
        if (plan.promotion_state !== nextState) {
          await plans(data).update(plan.plan_key, { promotion_state: nextState, updated_at: now() });
        }
        if (prStatus === null) {
          const parsed = parsePr(plan.promotion_pr);
          if (parsed) await submitPr(data, engine, parsed);
        }
        continue;
      }
      // Not opened yet: this epic is ready to promote. Resolve the target (default) branch; without
      // it we can't open the PR this pass, so surface `ready` and retry.
      const target = await fetchDefaultBranch(plan.repo, token);
      if (!target || target === base) {
        // `target === base` is a defensive guard (an `epic/*` base can't be the default), but never
        // open a branch-into-itself PR. Either way, mark ready and retry.
        if (plan.promotion_state !== "ready") {
          await plans(data).update(plan.plan_key, { promotion_state: "ready", updated_at: now() });
        }
        continue;
      }
      const tasks = await planTasks(data).find({ plan_key: plan.plan_key });
      const slicePrKeys = tasks.map((t) => t.pr_key).filter((k): k is string => !!k);
      const epicTitle = coalesceTitle(plan.title, plan.plan_key);
      const title = promotionPrTitle(base, target, epicTitle);
      const body = promotionPrBody(base, target, plan.plan_key, slicePrKeys);
      const result = await ensurePromotionPr(plan.repo, base, target, title, body, token);
      if (!result) {
        // No transport this pass — surface ready-to-promote and retry.
        if (plan.promotion_state !== "ready") {
          await plans(data).update(plan.plan_key, { promotion_state: "ready", updated_at: now() });
        }
        continue;
      }
      const promotionPrKey = `${plan.repo}#${result.number}`;
      // Persist the idempotency key + state BEFORE enrolling, so a submit failure can never lead a
      // later pass to open a second PR (it will see `promotion_pr` set and only re-enroll).
      await plans(data).update(plan.plan_key, {
        promotion_pr: promotionPrKey,
        promotion_state: "open",
        updated_at: now(),
      });
      const parsed = parsePr(promotionPrKey);
      if (parsed) await submitPr(data, engine, parsed);
      console.log(
        `[poller] promotion PR ${result.created ? "opened" : "reused"} ${promotionPrKey} (${base} -> ${target})`,
      );
    } catch (err) {
      console.error(`[poller] promotion ${plan.plan_key}: ${err}`);
    }
  }
}

/** Reconcile each in-flight FEATURE run against its handed-off PR (fix: Feature history stuck at
 * `converging`). A feature run ends its own process with `status = converging` and its PR's live
 * outcome (merged / converged / abandoned) thereafter lives only on the `pull_requests` row keyed
 * by `pr_key` — so the Feature history grid, which reads `feature_runs`, showed `converging` forever.
 * This is the `feature_runs` twin of `pollDelivery` (which does the same for epic `plans`): for each
 * run currently `converging` with a `pr_key`, project the PR's status onto `feature_runs.status`
 * (advancing it to the matching terminal outcome once the PR settles) + a human `delivery_label`.
 * Never touches a run that isn't `converging` — additive/derived only, idempotent, best-effort. */
export async function pollFeatureDelivery(data: DataLayer) {
  // Preload every PR status once per pass (mirrors pollDelivery — avoids an N+1 `prs(data).get`).
  const statusByPrKey = new Map<string, string>();
  for (const pr of await prs(data).all()) statusByPrKey.set(pr.pr_key, pr.status);
  // Only `converging` runs are ever reconciled — query them via the `feature_runs(status)` index
  // (db/migrations/028) instead of scanning all history, so this pass stays O(in-flight), not
  // O(total runs), as the table grows.
  for (const run of await featureRuns(data).find({ status: "converging" })) {
    if (!run.pr_key) continue;
    try {
      const prStatus = statusByPrKey.get(run.pr_key) ?? null;
      const { status, label } = deriveFeatureDelivery(prStatus);
      if (run.status !== status || run.delivery_label !== label) {
        await featureRuns(data).update(run.feature_key, {
          status,
          delivery_label: label,
          updated_at: now(),
        });
      }
    } catch (err) {
      console.error(`[poller] feature delivery ${run.feature_key}: ${err}`);
    }
  }
}

/** The app manifest, read and parsed exactly ONCE at module load. `activeStatusesFor` is invoked
 * three times during module initialization (the PR/plan/feature constants below); parsing here keeps
 * that to a single synchronous `readFileSync` + `JSON.parse` instead of one per lookup. */
const APP_MANIFEST: { instanceTracking?: { table: string; activeStatuses?: string[] }[] } = JSON.parse(
  readFileSync(new URL("../nano.app.json", import.meta.url), "utf8"),
);

/** Read a tracked table's parked-and-active statuses from the single source of truth
 * (`instanceTracking.<table>.activeStatuses` in nano.app.json), so an app-side scan can never drift
 * from the reconciler's notion of "in-flight". Throws if the binding is missing/empty. */
function activeStatusesFor(table: string): readonly string[] {
  const binding = APP_MANIFEST.instanceTracking?.find((b) => b.table === table);
  if (!binding?.activeStatuses?.length) {
    throw new Error(
      `nano.app.json: instanceTracking[table="${table}"].activeStatuses is missing or empty`,
    );
  }
  return binding.activeStatuses;
}

/** The `pull_requests` statuses a PR instance can be parked-and-active on, DERIVED from the single
 * source of truth (`instanceTracking.pull_requests.activeStatuses` in nano.app.json) so the app-side
 * scan can never drift from the reconciler's notion of "in-flight". `pollUserTasks` scans only these
 * for an open `wait-answer` escalation, so the pass stays O(in-flight PRs), not O(all PRs). */
export const PR_ACTIVE_STATUSES: readonly string[] = activeStatusesFor("pull_requests");

/** The `plans` statuses a plan instance can be parked-and-active on, DERIVED from the same single
 * source of truth (`instanceTracking.plans.activeStatuses`) so `pollUserTasks`' plan scan can never
 * drift from the reconciler — mirroring `PR_ACTIVE_STATUSES` rather than hard-coding a second list. */
export const PLAN_ACTIVE_STATUSES: readonly string[] = activeStatusesFor("plans");

/** The `feature_runs` statuses a feature instance can be parked-and-active on, DERIVED from the same
 * single source of truth (`instanceTracking.feature_runs.activeStatuses`) so `pollUserTasks`' feature
 * scan can never drift from the reconciler — mirroring `PR_ACTIVE_STATUSES`/`PLAN_ACTIVE_STATUSES`
 * rather than hard-coding a second list. Notably includes the non-terminal `awaiting_operator`, so a
 * run that terminates while parked at `feature-blocked` still gets the `onTerminated` reconciliation
 * (rather than stranding at `awaiting_operator` and blocking re-dispatch). Narrowed to the typed
 * `FeatureRunStatus` union (throwing on any manifest status the code doesn't know) so the derived
 * list can feed `featureRuns(data).find({ status })` directly. */
function toFeatureRunStatus(status: string): FeatureRunStatus {
  for (const known of FEATURE_RUN_STATUSES) if (known === status) return known;
  throw new Error(`nano.app.json: feature_runs.activeStatuses has unknown status "${status}"`);
}
export const FEATURE_ACTIVE_STATUSES: readonly FeatureRunStatus[] =
  activeStatusesFor("feature_runs").map(toFeatureRunStatus);

/** The subset of a Camunda-8 `/v2/user-tasks/search` result item this app reads for the engine-first
 * sweep. `userTaskKey` is the completable key; `elementId` is the BPMN element (the escalation kind);
 * `processInstanceKey` is the instance the task parks on (the raw REST surface carries it — the typed
 * `EngineClient.openUserTasks` seam deliberately omits it from `UserTaskSummary`); `state` is the task
 * lifecycle (`CREATED` while open/answerable). Keys are stringified defensively (the wire may send
 * either a JSON number or string). */
interface UserTaskSearchItem {
  userTaskKey?: string | number;
  elementId?: string;
  processInstanceKey?: string | number;
  state?: string;
}

/** One discovered open escalation user task, normalised for projection. */
interface OpenUserTask {
  userTaskKey: string;
  elementId: string;
  processInstanceKey: string;
}

/** Engine-first sweep (issue #358): read EVERY open (`CREATED`) native user task from the engine over
 * the raw Camunda-8 `/v2/user-tasks/search` surface (the same raw-REST search surface
 * `pollIncidents`/`pollJobActivation`/`pollWaveGates` use) and keep those whose `elementId` is a
 * surfaced escalation kind (`USER_TASK_KIND_LABELS`). This is the authoritative "what is open" set —
 * a task is discovered IFF the ENGINE reports it open, regardless of whether any tracked subject row
 * references its instance — so an escalation on an untracked/orphaned instance (the reported 19153
 * case) is surfaced too. Pages defensively so a large open set is never silently truncated to the
 * first page; best-effort transport (a failed page projects what was gathered and retries next pass).
 * Deduped by `userTaskKey` so a page overlap can't double-project one task. */
async function sweepOpenEscalationTasks(base: string, headers: Record<string, string>): Promise<OpenUserTask[]> {
  const out: OpenUserTask[] = [];
  const seen = new Set<string>();
  const limit = 100;
  let from = 0;
  for (let guard = 0; guard < 1000; guard++) {
    let items: UserTaskSearchItem[];
    try {
      const res = await fetch(`${base}/user-tasks/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { state: "CREATED" }, page: { from, limit } }),
      });
      if (!res.ok) break; // engine unhappy → project what we have, retry next pass
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = (await res.json()) as { items?: UserTaskSearchItem[] };
      items = body.items ?? [];
    } catch (err) {
      console.error(`[poller] user-task sweep: ${err}`);
      break;
    }
    for (const it of items) {
      // Re-filter state defensively in case the wire filter is ignored — only OPEN (`CREATED`) tasks are
      // answerable, so a lagging COMPLETED/CANCELED read must never surface a dead affordance (#294).
      if (typeof it.state === "string" && it.state.toUpperCase() !== "CREATED") continue;
      const elementId = typeof it.elementId === "string" ? it.elementId : undefined;
      if (!elementId || userTaskKindLabel(elementId) === undefined) continue;
      const userTaskKey = it.userTaskKey == null ? "" : String(it.userTaskKey);
      if (!userTaskKey || seen.has(userTaskKey)) continue;
      seen.add(userTaskKey);
      out.push({ userTaskKey, elementId, processInstanceKey: it.processInstanceKey == null ? "" : String(it.processInstanceKey) });
    }
    if (items.length < limit) break; // last page
    from += items.length;
  }
  return out;
}

/** Reconcile the unified Tasks-inbox read-model (`user_tasks`) against the engine's currently-open
 * native user-task escalations (issues #236, #358). The Tasks page lists EVERY open escalation awaiting
 * a human decision — the feature kinds (`feature-escalation` / `feature-blocked`), the epic/PR kinds
 * (`plan-review-decision`, `trial-merge-decision`, `wait-answer` / `wait-merge-answer`), and the
 * conformance ack (`conformance-escalation`) — that otherwise had no app-side pointer, so the pages
 * could not drive their completion.
 *
 * The source of truth for WHICH escalations are open is the ENGINE, not the tracked subject set (#358):
 *   • When the raw-REST surface is available (`engineRest`, always supplied in production), an
 *     engine-first sweep (`sweepOpenEscalationTasks`) lists every open escalation the engine reports —
 *     tracked OR orphaned — so a task on an untracked/orphaned instance (the reported 19153 case) is
 *     surfaced and answerable, not stranded invisible.
 *   • Subject rows only ENRICH (they never gate): `subjectByInstance` maps the task's
 *     `processInstanceKey` to its feature/plan/PR/conformance subject for `subject_title` / `subject_url`
 *     / `question`. A task whose instance no subject row references falls back to a stable non-blank
 *     subject (the instance key) and a null question, so it still renders.
 *
 * Without `engineRest` (unit tests / a degraded no-REST host) it falls back to the typed-seam
 * per-active-subject scan: the `openUserTasks` seam carries no `processInstanceKey`, so a task can only
 * be reached THROUGH a tracked subject whose instance key we already hold — hence that path is
 * tracked-only. Both paths feed the SAME `project`/`contextFor` enrichment derivation, so a tracked task
 * projects identically however it was discovered; only DISCOVERY differs by capability (no duplicate
 * enrichment). `reconcileUserTasks` then diffs the desired open set against the persisted rows so a
 * completed task's row is deleted (answered here, via the task inbox, or out-of-band) and `showCount`
 * reflects live pending work. Best-effort + idempotent — per-instance failures are isolated so one bad
 * instance never stalls the pass. */
/** Poll pass (ADR 0005 slice S5): reconcile each RUNNING delivery-graph run's derived phase from
 * engine truth, and complete it when its instance ends. A delivery graph is a DYNAMIC compiled
 * process with no happy-path host worker, so — unlike `plans`/`feature_runs`, whose spine workers
 * write their own terminal row — this pass owns both the parked-node projection AND the COMPLETED→done
 * transition (instanceTracking's `onTerminated` edge reconciles only TERMINATED, never COMPLETED, so
 * a graph that ends normally would otherwise stay `running` forever). Generalises the `epic_phase`
 * derived-phase machinery to a graph whose element ids aren't known ahead of time: the parked-node
 * label is derived from the run row's stamped `human_labels` + the instance's OPEN user tasks. Scoped
 * to `running` rows (an `awaiting-approval` run has no instance yet), so it stays O(in-flight). */
export async function pollDeliveryGraphPhase(
  data: DataLayer,
  engine: Pick<EngineClient, "searchProcessInstances" | "searchUserTasks">,
) {
  for (const run of await deliveryGraphRuns(data).find({ status: "running" })) {
    if (!run.process_key) continue;
    const processKey = run.process_key;
    try {
      const [snapshots, tasks] = await Promise.all([
        engine.searchProcessInstances({ processInstanceKeys: [processKey] }),
        engine.searchUserTasks({ processInstanceKey: processKey, state: "CREATED" }),
      ]);
      const state = snapshots.find((s) => String(s.processInstanceKey) === processKey)?.state ?? null;
      const projection = deriveDeliveryPhase(state, tasks, parseHumanLabels(run.human_labels));
      if (run.status !== projection.status || run.phase !== projection.phase || run.phase_node_id !== projection.phase_node_id) {
        await deliveryGraphRuns(data).update(run.run_key, {
          status: projection.status,
          phase: projection.phase,
          phase_node_id: projection.phase_node_id,
          updated_at: now(),
        });
      }
    } catch (err) {
      console.error(`[poller] delivery graph ${run.run_key}: ${err}`);
    }
  }
}

export async function pollUserTasks(
  data: DataLayer,
  engine: EngineClient,
  engineRest?: { restAddress: string; token?: string },
) {
  const at = now();

  // ── Enrichment: subject descriptors keyed by the ENGINE process-instance the task parks on ────────
  // Built from EVERY subject row (regardless of status), so a task on a subject whose row already went
  // terminal is still enriched from it. `activeConformanceReviews` carries the retro instance + audit
  // summary for the `conformance-escalation` ack (its instance is tracked on `plan_conformance`, not a
  // delivery aggregate).
  interface Subject {
    type: "feature" | "plan" | "pr" | "delivery";
    key: string;
    title?: string | null;
    url?: string | null;
    deliveryLabel?: string | null;
    conformanceSummary?: string | null;
  }
  const subjectByInstance = new Map<string, Subject>();
  for (const run of await featureRuns(data).all()) {
    if (run.process_key) {
      subjectByInstance.set(run.process_key, { type: "feature", key: run.feature_key, title: run.title, url: run.issue_url, deliveryLabel: run.delivery_label });
    }
  }
  for (const plan of await plans(data).all()) {
    if (plan.process_key) subjectByInstance.set(plan.process_key, { type: "plan", key: plan.plan_key, title: plan.title, url: plan.issue_url });
  }
  for (const pr of await prs(data).all()) {
    if (pr.process_key) subjectByInstance.set(pr.process_key, { type: "pr", key: pr.pr_key, title: pr.title, url: pr.url });
  }
  for (const review of await activeConformanceReviews(data)) {
    if (!review.process_key) continue;
    const plan = await plans(data).get(review.plan_key);
    subjectByInstance.set(review.process_key, { type: "plan", key: review.plan_key, title: plan?.title ?? null, url: plan?.issue_url ?? null, conformanceSummary: review.summary });
  }
  // A delivery-graph `human` node parks on its run's engine instance; enrich from the run row so the
  // Tasks inbox shows the graph's title (its `run_key` as the stable subject key), mirroring the
  // feature/plan/pr enrichment. The row's inlined `delivery-human-task__<node>` id is recognised by
  // the shared `userTaskKindLabel` predicate, and buckets as `delivery` (below).
  for (const run of await deliveryGraphRuns(data).all()) {
    if (run.process_key) subjectByInstance.set(run.process_key, { type: "delivery", key: run.run_key, title: run.title, url: null });
  }

  // Per-element subject type for an ORPHANED task (no subject row) — the kind implies its aggregate even
  // when tracking is lost, so the fallback row still buckets correctly on the page.
  const DEFAULT_SUBJECT_TYPE: Readonly<Record<string, "feature" | "plan" | "pr">> = {
    [FEATURE_ESCALATION_ELEMENT]: "feature",
    [FEATURE_BLOCKED_ELEMENT]: "feature",
    [PLAN_REVIEW_ELEMENT]: "plan",
    [TRIAL_MERGE_ELEMENT]: "plan",
    [CONFORMANCE_ESCALATION_ELEMENT]: "plan",
    [PR_WAIT_ANSWER_ELEMENT]: "pr",
    [PR_WAIT_MERGE_ANSWER_ELEMENT]: "pr",
  };

  // The SINGLE enrichment derivation both discovery paths feed: resolve one open escalation task (by
  // element + the instance it parks on) into its desired-row context, enriching from its subject row
  // when the instance is tracked or a per-kind fallback when it is orphaned. Returns `null` for a
  // non-escalation element (the leak guard) so an arbitrary internal user task can never reach the inbox.
  const contextFor = async (elementId: string, userTaskKey: string, processInstanceKey: string): Promise<UserTaskContext | null> => {
    if (userTaskKindLabel(elementId) === undefined) return null;
    const subj = subjectByInstance.get(processInstanceKey);
    // Orphaned-task fallback: the kind implies its aggregate even when no subject row references the
    // instance. A delivery-human node's id is inlined (`delivery-human-task__<node>`), so its bucket is
    // derived from the predicate rather than the static per-element table.
    const subjectType = subj?.type ?? DEFAULT_SUBJECT_TYPE[elementId] ?? (isDeliveryHumanElement(elementId) ? "delivery" : "plan");
    const subjectKey = subj?.key ?? processInstanceKey;
    let question: string | null = null;
    switch (elementId) {
      case FEATURE_ESCALATION_ELEMENT:
        // The escalate arm writes the synthesised question to `feature_escalations` keyed by the subject
        // (a standalone slice's `feature_key`, or the epic's `plan_key` for a plan-embedded slice, which
        // has no standalone `feature_runs` row) — the same key `subjectKey` resolves to for either subject.
        question = latestFeatureEscalationQuestion(await featureEscalations(data).find({ feature_key: subjectKey }));
        break;
      case FEATURE_BLOCKED_ELEMENT:
        question = subj?.deliveryLabel ?? null;
        break;
      case PLAN_REVIEW_ELEMENT:
        question = latestPlanReviewFindings(await planReviews(data).find({ plan_key: subjectKey }));
        break;
      case TRIAL_MERGE_ELEMENT:
        question = latestTrialMergeQuestion(await trialMergeAudits(data, subjectKey));
        break;
      case PR_WAIT_ANSWER_ELEMENT:
      case PR_WAIT_MERGE_ANSWER_ELEMENT:
        question = latestOpenEscalationQuestion(await prEscalations(data).find({ pr_key: subjectKey, status: "open" }));
        break;
      case CONFORMANCE_ESCALATION_ELEMENT:
        question = conformanceEscalationQuestion(subj ? { summary: subj.conformanceSummary } : undefined);
        break;
    }
    return { userTaskKey, elementId, subjectType, subjectKey, subjectTitle: subj?.title ?? null, subjectUrl: subj?.url ?? null, question, processKey: processInstanceKey };
  };

  // Desired set, deduped by completable key (a task is open at most once; guard a page overlap / a
  // subject seen under two statuses mid-pass).
  const desiredByKey = new Map<string, UserTaskRow>();
  const project = async (elementId: string | undefined, userTaskKey: string, processInstanceKey: string) => {
    if (!elementId) return;
    const rowKey = userTaskKey.trim();
    if (!rowKey || desiredByKey.has(rowKey)) return;
    const ctx = await contextFor(elementId, userTaskKey, processInstanceKey);
    if (!ctx) return;
    const row = buildUserTaskRow(ctx, at);
    if (row) desiredByKey.set(rowKey, row);
  };

  if (engineRest) {
    const base = engineRest.restAddress.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (engineRest.token) headers.authorization = `Bearer ${engineRest.token}`;
    for (const t of await sweepOpenEscalationTasks(base, headers)) {
      await project(t.elementId, t.userTaskKey, t.processInstanceKey);
    }
  } else {
    // Reduced-capability fallback (no raw-REST surface): typed-seam per-active-subject scan, tracked-only.
    const seen = new Set<string>();
    const scanInstance = async (processKey: string | null | undefined) => {
      if (!processKey || seen.has(processKey)) return;
      seen.add(processKey);
      let tasks: { userTaskKey: string; elementId?: string }[];
      try {
        tasks = await engine.openUserTasks({ processInstanceKey: processKey });
      } catch (err) {
        console.error(`[poller] user tasks (${processKey}): ${err}`);
        return;
      }
      for (const t of tasks) await project(t.elementId, t.userTaskKey, processKey);
    };
    for (const status of FEATURE_ACTIVE_STATUSES) for (const run of await featureRuns(data).find({ status })) await scanInstance(run.process_key);
    for (const status of PLAN_ACTIVE_STATUSES) for (const plan of await plans(data).find({ status })) await scanInstance(plan.process_key);
    for (const status of PR_ACTIVE_STATUSES) for (const pr of await prs(data).find({ status })) await scanInstance(pr.process_key);
    for (const review of await activeConformanceReviews(data)) await scanInstance(review.process_key);
    // A delivery-graph `human` node parks on its RUNNING run's engine instance (an awaiting-approval run
    // has no instance yet — mirrors `pollDeliveryGraphPhase`). Scan it too so the inlined
    // `delivery-human-task__<node>` gate surfaces on this reduced-capability path exactly as it does on
    // the engine-first sweep — otherwise the typed-seam host silently drops every delivery human gate.
    for (const run of await deliveryGraphRuns(data).find({ status: "running" })) await scanInstance(run.process_key);
  }

  const desired = [...desiredByKey.values()];
  const persisted = await userTasks(data).all();
  const { inserts, updates, deletes } = reconcileUserTasks(persisted, desired);
  for (const row of inserts) await userTasks(data).insert(row);
  for (const row of updates) {
    const { user_task_key, created_at, ...patch } = row;
    await userTasks(data).update(user_task_key, { ...patch, updated_at: at });
  }
  for (const key of deletes) await userTasks(data).delete(key);
}

/** One full poll pass: advance the review stage, the merge stage, the wave-merge barrier, and
 * (when the engine REST endpoint is supplied) the job-activation visibility pass and the
 * technical-incident surfacing pass. Called on the self-scheduling loop in `main.ts`.
 *
 * The wave-merge barrier is now level-triggered and probes the engine's message-subscription state
 * over the same raw-REST search surface, so it runs only when `engineRest` is supplied (as in
 * production — `main.ts` always passes it). */
export async function pollOnce(
  data: DataLayer,
  engine: EngineClient,
  token: string,
  engineRest?: { restAddress: string; token?: string },
) {
  await pollReviews(data, engine, token);
  await pollMerges(data, engine, token);
  await pollWaitGate(data);
  await pollPromotion(data, engine, token);
  await pollFeatureDelivery(data);
  await pollLineage(data);
  await pollUserTasks(data, engine, engineRest);
  await pollDeliveryGraphPhase(data, engine);
  if (engineRest) {
    const base = engineRest.restAddress.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (engineRest.token) headers.authorization = `Bearer ${engineRest.token}`;
    await pollWaveGatesImpl(data, engine, token, base, headers);
    await pollCapabilityGatesImpl(data, engine, base, headers);
    await pollJobActivation(data, engineRest.restAddress, engineRest.token);
    await pollIncidents(data, engineRest.restAddress, engineRest.token);
  }
}
