// pr.arm-merge — arm the merge poller: park the PR in `waiting_merge` so the next poll pass
// evaluates its mergeability and correlates `merge-ready`. Reached both on entry to the merge
// stage (after dependencies clear) and after a human answers a merge escalation (re-check).
import type { AppJobHandler } from "@nanobpm/urban";
import { captureFrictionFromJob } from "../../app/friction.ts";
import { isReviewWaitOpen, REVIEW_WAIT_ENDED_OUTCOME } from "../../app/reviewWait.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`MergeArmIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.arm-merge"];

const handler: AppJobHandler<In> = async (job, app) => {
  // Issue #1101: capture the preceding agent's self-reported `friction` result notes (idempotent, best-effort).
  await captureFrictionFromJob(app.data, job);
  const now = new Date().toISOString();
  const prKey = job.variables.prKey;
  // Issue #1034: re-arming ends any open review wait. Close it in the audit trail so /status stops
  // deriving `waiting_review(<sha7>)` when the next poll writes no merge row (e.g. CI still pending).
  const merges = app.data.table("merges", "id");
  const rows = await merges.find({ pr_key: prKey });
  if (
    isReviewWaitOpen(rows.map((r) => ({ id: typeof r.id === "number" ? r.id : Number(r.id), outcome: String(r.outcome ?? "") })))
  ) {
    await merges.insert({
      pr_key: prKey,
      outcome: REVIEW_WAIT_ENDED_OUTCOME,
      method: "arm-merge",
      detail: "merge poller re-armed; review wait ended",
      at: now,
    });
  }
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "waiting_merge",
    updated_at: now,
  });
  return {};
};

export default handler;
