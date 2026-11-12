// pr.merge-stall-probe — the mergeable-wait timer fired: the in-process poller never published
// `merge-ready` within `mergeableWaitTimeout` (it died across a redeploy, errored on this PR, or
// skipped the verdict), so the instance would otherwise sit wedged at `waiting_merge` forever with
// no timeout and no escalation (issue #636). This is the bounded-wait backstop: re-derive
// ground-truth mergeability directly from GitHub — reusing the poller's own classifier
// (`classifyMergeability` over a fresh `fetchPrState`, protocol-aware via `loadMergeProtocol`) — and
// emit `mergeState` so the *existing* `gw-mergeable` routes the token to the correct arm:
//   • ready    → attempt-merge
//   • conflict → rebase arm
//   • blocked  → CI-fix arm
//   • waiting (GitHub still computing) → bounded re-poll (`wait-mergeable-repoll`), NOT a terminal
//     escalation (#774); it only escalates once the shared `mergeStallMax` budget is exhausted
//   • draft → not-landable escalation
//   • unclassified/default → auto-rebase (`gw-rebase`, the `gw-mergeable` default arm)
// The timer only guarantees the remediation machinery is ENTERED when the poller is dead; every
// downstream arm is the same one the live poller feeds. A bounded `mergeStallRounds` counter
// (incremented by this task's output mapping, capped by `mergeStallMax`) stops the probe from
// re-arming forever: once exhausted, `gw-merge-stall` routes to human escalation instead.
import type { AppJobHandler } from "@nanobpm/urban";
import { isBehindBaseUpdatePending } from "../../app/behindBaseRemedy.ts";
import { classifyMergeability, classifyPrLiveness, fetchPrState, type PrState } from "../../app/github.ts";
import { loadMergeProtocol, type MergeProtocol } from "../../app/mergeProtocol.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`MergeStallProbeIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.merge-stall-probe"];

interface Out extends Record<string, unknown> {
  // Mirrors the poller's `merge-ready {mergeState}` payload so the existing `gw-mergeable` FEEL
  // routes it. `waiting` (GitHub still computing / no verdict) is surfaced verbatim; `gw-mergeable`
  // routes it to a bounded re-poll (`wait-mergeable-repoll`, #774) — re-probing until the verdict
  // settles or the shared `mergeStallMax` budget is exhausted, at which point it escalates to a
  // human. This backstops a dead poller without wedging a PR GitHub is merely slow to settle.
  mergeState: string;
  failingChecks: number;
  failingChecksList: string;
  // The unresolved-review-thread count behind a `review-threads` verdict (issue #921), mirrored
  // into the escalation question so a human sees exactly what blocks the merge. `-1` = unprobed.
  reviewThreads: number;
  // The pending-check count (PR #922 review): zero failing checks does not mean checks are green —
  // a queued/running check leaves the BLOCKED cause undetermined, so the stall-escalation question
  // gates its "required review approval" wording on this being 0 too (never claims a verified
  // blocker off a half-settled rollup).
  pendingChecks: number;
}

/** Injectable GitHub readers (tests stub them); the default export binds the real ones. */
export interface StallProbeDeps {
  readState: (repo: string, prNumber: number, token: string) => Promise<PrState | null>;
  readProtocol: (repo: string, token: string) => Promise<MergeProtocol | null>;
  /** Issue #951 review: is an accepted (async) update-branch still holding this head? While it is,
   * the old head's stale check failures must NOT classify as `blocked` (which would start fix-ci /
   * escalate) — the branch update is in flight and will move the head. Bounded by the remedy's own
   * window, so a never-applied update stops holding. */
  isUpdatePending: (repo: string, prNumber: number, headOid: string) => boolean;
}

const realDeps: StallProbeDeps = {
  readState: (repo, prNumber, token) => fetchPrState(repo, prNumber, token, { withReviewThreads: true }),
  readProtocol: (repo, token) => loadMergeProtocol(repo, token),
  isUpdatePending: (repo, prNumber, headOid) => isBehindBaseUpdatePending(repo, prNumber, headOid),
};

