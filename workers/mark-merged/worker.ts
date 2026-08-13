// pr.mark-merged — the PR has landed (directly or via the merge queue). Record the terminal
// `merged` state; the merge audit trail is written by pr.merge, so this only closes the row out.
import type { AppJobHandler } from "@nanobpm/urban";
import { maybeStartRetro } from "../../app/retro.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`MarkMergedIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.mark-merged"];

const handler: AppJobHandler<In> = async (job, app) => {
  const now = new Date().toISOString();
  await app.data.table("pull_requests", "pr_key").update(job.variables.prKey, {
    status: "merged",
    merged_at: now,
    updated_at: now,
  });

  // If this PR was the last of its epic to land, kick off the retrospective. Best-effort: a
  // failure here (or no epic) must never fail marking the PR merged — the retro is advisory.
  await maybeStartRetro(app.data, app.engine, job.variables.prKey, app.log);

  return {};
};

export default handler;
