// pr.landed-probe — the merge-queue landing timer fired (issue #933). Before escalating "did not
// land", re-read ground truth: the queue may have landed the PR after the poller's last `queued`
// pass but before (or exactly as) the `landedWaitTimeout` timer won the `eg-landed` race — e.g. a
// slow Mergify batch that merges right around the timeout, or a poller pass that errored/stalled
// on this PR. Escalating a landed PR forces a pointless human "retry", so the timeout arm routes
// through this probe and `gw-landed-probe` instead of straight to `merge-esc-landed`:
//   • landed  → mark-merged (never escalate a landed PR)
//   • evicted → arm-merge (re-run the mergeable gate, same as a `merge-evicted` message)
//   • waiting → merge-esc-landed (genuinely never landed — the #556 backstop)
// The verdict is derived by the poller's own canonical classifier (`queuedVerdict`) so the probe
// and the poll pass can never drift. An unreadable PR reads as `waiting` (escalate — conservative).
import type { AppJobHandler } from "@nanobpm/urban";
import { fetchPrState } from "../../app/github.ts";
import { queuedVerdict } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

type In = WorkerInputs["pr.landed-probe"];

interface Out extends Record<string, unknown> {
  landedVerdict: "landed" | "evicted" | "waiting";
}

export async function probeLanded(
  repo: string,
  prNumber: number | string,
  token: string,
  fetch: typeof fetchPrState = fetchPrState,
): Promise<Out["landedVerdict"]> {
  const st = await fetch(repo, prNumber, token, { withMergeQueue: true }).catch(() => null);
  if (st === null) return "waiting";
  // A PR closed WITHOUT merging can never land; re-arm so the merge poller abandons it.
  if (!st.merged && st.state === "closed") return "evicted";
  return queuedVerdict(st);
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const { repo, prNumber, prKey } = job.variables;
  const landedVerdict = await probeLanded(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
  app.log.info("landed-probe: landing timeout fired — re-read PR state", { prKey, landedVerdict });
  return { landedVerdict };
};

export default handler;