export function makeHandler(deps: StallProbeDeps): AppJobHandler<In, Out> {
  return async (job, app) => {
  const { repo, prNumber } = job.variables;
  const token = process.env.GITHUB_TOKEN ?? "";

  // Re-derive ground truth exactly as the poller does (service.ts block 2). Load the repo's merge
  // protocol so the protocol-aware backstop (#392) gates a red DECLARED-required check even when
  // GitHub reports UNSTABLE. Any transport hiccup is treated as "still waiting" — never a spurious
  // ready/conflict verdict — so a bad read is surfaced as `waiting`, which `gw-mergeable` routes to
  // a bounded re-poll (#774) rather than misrouting the token to a wrong remediation arm; a
  // genuinely stuck verdict still escalates once the `mergeStallMax` budget is exhausted. The read
  // opts into the review-threads probe (`withReviewThreads`) so a `BLOCKED` merge state is
  // classified by its real cause (issue #921) — unresolved review threads surface as the
  // `review-threads` verdict and route to their own arm instead of re-polling until the budget
  // exhausts into the misleading "mergeability never settled" escalation.
  const st = await deps.readState(repo, prNumber, token).catch(() => null);
  if (st === null) {
    return { mergeState: "waiting", failingChecks: 0, failingChecksList: "", reviewThreads: -1, pendingChecks: 0 };
  }
  // Issue #951: re-read PR liveness BEFORE any verdict. A PR that already MERGED (e.g. a human
  // queued it while the loop waited) or was CLOSED must never reach an escalation: surface `ready`,
  // which `gw-merge-stall` always routes (even past the stall budget) to `attempt-merge`, whose
  // already-merged / closed short-circuits finish the loop as merged / abandoned.
  const liveness = classifyPrLiveness(st);
  if (liveness === "merged" || liveness === "closed") {
    app.log.info("merge-stall-probe: PR already terminal — routing to attempt-merge short-circuit", {
      prKey: job.variables.prKey,
      liveness,
    });
    return { mergeState: "ready", failingChecks: 0, failingChecksList: "", reviewThreads: 0, pendingChecks: 0 };
  }
  const protocol = await deps.readProtocol(repo, token).catch(() => null);
  let mergeState = classifyMergeability(st, protocol ?? undefined);

  // Issue #951 review: a `blocked` verdict on the OLD head while an accepted update-branch is still
  // pending is a stale-read, not a real block — the poller's behind-base remedy is holding that head
  // (no fix-ci on its stale failures) until GitHub applies the update and the head moves. Mirroring
  // that hold here, the probe downgrades the verdict to `waiting` so `gw-mergeable` routes to the
  // bounded re-poll (`wait-mergeable-repoll`) instead of dispatching fix-ci / escalating against a
  // head that is about to change. The hold shares the remedy's bounded window, so a never-applied
  // update stops holding and the next probe judges the (still-red) head afresh.
  // `updatePending` is surfaced so `gw-merge-stall` keeps re-polling inside the remedy's bounded hold
  // window even once `mergeStallMax` is spent (an ordinary `waiting` still respects the stall cap).
  let updatePending = false;
  if (mergeState === "blocked" && st.headRefOid && deps.isUpdatePending(repo, prNumber, st.headRefOid)) {
    updatePending = true;
    app.log.info("merge-stall-probe: behind-base update pending — deferring remediation until the head moves", {
      prKey: job.variables.prKey,
      head: st.headRefOid,
    });
    mergeState = "waiting";
  }

  app.log.info("merge-stall-probe: poller stalled — re-derived mergeability", {
    prKey: job.variables.prKey,
    mergeState,
    mergeStateStatus: st.mergeStateStatus,
  });

  return {
    mergeState,
    updatePending,
    // Carried for the CI-fix arm (mergeState "blocked" = a failed required check), mirroring the
    // poller's `merge-ready` payload so fix-ci knows which gates to green.
    failingChecks: st.failingChecks,
    failingChecksList: st.failingCheckNames.join("\n"),
    reviewThreads: st.unresolvedThreads,
    pendingChecks: st.pendingCheckNames.length,
  };
  };
}

const handler: AppJobHandler<In, Out> = makeHandler(realDeps);

export default handler;
