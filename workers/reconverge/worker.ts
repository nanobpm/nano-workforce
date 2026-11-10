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
import { parsePr } from "../../app/prParse.ts";
import { MAX_ROUNDS, submitPr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`ReconvergeIn` in merge-loop.bpmn) — ADR 0040.
type In = WorkerInputs["pr.reconverge"];

export type Submit = typeof submitPr;

export function makeHandler(submit: Submit): AppJobHandler<In> {
  return async (job, app) => {
    const { prKey } = job.variables;
    const parsed = parsePr(prKey);
    if (!parsed) throw new Error(`reconverge: unparseable prKey ${JSON.stringify(prKey)}`);
    const row = await app.data.table("pull_requests", "pr_key").get(prKey);
    // biome-ignore lint/plugin: runtime/framework contract boundary for the untyped row shape
    const optIn = (row as { auto_resolve_escalations?: number } | undefined)?.auto_resolve_escalations === 1;
    await app.data.table("merges", "id").insert({
      pr_key: prKey,
      outcome: "reconverge",
      method: "review-backstop",
      detail: "head-current Copilot review reports open findings — re-entering convergence",
      at: new Date().toISOString(),
    });
    // The PR was already merging (merge intent on, any human approval already given), so the fresh
    // run keeps auto-merge and does not re-gate on approval.
    await submit(
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
    );
    return {};
  };
}

const handler = makeHandler(submitPr);
export default handler;
