// pr.finalize — the PR has converged. Record the final round and either (a) hand off to the
// merge stage (start the `merge-loop` process and park the PR in `waiting_deps`) when auto-merge
// is on, or (b) close the PR out as `converged` (review-only mode).
import type { AppJobHandler } from "@nanobpm/urban";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
import { withMergePolicyLock } from "../../app/mergePolicyLock.ts";
import { maybeStartRetro } from "../../app/retro.ts";
import { AUTO_MERGE, ensurePr, startMerge } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`PrFinalizeIn` in convergence-loop.bpmn) — ADR 0040.
// Framework-injected `io.nanobpm.agentResult` is read through the `Record`-typed `transcriptOf`.
type In = WorkerInputs["pr.finalize"];

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler<In> = async (job, app) => {
  // `summary` is left undefined when absent so the write boundary omits it: the
  // nullable `rounds.summary` stays NULL and `pull_requests.outcome` is untouched
  // rather than being coerced to "".
  const { prKey, repo, prNumber, prUrl, round, summary, abandonUrl, convergeOnly, autoMerge } = job.variables;
  const now = new Date().toISOString();

  // Heal a missing FK parent (engine/app.db desync) before the child `rounds` insert.
  await ensurePr(app.data, {
    prKey,
    repo,
    number: prNumber,
    url: prUrl,
    round,
    abandonToken: abandonTokenFromUrl(abandonUrl),
  });

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
  //
  // Merge intent (issue #916, hardened in #1007 review round 3): the DURABLE `merge_requested`
  // projection `submitPr` stamps (and adoption narrows) is the authoritative opt-out — an
  // adoption narrowing that lands while a review/fix agent is live is reverted in the PROCESS
  // VARIABLES when that agent's completion restores its guard snapshots
  // (convergence-loop.bpmn's `guardAutoMerge`/`guardConvergeOnly` outputs), but the projection
  // compare-and-set survives, so reading it here can never un-do an operator's explicit
  // review-only pin. The process variables (`autoMerge` canonical, `convergeOnly` legacy inverse)
  // remain the fallback for a legacy row written before the projection existed
  // (`merge_requested` NULL) — mirroring `mergePolicyFromRow`'s serve path.
  // The policy read and the merge handoff run under the SAME owner-keyed `withMergePolicyLock`
  // adoption's review-only narrowing uses (issue #1007 review, round 6): otherwise finalization could
  // read `merge_requested = 1`, pause inside `startMerge`'s GitHub lookup while adoption stamps `0`,
  // and then hand off (re-stamping `1`), undoing the explicit opt-out. Under the lock the two are
  // totally ordered: either adoption narrows first (we re-read `0` here and stay review-only) or the
  // handoff lands first (adoption's compare-and-set then sees the re-pointed owner / converged row).
  const readPolicyRow = async () =>
    // biome-ignore lint/plugin: runtime/framework contract boundary for the data-layer row shape
    (await app.data.table("pull_requests", "pr_key").get(prKey)) as
      | { merge_requested?: number | null; process_key?: string | null }
      | undefined;
  const ownerKey = (await readPolicyRow())?.process_key ?? null;
  const handoff = async (): Promise<string> => {
    const prRow = await readPolicyRow();
    const mergeRequested =
      prRow?.merge_requested != null
        ? prRow.merge_requested === 1
        : autoMerge === true || (autoMerge == null && convergeOnly !== true);
    if (!(AUTO_MERGE && mergeRequested)) return "converged";
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
      if (mergeProcessKey != null) return "waiting_deps";
      app.log.error(`finalize: merge-loop start returned no process key for ${prKey}; leaving PR converged`);
    } catch (err) {
      app.log.error(`finalize: could not start merge-loop for ${prKey}; leaving PR converged`, {
        err: String(err),
      });
    }
    return "converged";
  };
  const status = ownerKey != null ? await withMergePolicyLock(ownerKey, handoff) : await handoff();

  // Converged bookkeeping is recorded in both modes; `outcome`/`converged_at` capture the review
  // result. In auto-merge mode (when merge-loop started) the *status* moves into the merge stage
  // rather than resting at `converged`, so the merge poller starts watching immediately.
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status,
    current_round: round,
    outcome: summary,
    converged_at: now,
    updated_at: now,
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
