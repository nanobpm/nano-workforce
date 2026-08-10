// pr.mark-merged — the PR has landed (directly or via the merge queue). Record the terminal
// `merged` state; the merge audit trail is written by pr.merge, so this only closes the row out.
import type { AppJobHandler } from "@nanobpm/urban";
import { maybeStartRetro } from "../../app/retro.ts";

interface In extends Record<string, unknown> {
  prKey: string;
}

const handler: AppJobHandler<In> = async (job, app) => {
  const now = new Date().toISOString();
  await app.data.table("pull_requests", "pr_key").update(job.variables.prKey, {
    status: "merged",
    merged_at: now,
    updated_at: now,
    open_escalation_id: null,
    open_escalation_question: null,
  });

  // If this PR was the last of its epic to land, kick off the retrospective. Best-effort: a
  // failure here (or no epic) must never fail marking the PR merged — the retro is advisory.
  await maybeStartRetro(app.data, app.engine, job.variables.prKey, app.log);

  return {};
};

export default handler;
