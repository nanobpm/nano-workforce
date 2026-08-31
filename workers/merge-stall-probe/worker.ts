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
//   • draft / waiting (still computing) → not-landable escalation (gw-mergeable default)
// The timer only guarantees the remediation machinery is ENTERED when the poller is dead; every
// downstream arm is the same one the live poller feeds. A bounded `mergeStallRounds` counter
// (incremented by this task's output mapping, capped by `mergeStallMax`) stops the probe from
// re-arming forever: once exhausted, `gw-merge-stall` routes to human escalation instead.
import type { AppJobHandler } from "@nanobpm/urban";
import { classifyMergeability, fetchPrState } from "../../app/github.ts";
import { loadMergeProtocol } from "../../app/mergeProtocol.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`MergeStallProbeIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.merge-stall-probe"];

interface Out extends Record<string, unknown> {
  // Mirrors the poller's `merge-ready {mergeState}` payload so the existing `gw-mergeable` FEEL
  // routes it. `waiting` (GitHub still computing / no verdict) is surfaced verbatim; gw-mergeable
  // has no `waiting` arm, so it falls to the not-landable default and escalates — the correct
  // backstop when the poller is dead and 30 minutes on GitHub still cannot settle the PR.
  mergeState: string;
  failingChecks: number;
  failingChecksList: string;
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const { repo, prNumber } = job.variables;
  const token = process.env.GITHUB_TOKEN ?? "";

  // Re-derive ground truth exactly as the poller does (service.ts block 2). Load the repo's merge
  // protocol so the protocol-aware backstop (#392) gates a red DECLARED-required check even when
  // GitHub reports UNSTABLE. Any transport hiccup is treated as "still waiting" — never a spurious
  // ready/conflict verdict — so a bad read re-arms (bounded by mergeStallMax) rather than misrouting.
  const st = await fetchPrState(repo, prNumber, token).catch(() => null);
  if (st === null) {
    return { mergeState: "waiting", failingChecks: 0, failingChecksList: "" };
  }
  const protocol = await loadMergeProtocol(repo, token).catch(() => null);
  const mergeState = classifyMergeability(st, protocol ?? undefined);

  app.log.info("merge-stall-probe: poller stalled — re-derived mergeability", {
    prKey: job.variables.prKey,
    mergeState,
    mergeStateStatus: st.mergeStateStatus,
  });

  return {
    mergeState,
    // Carried for the CI-fix arm (mergeState "blocked" = a failed required check), mirroring the
    // poller's `merge-ready` payload so fix-ci knows which gates to green.
    failingChecks: st.failingChecks,
    failingChecksList: st.failingCheckNames.join("\n"),
  };
};

export default handler;
