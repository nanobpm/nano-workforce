// pr.reconverge — hand a PR back from the merge loop to the convergence loop (issue #939).
//
// Reached when `pr.merge`'s backstop finds a HEAD-CURRENT Copilot review whose own summary reports
// open findings (`mergeStatus: "review-findings"`) — typically the review the merge loop itself
// requested after a rebase / fix push. Actionable findings belong to the convergence path
// (fix → push → review), not to a human, so this re-submits the PR through the ONE canonical entry
// (`submitPr`), declaring this merge-loop instance as the hand-off source so the live row it owns is
// not misread as "already running". The merge loop then ends; the fresh convergence run starts a new
// merge loop on convergence, exactly as a first pass does. No parallel review loop is introduced.
import type { AppJobHandler } from "@nanobpm/urban";
import { fetchPrHead } from "../../app/github.ts";
import { parsePr } from "../../app/prParse.ts";
import { MAX_ROUNDS, submitPr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`ReconvergeIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.reconverge"];

export type Submit = typeof submitPr;
export type FetchPrHead = typeof fetchPrHead;

export function makeHandler(submit: Submit, fetchHead: FetchPrHead = fetchPrHead): AppJobHandler<In> {
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
