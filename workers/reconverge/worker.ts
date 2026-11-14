// pr.reconverge — hand a PR back from the merge loop to the convergence loop (issue #939).
//
// Reached when `pr.merge`'s backstop finds a HEAD-CURRENT Copilot review whose own summary reports
// open findings (`mergeStatus: "review-findings"`) — typically the review the merge loop itself
// requested after a rebase / fix push. Actionable findings belong to the convergence path
// (fix → push → review), not to a human, so this re-submits the PR through the ONE canonical entry
// (`submitPr`), declaring this merge-loop instance as the hand-off source so the live row it owns is
// not misread as "already running". The merge loop then ends; the fresh convergence run starts a new
// merge loop on convergence, exactly as a first pass does. No parallel review loop is introduced.
//
// EXCEPTION (issue #959): if the PR has ALREADY MERGED out-of-band by the time the hand-off fires
// (a gate override / Mergify / a manual merge landed it), there is nothing to reconverge — the worker
// stamps the row `merged`, records the already-merged audit, kicks the retrospective, and ends the
// loop cleanly instead of restarting convergence against a deleted head branch.
import type { AppJobHandler } from "@nanobpm/urban";
import { classifyPrLiveness, fetchPrHead, fetchPrState } from "../../app/github.ts";
import { parsePr } from "../../app/prParse.ts";
import { maybeStartRetro } from "../../app/retro.ts";
import { abandonClosedPr, MAX_ROUNDS, submitPr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`ReconvergeIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.reconverge"];

export type Submit = typeof submitPr;
export type FetchPrHead = typeof fetchPrHead;
/** The PR-liveness reader used for the already-merged guard. Injectable so tests drive the
 * merged/closed/open matrix without a transport; the default binds the canonical `fetchPrState`. */
export type ReadLiveness = (repo: string, prNumber: number) => Promise<"open" | "merged" | "closed" | "unknown">;

const defaultReadLiveness: ReadLiveness = async (repo, prNumber) =>
  classifyPrLiveness(await fetchPrState(repo, prNumber, process.env.GITHUB_TOKEN ?? ""));

export function makeHandler(
  submit: Submit,
  fetchHead: FetchPrHead = fetchPrHead,
  readLiveness: ReadLiveness = defaultReadLiveness,
): AppJobHandler<In> {
  return async (job, app) => {
    const { prKey } = job.variables;
    const parsed = parsePr(prKey);
    if (!parsed) throw new Error(`reconverge: unparseable prKey ${JSON.stringify(prKey)}`);
    const row = await app.data.table("pull_requests", "pr_key").get(prKey);
    // biome-ignore lint/plugin: runtime/framework contract boundary for the untyped row shape
    const optIn = (row as { auto_resolve_escalations?: number } | undefined)?.auto_resolve_escalations === 1;
    // Operator steering (issue #956 review): re-supply the run's durable instruction text so the
    // merge→reconvergence handoff never starts an unsteered replacement loop (and never resets the
    // `custom_instructions` projection). Read the SAME `pull_requests` row the opt-in came from.
    // biome-ignore lint/plugin: runtime/framework contract boundary for the untyped row shape
    const rowInstructions = (row as { custom_instructions_text?: string | null } | undefined)?.custom_instructions_text;
    const customInstructions = typeof rowInstructions === "string" && rowInstructions.trim() !== "" ? rowInstructions : null;
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "reconverge",
      method: "review-backstop",
      detail: "head-current Copilot review reports open findings — re-entering convergence",
      at: new Date().toISOString(),
    });
    // Head-current restore (#941 round-4 review): the durable world checkpoint is written only by
    // the convergence loop's `pr.persist-round`, so a merge-stage rebase/fix-ci push — the very push
    // whose head-current review sent us here — advances the PR head WITHOUT updating the checkpoint.
    // Re-entering `submitPr` on the checkpoint would provision the fresh convergence agent at the
    // PRE-MERGE tree, risking stale fixes or a rejected (non-fast-forward) push. Read the LIVE head
    // SHA and pass it as the restore override so the hand-off resumes at the head the review saw.
    // Best-effort: an unreadable head degrades to `null` (no override → the checkpoint restore, the
    // pre-fix behaviour) rather than blocking the hand-off on a GitHub read.
    let headSha: string | null = null;
    try {
      headSha = (await fetchHead(parsed.repo, parsed.number, process.env.GITHUB_TOKEN ?? ""))?.headSha ?? null;
    } catch (err) {
      app.log.warn("reconverge: head read failed — falling back to the checkpoint restore", { prKey, err: String(err) });
    }
    // Already-merged guard (issue #959): a reconverge hand-off can fire AFTER the PR landed out-of-band
    // (a gate override / Mergify / a manual merge) — the very race that left nano-bpm#1579's loop dying
    // trying to clone a deleted head branch. Re-entering `submitPr` on a landed PR would restart a
    // redundant convergence loop against a deleted head. Detect the terminal merge first and end the
    // merge loop cleanly instead: stamp the row `merged` (so the merge-aware derivation reports
    // `merged`, not `abandoned`, when this instance then ends), record the already-merged audit row, and
    // kick the retrospective exactly as `pr.mark-merged` would. The merge loop then completes normally
    // at `MergeReconverged` — a COMPLETED instance is NOT the `onTerminated` edge, so the row stays
    // `merged`. Best-effort: an unreadable liveness (`unknown` / a throw) falls through to the normal
    // hand-off rather than blocking a genuine reconverge.
    const liveness = await readLiveness(parsed.repo, parsed.number).catch(() => "unknown" as const);
    if (liveness === "merged") {
      const ts = new Date().toISOString();
      await app.data.table("pull_requests", "pr_key").update(prKey, { status: "merged", merged_at: ts, updated_at: ts });
      await app.data.table("merges", "id").insert({
        pr_key: prKey,
        outcome: "merged",
        method: "already-merged",
        detail: "PR was already merged on GitHub (landed out-of-band) — ending the merge loop instead of reconverging",
        at: ts,
      });
      // The merged-completion side effect `pr.mark-merged` runs: an externally merged PR may be its
      // plan's last to settle, so its automatic retrospective must still start. Best-effort, never throws.
      await maybeStartRetro(app.data, app.engine, prKey);
      return {};
    }
    // A PR verified CLOSED without merging (it closed between the merge worker's findings and this
    // hand-off) has nothing to reconverge either: settle it terminal through the ONE canonical
    // `abandonClosedPr` (row + plan tasks + idempotent audit) and end the loop — never start a
    // replacement convergence run on a closed PR.
    if (liveness === "closed") {
      await abandonClosedPr(app.data, prKey, "PR was closed without merging before the reconverge hand-off");
      return {};
    }
    // The PR was already merging (merge intent on, any human approval already given), so the fresh
    // run keeps auto-merge and does not re-gate on approval.
    const result = await submit(
      app.data,
      app.engine,
      parsed,
      [],
      MAX_ROUNDS,
      false,
      null,
      false,
      optIn,
      true,
      job.processInstanceKey != null ? String(job.processInstanceKey) : null,
      headSha,
      customInstructions,
    );
    // `submitPr` can return `processKey: null` after rewriting the row to `converging` with no owner
    // (the create-instance failure window). Completing HERE would end the merge loop at
    // `MergeReconverged` with the PR left on a keyless `converging` row — no live convergence or
    // merge instance to advance it. Throw instead so the job fails and stays RETRYABLE: the retry
    // re-enters `submitPr`, which treats the keyless non-terminal row as resubmittable and re-enrolls
    // it (the #704/#497 phantom-row recovery path).
    if (result != null && typeof result === "object" && "processKey" in result && result.processKey == null) {
      throw new Error(`reconverge: submitPr returned a null processKey for ${prKey} — no convergence instance was started; failing so the hand-off is retried`);
    }
    return {};
  };
}

const handler = makeHandler(submitPr);
export default handler;
