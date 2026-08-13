// POST /app/api/actions/promote/epic → operationId `promoteEpic` (ADR 0058/0059, base /app/api).
// The one-click, human-gated door that opens the integration→default-branch promotion PR for a
// completed epic (issue #160). It NEVER merges — it only opens the PR (or recovers an existing one)
// so a human can review and land the whole epic deliberately.
//
// The request body is FLAT (`{ planKey }`), not wrapped in a `variables` envelope — a purpose-built
// operation, mirroring startPlanFanout/postMessage. Guards, in order:
//   • missing/non-object body → 400
//   • unknown plan → 404
//   • already promoted (promotion_pr_url persisted) → 200 with the existing PR (idempotent, opens nothing)
//   • not `done` / no base_branch → 409 (not promotable)
//   • base_branch === repo default branch → 409 (nothing to promote — this is the per-operation
//     default-branch check the read-model `promote_ready` derivation deliberately skips)
//
// On a promotable plan it opens the PR (default branch ← base_branch), persists `promotion_pr_url`
// and clears `promote_ready` to 0 (the single read-model derivation lives in record-results; here we
// only turn the flag off because a promotion PR now exists — no second derivation site). GitHub's
// "a pull request already exists" (422) is treated as success: the open PR is recovered via
// `fetchOpenPrByHead`, persisted, and returned.

import type { AppApi } from "@nanobpm/urban";
import {
  type OpenPrResult,
  fetchDefaultBranch as realFetchDefaultBranch,
  fetchOpenPrByHead as realFetchOpenPrByHead,
  openPullRequest as realOpenPullRequest,
} from "../app/github.ts";
import { plans, planTasks } from "../app/plan.ts";
import { defineOperation } from "../nano-generated/operations.ts";

/** The GitHub seams the delegate depends on, injectable so the guard matrix can be unit-tested
 * without a live GitHub (mirrors how the host wires the real helpers). `token` is the transport
 * credential (env `GITHUB_TOKEN`) threaded through to each call. */
export interface PromoteEpicDeps {
  fetchDefaultBranch: (repo: string, token: string) => Promise<string | null>;
  openPullRequest: (
    repo: string,
    base: string,
    head: string,
    title: string,
    body: string,
    token: string,
  ) => Promise<OpenPrResult | null>;
  fetchOpenPrByHead: (
    repo: string,
    head: string,
    base: string,
    token: string,
  ) => Promise<{ url: string; number: number } | null>;
  token: string;
}

type PromoteResponse =
  | { status: 200 | 202; body: { planKey: string; url: string; number: number | null; promoted: boolean } }
  | { status: 400 | 404 | 409 | 502; body: { error: string } };

/** Build the promotion PR's title/body from the epic and its landed task PRs. */
function renderPr(
  issueUrl: string,
  baseBranch: string,
  defaultBranch: string,
  tasks: { pr_key: string | null; summary: string | null }[],
): { title: string; body: string } {
  const title = `Promote epic ${baseBranch} → ${defaultBranch}`;
  const landed = tasks
    .filter((t) => t.pr_key)
    .map((t) => `- ${t.pr_key}${t.summary ? ` — ${t.summary}` : ""}`);
  const body = [
    `Promotion PR for epic ${issueUrl}.`,
    "",
    `Opens the integration branch \`${baseBranch}\` for merge into the default branch \`${defaultBranch}\`.`,
    "This is the deliberate merge-to-default gate — nothing merges automatically.",
    "",
    landed.length ? "Landed task PRs:" : "No landed task PRs recorded.",
    ...landed,
  ].join("\n");
  return { title, body };
}

