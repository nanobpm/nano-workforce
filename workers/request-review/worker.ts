// pr.request-review — the merge loop requests a HEAD-CURRENT Copilot review itself (issue #939).
//
// Reached when `pr.merge`'s backstop finds no head-current review (`mergeStatus: "review-pending"`):
// the loop's own rebase / merge-from-base / fix push moved the head, so the last review is stale.
// The only remedy is mechanical — request a review and wait — so the loop does it instead of
// escalating to a human. The model then waits on a bounded timer (`reviewRequestWait`) and re-arms
// the merge poller; `pr.merge` re-runs the backstop on the new head. Only after `reviewRequestMax`
// requests with no review (or when Copilot cannot be requested at all) does it escalate.
//
// "Silently ignored" requests: Copilot can stay listed as a pending reviewer yet never review, and a
// second POST is then a no-op. On a re-request (round > 0) with Copilot still pending, withdraw the
// request first and re-add it — the equivalent that re-triggers the review.
import type { AppJobHandler } from "@nanobpm/urban";
import { hasPendingCopilotReviewer, removeCopilotReviewer, requestCopilotReview } from "../../app/github.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RequestReviewIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.request-review"];

interface Out extends Record<string, unknown> {
  /** `requested` — a request is in flight; `unavailable` — Copilot is not an assignable reviewer on
   * this repo (waiting is pointless → escalate); `failed` — no usable transport / transport error
   * (the bounded wait still re-checks, so a transient failure is retried by the budget). */
  reviewRequest: "requested" | "unavailable" | "failed";
}

export interface ReviewRequestOps {
  hasPending: (repo: string, prNumber: number) => Promise<boolean | null>;
  remove: (repo: string, prNumber: number) => Promise<unknown>;
  request: (repo: string, prNumber: number) => Promise<"requested" | "unavailable" | null>;
}

const token = () => process.env.GITHUB_TOKEN ?? "";
const defaultOps: ReviewRequestOps = {
  hasPending: (repo, n) => hasPendingCopilotReviewer(repo, n, token()),
  remove: (repo, n) => removeCopilotReviewer(repo, n, token()),
  request: (repo, n) => requestCopilotReview(repo, n, token()),
};

export function makeHandler(ops: ReviewRequestOps): AppJobHandler<In, Out> {
  return async (job, app) => {
    const { prKey, repo, prNumber, reviewRequestRound } = job.variables;
    const round = typeof reviewRequestRound === "number" ? reviewRequestRound : 0;
    let result: Out["reviewRequest"];
    try {
      // A re-request whose previous ask is still pending was silently ignored → withdraw, re-add.
      if (round > 0 && (await ops.hasPending(repo, prNumber)) === true) {
        await ops.remove(repo, prNumber);
      }
      const res = await ops.request(repo, prNumber);
      result = res === "requested" ? "requested" : res === "unavailable" ? "unavailable" : "failed";
    } catch (err) {
      app.log.warn(`request-review: ${prKey} Copilot review request failed: ${err}`);
      result = "failed";
    }
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "review-requested",
      method: "review-request",
      detail: `head-current Copilot review request #${round + 1}: ${result}`,
      at: new Date().toISOString(),
    });
    return { reviewRequest: result };
  };
}

const handler = makeHandler(defaultOps);
export default handler;
