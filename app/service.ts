// nano-workforce — the app's business logic over the Urban runtime seams (ADR 0055).
//
// The action handlers (`actions/*.ts`) and the review-ready poller (`main.ts`) both call
// these functions. Actions receive `app.data` (the typed datasource gateway) and
// `app.engine` (the transport-agnostic engine client) from the injected `AppApi`; the
// poller passes the same `DataLayer` + `EngineClient` obtained from `main.ts`.
//
// Data access goes through the record-oriented gateway (`data.table<T>(name, pk)` — the RAD
// `Table<T>` surface), not hand-written SQL. Row shapes are declared inline here.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import {
  classifyMergeability,
  ensureFreshHeadRun,
  fetchPrMeta,
  fetchPrReviews,
  fetchPrState,
  hasPendingCopilotReviewer,
  type MergeMethod,
  requestCopilotReview,
} from "./github.ts";
import { planTaskDeps, planTasks, plans } from "./plan.ts";
import { abandonUrl, mintAbandonToken, renderAbandonBrief } from "./abandon.ts";
import { freshHeadRunAction, loadMergeProtocol } from "./mergeProtocol.ts";
import { clampNudgeMinutes, reviewWaitTimeout } from "./reviewWait.ts";
import { waveMergeTargets } from "./waves.ts";
import { mergeLanes, readExclusions } from "./mergeExclusion.ts";
import { planPrLane, type PrLaneDecision, taskDependencyDepths } from "./mergeTrain.ts";

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

// The `senior:pr-review` agent prompt is no longer read by the host: it is authored in the
// model as a `{{review-round}}` deploy-time template (see `models.templates` in nano.app.json)
// substituted into the task's `io.nanobpm.agentTask.task.prompt` header. The host only carries
// runtime PR identity + the round counter now.

const now = () => new Date().toISOString();

/** A PR is "done" in exactly these states; everything else (converging, waiting_review,
 * escalated, and the merge-stage waiting_deps/waiting_merge/waiting_lane/queued) is in flight. `converged`
 * is terminal only in review-only mode (AUTO_MERGE off); with auto-merge on, a converged PR
 * transitions into the merge stage and lands as `merged`. The status endpoint and the cancel
 * guard both key off this set. */
export const TERMINAL_STATUSES: readonly string[] = ["converged", "merged", "abandoned"];

interface PullRequest {
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
  open_escalation_id: number | null;
  open_escalation_question: string | null;
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
  // running agent curls (GET /hooks/abandon?token=…) to learn whether this run was cancelled before
  // it performs a side effect. Minted at submit, reused across the convergence + merge instances.
  abandon_token: string | null;
  // Technical-incident surfacing (017_pr_incident.sql, issue #94), written by the poller's
  // `pollIncidents` pass. `incident_key` is the engine incidentKey of the ACTIVE incident parking
  // this PR's instance and `incident_message` its errorMessage; both NULL when the instance has no
  // active incident. Orthogonal to `status` — an incident is a cross-cutting liveness fault, not a
  // workflow stage.
  incident_key: string | null;
  incident_message: string | null;
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
export function parsePr(input: string): ParsedPr | null {
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

/** Register a PR row (if new) and start the convergence process. Idempotent on prKey. Optional
 * `dependsOn` (explicit refs) is unioned with any `Depends-on:` line parsed from the PR body and
 * recorded as the PR's merge-stage dependency set. */
export async function submitPr(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedPr,
  dependsOn: string[] = [],
  maxRounds: number = MAX_ROUNDS,
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
  const depKeys = new Set(dependsOn.map((d) => parsePr(d)?.prKey).filter((k): k is string => !!k));
  try {
    const meta = await fetchPrMeta(parsed.repo, parsed.number, token);
    if (meta) {
      title = meta.title;
      for (const k of parseDependsOn(meta.body)) depKeys.add(k);
    }
  } catch (err) {
    console.warn(`[submit] ${parsed.prKey} meta fetch: ${err}`);
  }
  await registerDependencies(data, parsed.prKey, [...depKeys]);

  const ts = now();
  // Cooperative abandon check (#76): reuse the PR's existing capability token across re-runs (and
  // the later merge instance), or mint one for a first submission.
  const abandonToken = existing?.abandon_token ?? mintAbandonToken();
  if (existing) {
    // A prior run (cancelled, converged, or otherwise superseded) may have left an OPEN
    // escalation row plus the denormalised pointer on the PR. A fresh convergence run must not
    // inherit that stale answer form — the "(no question provided)" bleed-through on resubmit
    // (Magikcraft/nano-bpm #597/#599). Mark any still-open escalations `stale` and clear the
    // pointer below, mirroring the plan re-plan cleanup (issue #25 in plan.ts).
    for (const e of await escs(data).find({ pr_key: parsed.prKey, status: "open" })) {
      await escs(data).update(e.id, { status: "stale" });
    }
    // Re-open a previously converged/abandoned/merged PR for a fresh convergence run.
    await table.update(parsed.prKey, {
      status: "converging",
      current_round: 1,
      url: parsed.url,
      title: title ?? existing.title,
      waiting_since: null,
      last_review_id: null,
      last_nudge_at: null,
      outcome: null,
      converged_at: null,
      merged_at: null,
      // Drop any denormalised open-escalation pointer from the prior run so the answer form
      // does not resurface a dead/stale question on the re-opened PR.
      open_escalation_id: null,
      open_escalation_question: null,
      abandon_token: abandonToken,
      updated_at: ts,
    });
  } else {
    await table.insert({
      pr_key: parsed.prKey,
      repo: parsed.repo,
      number: parsed.number,
      url: parsed.url,
      title,
      status: "converging",
      current_round: 1,
      abandon_token: abandonToken,
      created_at: ts,
      updated_at: ts,
    });
  }
  const abUrl = abandonUrl(abandonToken);
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
      // Cooperative abandon check (#76): the capability URL + the abort brief appended to the
      // review-round agent's prompt, so it can stop before pushing if the run is cancelled.
      abandonUrl: abUrl,
      abandonBrief: renderAbandonBrief(abUrl),
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
  const abUrl = abandonUrl(abandonToken);
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
      abandonUrl: abUrl,
      abandonBrief: renderAbandonBrief(abUrl),
    },
  });
  if (processInstanceKey != null) {
    await prs(data).update(pr.prKey, { process_key: String(processInstanceKey), updated_at: now() });
  }
  return { prKey: pr.prKey, mergeProcessKey: processInstanceKey };
}

