// pr.merge — attempt to land the PR (SPEC §11). Returns `mergeStatus`:
//   • merged  — landed now (direct merge)            → process marks it merged
//   • queued  — added to the repo's merge queue       → process waits for `merge-landed`
//   • retry   — transient base/head-moved race        → process re-attempts on the settled base
//               via the bounded retry gate (no human, no remediation agent)
//   • blocked — GitHub refused (conflict / failing gate / perms) → escalate to a human, who
//               resolves it and replies to retry (the process re-arms and re-polls).
// HOW it lands is governed by the target repo's published merge protocol (#43): a `mergify-queue`
// repo (e.g. Magikcraft/nano-bpm, auto-merge OFF) is landed by posting `@mergifyio queue` and
// waiting for the queue, NOT a direct `gh pr merge` — which that repo refuses. The actual gh/API
// calls live in app/github.ts; this worker records the attempt in the `merges` audit table and
// shapes the escalation payload on a block.
import type { AppJobHandler } from "@nanobpm/urban";
import { matchTags, tag } from "@nanobpm/urban/effect";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
import { checkBaseTarget, classifyBaseGuard } from "../../app/baseGuard.ts";
import { enqueueViaComment, fetchPrState, mergePr } from "../../app/github.ts";
import { classifyMergeLanding, DEFAULT_MERGE_PROTOCOL, loadMergeProtocol } from "../../app/mergeProtocol.ts";
import { ensurePr, MERGE_ADMIN, MERGE_METHOD } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`MergeAttemptIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.merge"];

interface Out extends Record<string, unknown> {
  mergeStatus: "merged" | "queued" | "blocked" | "retry";
  status?: string;
  question?: string;
}

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
  if (pre?.merged) {
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "merged",
      method: "already-merged",
      detail: "PR was already merged on GitHub (landed out-of-band)",
      at: now,
    });
    return { mergeStatus: "merged" };
  }

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
    const ok = await enqueueViaComment(repo, prNumber, token, comment);
    outcome = ok ? "queued" : "blocked";
    detail = ok ? `enqueued via "${comment}"` : `failed to post enqueue comment "${comment}"`;
    auditMethod = "queue-comment";
  } else if (classifyMergeLanding(protocol ?? DEFAULT_MERGE_PROTOCOL) === "decision-required") {
    // The repo requires a human to click Merge (`land.method=ui`); Merlin can't. This is the
    // only decision-required land method — escalate rather than pretend.
    outcome = "blocked";
    detail = "repo merge protocol requires a manual UI merge (land.method=ui)";
    auditMethod = "ui";
  } else {
    const admin = method === "admin" || MERGE_ADMIN;
    const res = await mergePr(repo, prNumber, token, { method: MERGE_METHOD, admin });
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

export default handler;
