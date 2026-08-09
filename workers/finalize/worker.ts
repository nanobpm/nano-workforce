// pr.finalize — the PR has converged. Record the final round and either (a) hand off to the
// merge stage (start the `merge-loop` process and park the PR in `waiting_deps`) when auto-merge
// is on, or (b) close the PR out as `converged` (review-only mode).
import type { AppJobHandler } from "@nanobpm/urban";
import { AUTO_MERGE, ensurePr, startMerge } from "../../app/service.ts";
import { maybeStartRetro } from "../../app/retro.ts";

// Extends Record so the declared fields are typed while the job may still carry
// other process variables (e.g. io.nanobpm.agentResult, read by transcriptOf).
interface In extends Record<string, unknown> {
  prKey: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  round: number;
  summary?: string;
}

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler<In> = async (job, app) => {
  // `summary` is left undefined when absent so the write boundary omits it: the
  // nullable `rounds.summary` stays NULL and `pull_requests.outcome` is untouched
  // rather than being coerced to "".
  const { prKey, repo, prNumber, prUrl, round, summary } = job.variables;
  const now = new Date().toISOString();

  // Heal a missing FK parent (engine/app.db desync) before the child `rounds` insert.
  await ensurePr(app.data, { prKey, repo, number: prNumber, url: prUrl, round });

  await app.data.table("rounds", "id").insert({
    pr_key: prKey,
    round_no: round,
    status: "converged",
    summary,
    transcript: transcriptOf(job.variables),
    started_at: now,
    ended_at: now,
  });

  // In auto-merge mode, start the separate merge-loop instance (keyed on prKey) that lands the
  // PR *before* advancing the row into the merge stage. Best-effort: a failure here must not fail
  // the convergence finalize. But we only flip the PR into the non-terminal `waiting_deps` status
  // once merge-loop is actually running — otherwise the PR would be parked in a merge-stage status
  // with no process behind it, and `submitPr` refuses to restart it (only `cancel` recovers). On
  // failure we leave the PR terminal as `converged` so a human/operator can (re)start merge.
  let status = "converged";
  if (AUTO_MERGE) {
    try {
      const { mergeProcessKey } = await startMerge(app.data, app.engine, {
        repo,
        number: prNumber,
        url: prUrl,
        prKey,
        round,
      });
      // `startMerge` can resolve without throwing yet with a null key (mirroring the engine's
      // nullable `processInstanceKey`). Only park the PR in the merge-stage `waiting_deps` status
      // when merge-loop is actually running — otherwise leave it terminal as `converged` so a
      // human/operator can (re)start merge rather than stranding it with no process behind it.
      if (mergeProcessKey != null) {
        status = "waiting_deps";
      } else {
        app.log("error", `finalize: merge-loop start returned no process key for ${prKey}; leaving PR converged`);
      }
    } catch (err) {
      app.log("error", `finalize: could not start merge-loop for ${prKey}; leaving PR converged`, {
        err: String(err),
      });
    }
  }

  // Converged bookkeeping is recorded in both modes; `outcome`/`converged_at` capture the review
  // result. In auto-merge mode (when merge-loop started) the *status* moves into the merge stage
  // rather than resting at `converged`, so the merge poller starts watching immediately.
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status,
    current_round: round,
    outcome: summary,
    converged_at: now,
    updated_at: now,
    open_escalation_id: null,
    open_escalation_question: null,
  });

  // Only the review-only terminal path ends the PR here as `converged` — in auto-merge mode the
  // terminal point is pr.mark-merged (which triggers the retro), and a PR parked in `waiting_deps`
  // is still in flight. So fire the retro trigger only when this PR actually reached its terminal
  // state in finalize. Best-effort: must never fail the finalize job.
  if (status === "converged") {
    await maybeStartRetro(app.data, app.engine, prKey, app.log);
  }

  return {};
};

export default handler;
