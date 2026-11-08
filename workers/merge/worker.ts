// pr.merge — attempt to land the PR (SPEC §11). Returns `mergeStatus`:
//   • merged  — landed now (direct merge)            → process marks it merged
//   • queued  — added to the repo's merge queue       → process waits for `merge-landed`
//   • retry   — transient base/head-moved race        → process re-attempts on the settled base
//               via the bounded retry gate (no human, no remediation agent)
//   • blocked — GitHub refused (conflict / failing gate / perms) → escalate to a human, who
//               resolves it and replies to retry (the process re-arms and re-polls).
// HOW it lands is governed by the target repo's published merge protocol (#43): a `mergify-queue`
// repo (e.g. nanobpm/nano-bpm, auto-merge OFF) is landed by posting `@mergifyio queue` and
// waiting for the queue, NOT a direct `gh pr merge` — which that repo refuses. The actual gh/API
// calls live in app/github.ts; this worker records the attempt in the `merges` audit table and
// shapes the escalation payload on a block.
//
// MERGE-LOOP BACKSTOP (issue #923 §3): the convergence gate's verdict is only as fresh as the head
// it reviewed — a head that MOVED between convergence and landing, or a review that never existed
// (the #1443 fail-open), must not slip through at land time. Before running ANY land protocol this
// worker re-checks that a HEAD-CURRENT Copilot review exists; a missing/stale review blocks the
// landing (escalating to a human) instead of enqueueing/merging unreviewed code. The check fails
// OPEN only when the GitHub state is UNREADABLE (no transport / a hiccup) — the merge-stage
// mergeability polling is the independent backstop there, and a hard block on a transient read
// would wedge every merge on a network blip.
import type { AppJobHandler } from "@nanobpm/urban";
import { matchTags, tag } from "@nanobpm/urban/effect";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
import { checkBaseTarget, classifyBaseGuard } from "../../app/baseGuard.ts";
import { type HeadReader, makeDefaultReadHead } from "../../app/currentHead.ts";
import {
  classifyPrLiveness,
  enqueueViaComment,
  fetchBranchHead,
  fetchLatestCopilotReview,
  fetchPrHead,
  fetchPrState,
  mergePr,
  parseReviewOpenFindings,
} from "../../app/github.ts";
import { classifyMergeLanding, DEFAULT_MERGE_PROTOCOL, loadMergeProtocol } from "../../app/mergeProtocol.ts";
import { isReviewMissingOrStale } from "../../app/reviewWait.ts";
import { abandonClosedPr, ensurePr, MERGE_ADMIN, MERGE_METHOD } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`MergeAttemptIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.merge"];

interface Out extends Record<string, unknown> {
  mergeStatus: "merged" | "queued" | "blocked" | "retry" | "abandoned";
  status?: string;
  question?: string;
}

// The backstop's review reader — the SAME shape the converge-gate binds (`{ body, commitId }`,
// `null` = unverifiable). Injectable so tests drive the missing/stale/head-current matrix without
// a transport.
export type MergeReviewReader = (repo: string, prNumber: number) => Promise<{ body: string; commitId: string | null } | null>;

const defaultReadReview: MergeReviewReader = (repo, prNumber) =>
  fetchLatestCopilotReview(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
// The SAME branch-ref-over-stale-`head.sha` reader the converge-gate / progress-check / poller
// bind (#786/#799), so the backstop's staleness comparison sees the exact head the gate did.
const defaultReadHead: HeadReader = makeDefaultReadHead({ fetchPrHead, fetchBranchHead });

const BLOCK_NO_HEAD_CURRENT_REVIEW =
  "no head-current Copilot review exists for the PR's current HEAD (the head moved after the last review, or no review was ever submitted). A head-current reviewer verdict is required before landing";

/** Build the handler with injectable GitHub readers. The default export binds the real readers;
 * tests inject stubs for the backstop matrix. */
export function makeHandler(deps: { readReview: MergeReviewReader; readHeadSha: HeadReader }): AppJobHandler<In, Out> {
  const { readReview, readHeadSha } = deps;
  const handler: AppJobHandler<In, Out> = async (job, app) => {
  const { prKey, repo, prNumber, round, abandonUrl } = job.variables;
  const token = process.env.GITHUB_TOKEN ?? "";
  const now = new Date().toISOString();

  // Heal a missing FK parent (engine/app.db desync) before any child `merges` insert below so a
  // land attempt never dies with an opaque `FOREIGN KEY constraint failed` incident. The merge-loop
  // instance carries repo+prNumber (and the converged round) but not prUrl; ensurePr derives the
  // canonical URL from them, keeps the healed round faithful, and preserves the agent's abandon
  // token so its cooperative-abort check keeps resolving.
  await ensurePr(app.data, {
    prKey,
    repo,
    number: prNumber,
    round,
    abandonToken: abandonTokenFromUrl(abandonUrl),
  });

  // Idempotent already-merged short-circuit. When the poller routes an out-of-band-merged PR back
  // through `attempt-merge` (service.ts publishes `merge-ready` on the `waiting_merge` out-of-band
  // branch), the PR is already landed on GitHub. Re-running the land protocol would post a spurious
  // `@mergifyio queue` comment (mergify-queue repos) or a redundant merge call, so detect the merged
  // state first and complete the loop directly. Runs AFTER ensurePr so the `merges` audit row has its
  // FK parent, and BEFORE the base-guard/protocol logic. Best-effort: a transport hiccup falls through
  // to the normal path rather than blocking a genuine merge.
  const pre = await fetchPrState(repo, prNumber, token).catch(() => null);
  const liveness = classifyPrLiveness(pre);
  if (liveness === "merged") {
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "merged",
      method: "already-merged",
      detail: "PR was already merged on GitHub (landed out-of-band)",
      at: now,
    });
    return { mergeStatus: "merged" };
  }

  // Closed-not-merged short-circuit (#342). A PR CLOSED on GitHub without merging (e.g. superseded
  // by a newer PR) can never land: falling through to the land protocol would return
  // blocked/conflict and escalate a merge no human can complete, orphaning the process on a dead
  // PR (#350). Instead record a terminal `abandoned` audit row and drive the loop down its
  // terminate/abandon end event — NOT `merge-esc-conflict`. This opens NO escalation and parks NO
  // user task: a closed PR is terminal state, not a human decision. Symmetric with the merged
  // short-circuit above and runs on the same live-state read, so one `fetchPrState` classifies both.
  if (liveness === "closed") {
    // One canonical abandon writer (`abandonClosedPr`, app/service.ts) records the terminal `merges`
    // audit row and flips the `pull_requests` row — and every `plan_tasks` row keyed to this PR — to
    // `abandoned`. Flipping the task row (not just the PR row) drops a dead wave member out of the
    // wave-merge gate (#352). This branch drives the model's terminate/abandon end event, which runs
    // NO mark-merged worker, so the terminal write must happen here; `ensurePr` above guarantees the
    // PR row exists to update. Symmetric with the merged short-circuit on the same live-state read.
    await abandonClosedPr(
      app.data,
      prKey,
      "PR was closed on GitHub without merging (e.g. superseded) — abandoning the merge loop",
    );
    return { mergeStatus: "abandoned" };
  }

  // MERGE-LOOP BACKSTOP (issue #923 §3): refuse to land without a HEAD-CURRENT Copilot review. The
  // convergence gate's verdict is only as fresh as the head it reviewed — a head that MOVED between
  // convergence and landing (a fix-ci / rebase push, an out-of-band commit), or a review that never
  // existed at all (the nano-bpm#1443 fail-open: merged with ZERO reviews), must not slip through
  // at land time. Runs AFTER the merged/closed short-circuits (an already-terminal PR needs no
  // verdict) and BEFORE any land protocol (the `@mergifyio queue` comment is itself the landing
  // for a queue repo). Fails OPEN only when the GitHub state is UNREADABLE (no transport / a
  // hiccup → `null` review or head): a transient read failure must not wedge every merge — the
  // merge-stage mergeability polling is the independent backstop there.
  const [backstopReview, backstopHead] = await Promise.all([
    readReview(repo, prNumber).catch(() => null),
    readHeadSha(repo, prNumber).catch(() => null),
  ]);
  if (backstopReview !== null && isReviewMissingOrStale(backstopReview.commitId, backstopHead)) {
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "blocked",
      method: "review-backstop",
      detail: BLOCK_NO_HEAD_CURRENT_REVIEW,
      at: now,
    });
    return {
      mergeStatus: "blocked",
      status: "blocked",
      question:
        `Merge refused: ${BLOCK_NO_HEAD_CURRENT_REVIEW}. ` +
        `Push no further commits, wait for the Copilot review of the current HEAD to land (or request one: ` +
        `gh api repos/${repo}/pulls/${prNumber}/requested_reviewers -X POST -f "reviewers[]=copilot-pull-request-reviewer[bot]"), ` +
        `let the convergence loop gate on it, then reply to retry.`,
    };
  }

  // A head-current review whose OWN summary still reports open findings (the same canonical
  // verdict parser the converge-gate uses) must block too: a summary-only "Changes recommended"
  // review that landed after convergence has no unresolved thread for mergeability polling to see.
  const openFindings = backstopReview === null ? [] : parseReviewOpenFindings(backstopReview.body);
  if (openFindings.length > 0) {
    const detail = `the head-current Copilot review reports open findings (${openFindings.join(", ")})`;
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "blocked",
      method: "review-backstop",
      detail,
      at: now,
    });
    return {
      mergeStatus: "blocked",
      status: "blocked",
      question:
        `Merge refused: ${detail}. Address the review's findings on the branch (or reply with ` +
        `guidance on which to push back on), let the convergence loop gate on a clean review, then reply to retry.`,
    };
  }
  // The head the backstop verified — pinned through the land call so a push between this check
  // and the merge can never land a later, unreviewed head.
  const verifiedHead = backstopReview !== null && backstopHead ? backstopHead : undefined;

  // Dead-end-base guard (#60): never land a PR into a base branch that has itself already merged
  // to the default branch — the merge would land into a dead branch and never reach `main`.
  // GitHub only auto-retargets a PR when its base is *deleted* on merge; a merged-but-undeleted
  // base (typical in a stacked epic) stays the target and reads CLEAN, so nothing else catches it.
  // Best-effort: a transport hiccup leaves `deadEnd:false`, so this never blocks a valid merge.
  const guard = await checkBaseTarget(repo, prNumber, token).catch(() => null);
  if (guard && classifyBaseGuard(guard) === "decision-required") {
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "blocked",
      method: "base-guard",
      detail: `base '${guard.base}' has already merged into '${guard.defaultBranch}' (dead-end target)`,
      at: now,
    });
    return {
      mergeStatus: "blocked",
      status: "blocked",
      question:
        `This PR targets '${guard.base}', which has already merged into '${guard.defaultBranch}'. ` +
        `Merging now would land into a dead-end branch and never reach '${guard.defaultBranch}'. ` +
        `Retarget it (gh pr edit ${prNumber} --repo ${repo} --base ${guard.defaultBranch}), then reply to retry.`,
    };
  }

  // Load the repo protocol for every worker invocation. A retry after fix-ci/rebase is a fresh
  // landing attempt, so land-method decisions must not be latched across earlier heads.
  const protocol = await loadMergeProtocol(repo, token).catch(() => null);
  const method = protocol?.land.method ?? "gh-merge";

  let outcome: "merged" | "queued" | "blocked" | "retry";
  let detail: string;
  let auditMethod: string;

  if (method === "mergify-queue") {
    // Land via the repo's on-demand queue: post the enqueue comment; the poller's queued→landed
    // watch (service.ts block 3) then advances the process when the queue merges it.
    const comment = protocol?.land.comment ?? "@mergifyio queue";
    // A comment can't pin a SHA, so re-read the head right before enqueueing: if it moved past the
    // verified head, re-enter via the bounded retry (which re-runs the backstop on the new head).
    const headNow = verifiedHead ? await readHeadSha(repo, prNumber).catch(() => null) : null;
    if (verifiedHead && headNow !== null && headNow !== verifiedHead) {
      outcome = "retry";
      detail = `head moved from ${verifiedHead} to ${headNow} after the review backstop; re-verifying before enqueue`;
    } else {
      const ok = await enqueueViaComment(repo, prNumber, token, comment);
      outcome = ok ? "queued" : "blocked";
      detail = ok ? `enqueued via "${comment}"` : `failed to post enqueue comment "${comment}"`;
    }
    auditMethod = "queue-comment";
  } else if (classifyMergeLanding(protocol ?? DEFAULT_MERGE_PROTOCOL) === "decision-required") {
    // The repo requires a human to click Merge (`land.method=ui`); Merlin can't. This is the
    // only decision-required land method — escalate rather than pretend.
    outcome = "blocked";
    detail = "repo merge protocol requires a manual UI merge (land.method=ui)";
    auditMethod = "ui";
  } else {
    const admin = method === "admin" || MERGE_ADMIN;
    const res = await mergePr(repo, prNumber, token, { method: MERGE_METHOD, admin, expectedHeadSha: verifiedHead });
    // No usable transport → treat as a block so a human is asked to configure/merge, rather than
    // silently completing the process without landing the PR.
    outcome = res?.outcome ?? "blocked";
    detail = res?.detail ?? "no GitHub transport available (configure gh or GITHUB_TOKEN)";
    auditMethod = outcome === "queued" ? "queue" : MERGE_METHOD;
  }

  await app.data.table("merges", "id").insert({
    pr_key: prKey,
    outcome,
    method: auditMethod,
    detail,
    at: now,
  });

  // Exhaustive dispatch on the land outcome. Modelled as a tagged value so
  // `matchTags` forces a handler for every case — adding a new outcome to the
  // `"merged" | "queued" | "blocked" | "retry"` union becomes a compile error here rather
  // than silently falling through to the "blocked" branch.
  const docHint = protocol?.doc ? ` See the repo's merge protocol (${protocol.doc}).` : "";
  return await matchTags(tag(outcome, { detail }), {
    queued: async () => {
      await app.data.table("pull_requests", "pr_key").update(prKey, {
        status: "queued",
        updated_at: now,
      });
      return { mergeStatus: "queued" };
    },
    merged: async () => ({ mergeStatus: "merged" }),
    // retry → a transient base/head-moved race (GitHub told us to re-attempt). Re-enter the merge
    // loop on the settled base via the model's bounded retry gate — NO human escalation, NO
    // remediation agent. The gate caps the attempts so a continuously-moving base still escalates.
    retry: async () => ({ mergeStatus: "retry" }),
    // blocked → hand the escalation machinery a concrete question.
    blocked: async (o) => ({
      mergeStatus: "blocked",
      status: "blocked",
      question:
        `Automated merge was blocked: ${o.detail}. ` +
        `Resolve it on GitHub (rebase / fix a required check / grant merge rights), then reply to retry.${docHint}`,
    }),
  });
  };
  return handler;
}

const handler = makeHandler({ readReview: defaultReadReview, readHeadSha: defaultReadHead });
export default handler;
