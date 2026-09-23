// pr.reconcile-implement — reconcile the implement-cell result from GitHub before escalating (issue #801).
//
// Runs on the shared `implement-cell`'s escalate arm (`ic_gw` "clean terminal?" → here), IMMEDIATELY
// before the human escalation, for EVERY caller that composes the cell: a standalone `feature` run and
// a plan-fanout wave slice. When the implement step returned no machine-readable `status` (a harness
// that opened a green PR but reported nothing — #796's implement-stage twin), it looks for an OPEN PR
// on the cell's deterministic `feat/<task.id>` branch and, when one exists, ADOPTS it — emitting
// `reconciled = true` (the `ic_reconcile_gw` gate routes straight to the cell's done end) plus
// `status = "opened"` and a `pr` key so the caller converges the adopted PR exactly as if the agent
// had reported it. Only when nothing is observable does it fall through (`reconciled = false`) to the
// human escalation as today.
//
// The decision + the injected GitHub read (`listPrsForHead`) live in the canonical, exhaustively
// tested `app/implementReconcile.ts` mirror — this handler is the thin engine seam. `taskId` is
// derived from the in-scope `task` process variable (`task.id`) — `implement-cell.bpmn` defines no
// `<zeebe:ioMapping>` input for this step; the engine populates `task` (and `subjectKey`, `status`,
// `pr`, `baseBranch`) from process scope. `pr` is passed through so the reconcile step's `pr` output
// never wipes a PR key the implement harness already set. `baseBranch` (the run's pinned base) is
// passed through so an open PR on the deterministic head branch is only adopted when it targets that
// base — never a stale/unrelated PR sharing the head branch but aimed at a different base.
import type { AppJobHandler } from "@nanobpm/urban";
import { listPrsForHead } from "../../app/github.ts";
import { type ReconcileImplementResult, reconcileImplement } from "../../app/implementReconcile.ts";

interface In extends Record<string, unknown> {
  subjectKey?: unknown;
  task?: unknown;
  status?: unknown;
  pr?: unknown;
  baseBranch?: unknown;
}

/** The cell's deterministic branch is `feat/<task.id>`; `task` is the implement-cell's slice object.
 *  Read it defensively (the process variable is untyped at the engine seam). */
function taskId(task: unknown): unknown {
  if (task !== null && typeof task === "object" && "id" in task) return task.id;
  return undefined;
}

const handler: AppJobHandler<In, ReconcileImplementResult> = async (job, app) => {
  const res = await reconcileImplement(
    {
      status: job.variables.status,
      subjectKey: job.variables.subjectKey,
      taskId: taskId(job.variables.task),
      pr: job.variables.pr,
      baseBranch: job.variables.baseBranch,
    },
    listPrsForHead,
    process.env.GITHUB_TOKEN ?? "",
  );
  app.log.info("reconcile-implement", {
    subjectKey: job.variables.subjectKey ?? null,
    reconciled: res.reconciled,
    pr: res.pr,
  });
  return res;
};

export default handler;