/** Answer an open escalation → record it and resume the process. */
export async function answerEscalation(
  data: DataLayer,
  engine: EngineClient,
  prKey: string,
  answer: string,
) {
  const open = (await escs(data).find({ pr_key: prKey, status: "open" })).sort((a, b) => b.id - a.id)[0];
  if (!open) return { ok: false, reason: "no open escalation" };
  const ts = now();
  await escs(data).update(open.id, { answer, status: "answered", answered_at: ts });
  await prs(data).update(prKey, {
    status: "converging",
    updated_at: ts,
    open_escalation_id: null,
    open_escalation_question: null,
  });
  await engine.publishMessage({
    name: "escalation-answered",
    correlationKey: prKey,
    variables: { answer, escalationId: open.id },
  });
  return { ok: true, escalationId: open.id };
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
 * without reading the datasource directly. */
export async function activePrs(data: DataLayer): Promise<ActivePr[]> {
  const all = await prs(data).all();
  return all
    .filter((p) => !TERMINAL_STATUSES.includes(p.status))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .map((p) => ({
      prKey: p.pr_key,
      repo: p.repo,
      number: p.number,
      url: p.url,
      title: p.title ?? null,
      status: p.status,
      round: p.current_round,
      processKey: p.process_key ?? null,
      waitingSince: p.waiting_since ?? null,
      openEscalation: p.open_escalation_question ?? null,
      updatedAt: p.updated_at,
      activeWorker: p.active_worker ?? null,
      leaseUntil: p.lease_until ?? null,
    }));
}

/** One review-ready poll pass (SPEC §10): for every PR waiting on a review, fetch its GitHub
 * reviews (via the host `gh` CLI or a token — see `app/github.ts`) and, on a fresh one,
 * correlate a `review-ready` message to resume the loop. */
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
        name: "review-ready",
        correlationKey: prKey,
        variables: { reviewId: fresh.id, reviewState: fresh.state, submittedAt: fresh.submitted_at },
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
  const st = await fetchPrState(parsed.repo, parsed.number, token);
  return st?.merged ?? false;
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

/** Merge-stage poll pass (SPEC §11). Four durable waits, each keyed off the PR's `status`, are
 * advanced by correlating a message — mirroring the review-ready pattern so the process owns
 * the wait and this glue only signals when a GitHub condition is met:
 *   • waiting_deps  → every declared dependency has merged        → `deps-cleared`
 *   • waiting_merge → GitHub settled the PR as mergeable/blocked  → `merge-ready` {mergeState}
 *   • waiting_lane  → predecessor in same exclusion lane merged    → re-arm `waiting_merge`
 *   • queued        → the queued PR has landed on GitHub          → `merge-landed`
 * On publish we flip status to the transient `merging` (which no branch scans) so a slow pass
 * can't double-signal, exactly as `pollReviews` flips to `converging`; `flipToMergingThenPublish`
 * reverts the flip if the publish fails so a failed handoff can't wedge the PR. */
async function pollMerges(data: DataLayer, engine: EngineClient, token: string) {
  // 1) Dependencies merged?
  for (const pr of await prs(data).find({ status: "waiting_deps" })) {
    const prKey = pr.pr_key;
    try {
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
      if (st.merged) {
        // Landed out-of-band (someone merged it) — skip straight to done.
        await flipToMergingThenPublish(data, engine, prKey, "waiting_merge", {
          name: "merge-landed",
          correlationKey: prKey,
          variables: {},
        });
        console.log(`[poller] already merged -> ${prKey}`);
        continue;
      }
      const verdict = classifyMergeability(st);
      if (verdict === "waiting") {
        // Frugal-CI remedy (#43): when the repo publishes a merge protocol that wants a fresh
        // head run and the PR has NO head run at all, review has converged but the last push
        // produced no CI run — so branch protection's required checks read as "expected" forever
        // and this PR would wait indefinitely. Produce a fresh `pull_request` run once per head
        // (mark ready / close+reopen); rebases change `headRefOid`, so downstream merge-train PRs
        // get a new nudge after every post-rebase landing attempt.
        const protocol = await loadMergeProtocol(repo, token).catch(() => null);
        if (protocol) {
          const action = freshHeadRunAction(protocol, verdict, st.totalChecks, st.isDraft, {
            headRefOid: st.headRefOid,
            lastActionHeadRefOid: pr.fresh_head_run_head,
          });
          if (action) {
            const ok = await ensureFreshHeadRun(repo, number, action).catch(() => false);
            if (ok && st.headRefOid) {
              await prs(data).update(prKey, { fresh_head_run_head: st.headRefOid, updated_at: now() });
            }
            console.log(`[poller] fresh head run (${action}) ${ok ? "requested" : "skipped"} -> ${prKey}`);
          }
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
      const lane = await mergeLaneDecisionForPr(data, prKey);
      if (lane?.isHeld) continue;
      await prs(data).update(prKey, { status: "waiting_merge", updated_at: now() });
      await mirrorTaskStatusForPr(data, prKey, "opened");
      console.log(`[poller] merge lane released -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] lane ${prKey}: ${err}`);
    }
  }

  // 4) Queued PR landed?
  for (const pr of await prs(data).find({ status: "queued" })) {
    const { repo, number, pr_key: prKey } = pr;
    try {
      const st = await fetchPrState(repo, number, token);
      if (st === null) continue; // no transport → skip this PR (others may still advance)
      if (!st.merged) continue; // still in the queue
      await flipToMergingThenPublish(data, engine, prKey, "queued", {
        name: "merge-landed",
        correlationKey: prKey,
        variables: {},
      });
      console.log(`[poller] queued PR landed -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] queued ${prKey}: ${err}`);
    }
  }
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

/** Wave-merge barrier poll pass. After `record-wave` hands off a wave that has a successor, the
 * plan-fanout instance parks at the `wait-wave-merged` catch event and `plans.gate_wave` records
 * that wave's index. Here we check whether every OPENED PR in that wave has MERGED and, if so,
 * publish `wave-merged` (correlated on the plan key) to release the next wave's implementation.
 *
 * `gate_wave` is cleared single-shot BEFORE publishing (and restored if the publish fails —
 * mirroring `flipToMergingThenPublish`) so a slow pass can't double-signal and a later wave's
 * barrier can't be tripped by a stale message reusing the same plan-key correlation. A wave whose
 * tasks all ended `blocked`/`skipped` (no opened PR to wait on) clears vacuously — there is
 * nothing to merge, and that failure has already cascaded to dependents in `select-wave`. */
async function pollWaveGates(data: DataLayer, engine: EngineClient, token: string) {
  for (const plan of await plans(data).all()) {
    const gateWave = plan.gate_wave;
    if (gateWave == null) continue;
    const planKey = plan.plan_key;
    try {
      let allMerged = true;
      const tasks = await planTasks(data).find({ plan_key: planKey });
      for (const prKey of waveMergeTargets(tasks, gateWave)) {
        if (!(await isDepMerged(data, prKey, token))) {
          allMerged = false;
          break;
        }
      }
      if (!allMerged) continue;
      await plans(data).update(planKey, { gate_wave: null, updated_at: now() });
      try {
        await engine.publishMessage({ name: "wave-merged", correlationKey: planKey, variables: {} });
      } catch (err) {
        try {
          await plans(data).update(planKey, { gate_wave: gateWave, updated_at: now() });
        } catch (revertErr) {
          console.error(`[poller] revert wave-gate ${planKey} -> ${gateWave} failed: ${revertErr}`);
        }
        throw err;
      }
      console.log(`[poller] wave ${gateWave} merged -> ${planKey}`);
    } catch (err) {
      console.error(`[poller] wave-gate ${planKey}: ${err}`);
    }
  }
}

/** One full poll pass: advance the review stage, the merge stage, the wave-merge barrier, and
 * (when the engine REST endpoint is supplied) the job-activation visibility pass and the
 * technical-incident surfacing pass. Called on the self-scheduling loop in `main.ts`. */
export async function pollOnce(
  data: DataLayer,
  engine: EngineClient,
  token: string,
  engineRest?: { restAddress: string; token?: string },
) {
  await pollReviews(data, engine, token);
  await pollMerges(data, engine, token);
  await pollWaveGates(data, engine, token);
  if (engineRest) {
    await pollJobActivation(data, engineRest.restAddress, engineRest.token);
    await pollIncidents(data, engineRest.restAddress, engineRest.token);
  }
}
