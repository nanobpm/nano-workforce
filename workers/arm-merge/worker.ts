// pr.arm-merge — arm the merge poller: park the PR in `waiting_merge` so the next poll pass
// evaluates its mergeability and correlates `merge-ready`. Reached both on entry to the merge
// stage (after dependencies clear) and after a human answers a merge escalation (re-check).
import type { AppJobHandler } from "@nanobpm/urban";

interface In extends Record<string, unknown> {
  prKey: string;
}

const handler: AppJobHandler<In> = async (job, app) => {
  await app.data.table("pull_requests", "pr_key").update(job.variables.prKey, {
    status: "waiting_merge",
    updated_at: new Date().toISOString(),
  });
  return {};
};

export default handler;