/** Core promote logic, seam-injected for testability. Returns a `{ status, body }` response. */
export async function runPromoteEpic(
  app: AppApi,
  planKey: string,
  deps: PromoteEpicDeps,
): Promise<PromoteResponse> {
  const table = plans(app.data);
  const plan = await table.get(planKey);
  if (!plan) {
    app.log.warn("promoteEpic rejected: unknown plan", { planKey });
    return { status: 404, body: { error: `no plan for planKey ${planKey}` } };
  }

  // Idempotent: a promotion PR is already recorded — return it, open nothing.
  if (plan.promotion_pr_url) {
    return { status: 200, body: { planKey, url: plan.promotion_pr_url, number: null, promoted: false } };
  }

  if (plan.status !== "done" || !plan.base_branch) {
    app.log.warn("promoteEpic rejected: plan not promotable", {
      planKey,
      status: plan.status,
      hasBase: Boolean(plan.base_branch),
    });
    return {
      status: 409,
      body: { error: "plan is not promotable — it must be done with a base_branch (integration branch) set" },
    };
  }

  const baseBranch = plan.base_branch;
  const defaultBranch = await deps.fetchDefaultBranch(plan.repo, deps.token);
  if (!defaultBranch) {
    return { status: 502, body: { error: "could not resolve the repository default branch (no GitHub transport)" } };
  }
  if (baseBranch === defaultBranch) {
    return {
      status: 409,
      body: { error: `nothing to promote — base (${baseBranch}) is already the default branch` },
    };
  }

  const tasks = await planTasks(app.data).find({ plan_key: planKey });
  const { title, body } = renderPr(plan.issue_url, baseBranch, defaultBranch, tasks);

  const result = await deps.openPullRequest(plan.repo, defaultBranch, baseBranch, title, body, deps.token);
  if (!result) {
    return { status: 502, body: { error: "no usable GitHub transport to open the promotion PR" } };
  }

  if (result.outcome === "invalid") {
    app.log.warn("promoteEpic rejected: GitHub refused base/head", { planKey, detail: result.detail });
    return { status: 409, body: { error: `GitHub refused the promotion PR base/head: ${result.detail}` } };
  }

  let url: string;
  let number: number | null;
  let promoted: boolean;
  if (result.outcome === "opened") {
    url = result.url;
    number = result.number;
    promoted = true;
  } else {
    // outcome === "exists": GitHub already has an open PR for this head→base — recover it.
    const existing = await deps.fetchOpenPrByHead(plan.repo, baseBranch, defaultBranch, deps.token);
    if (!existing) {
      return {
        status: 502,
        body: { error: `a promotion PR already exists but could not be recovered: ${result.detail}` },
      };
    }
    url = existing.url;
    number = existing.number;
    promoted = false;
  }

  await table.update(planKey, { promotion_pr_url: url, promote_ready: 0, updated_at: new Date().toISOString() });
  app.log.info("promoteEpic opened/recovered promotion PR", { planKey, url, number, promoted });
  return { status: promoted ? 202 : 200, body: { planKey, url, number, promoted } };
}

export default defineOperation("promoteEpic", async ({ body }, app) => {
  // The runtime validates a well-formed body, but a directly-invoked delegate (or a missing body)
  // leaves `body` undefined — guard so that becomes a 400, not a 500.
  if (!body || typeof body !== "object" || typeof body.planKey !== "string" || !body.planKey.trim()) {
    app.log.warn("promoteEpic rejected: missing/invalid planKey");
    return { status: 400, body: { error: "planKey is required (owner/repo#N)" } };
  }
  const planKey = body.planKey.trim();
  // A malformed key (not `owner/repo#N`) would otherwise fall through to a 404 "unknown plan",
  // which misrepresents a client error as a missing resource. Reject it as a 400 up front.
  if (!/^[^/\s]+\/[^#\s]+#\d+$/.test(planKey)) {
    app.log.warn("promoteEpic rejected: malformed planKey", { planKey });
    return { status: 400, body: { error: `malformed planKey (expected owner/repo#N): ${planKey}` } };
  }
  return runPromoteEpic(app, planKey, {
    fetchDefaultBranch: realFetchDefaultBranch,
    openPullRequest: realOpenPullRequest,
    fetchOpenPrByHead: realFetchOpenPrByHead,
    token: process.env.GITHUB_TOKEN ?? "",
  });
});
