// pr.liveness-check — the convergence loop's PRE-DISPATCH PR-liveness gate (issue #1023).
//
// A convergence loop kept dispatching agent jobs (`senior:pr-review`, `senior:adversarial-review`)
// after its PR had been merged and its head branch deleted: the job could not provision (`git clone
// … Remote branch feat/… not found`), burned its retries and parked the instance on an incident. The
// only liveness read (#988) lived in `pr.progress-check`, AFTER the round's agent work — so every
// agent dispatch point (round entry from Start, a review-loop re-enter, a human-answer resume, a husk
// / ack retry, a revise, and the adversarial pass) could still fire against a finished PR.
//
// This task runs immediately BEFORE each agent dispatch and re-reads the PR's live state through the
// canonical `classifyPrLiveness`. A merged / closed PR publishes `prGone` = "merged" / "closed", which
// the gateway right after it routes to `EndPrGone` (the same terminal #988 uses) so the loop ends
// WITHOUT dispatching an agent for a branch that may no longer exist. The durable record mirrors the
// outcome exactly as progress-check does: merged → `status = merged`, closed → the canonical
// `abandonClosedPr` audit. An unreadable state fails OPEN (`prGone = ""`) — a transport hiccup must
// never end a live loop.
import type { AppApi, AppJobHandler } from "@nanobpm/urban";
import { classifyPrLiveness, fetchPrState, type PrState } from "../../app/github.ts";
import { abandonClosedPr, parsePr } from "../../app/service.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

type In = WorkerInputs["pr.liveness-check"];
type Out = WorkerOutputs["pr.liveness-check"];

export type PrStateReader = (repo: string, prNumber: number) => Promise<PrState | null>;

const defaultReadPrState: PrStateReader = (repo, prNumber) =>
  fetchPrState(repo, prNumber, process.env.GITHUB_TOKEN ?? "");

/** Mirror a terminal liveness verdict onto the PR row — fenced on instance ownership so a straggler
 * from a superseded run never clobbers a re-opened run's record. */
async function persistGone(
  app: AppApi,
  prKey: string,
  processInstanceKey: string | number | null | undefined,
  liveness: "merged" | "closed",
): Promise<void> {
  const prs = app.data.table<{ pr_key: string; process_key: string | null; status: string | null; updated_at: string | null }>(
    "pull_requests",
    "pr_key",
  );
  const row = await prs.get(prKey);
  const owner = row?.process_key ?? null;
  const jobOwner = processInstanceKey ?? null;
  if (owner !== null && jobOwner !== null && String(owner) !== String(jobOwner)) return;
  if (liveness === "merged") {
    if (row) await prs.update(prKey, { status: "merged", updated_at: new Date().toISOString() });
    return;
  }
  await abandonClosedPr(app.data, prKey, "PR closed without merging before an agent dispatch");
}

export function makeHandler(deps: { readPrState?: PrStateReader } = {}): AppJobHandler<In, Out> {
  return async (job, app) => {
    const { prKey, repo, prNumber } = job.variables;
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") return { prGone: "" };
    const state = await (deps.readPrState ?? defaultReadPrState)(ghRepo, ghNumber).catch(() => null);
    const liveness = classifyPrLiveness(state);
    if (liveness !== "merged" && liveness !== "closed") return { prGone: "" };
    app.log.info(`PR ${liveness} before agent dispatch — ending the convergence loop (#1023)`, { prKey });
    await persistGone(app, prKey, job.processInstanceKey, liveness).catch((err) => {
      app.log.warn?.(`liveness-check: persisting ${liveness} for ${prKey} failed: ${err}`);
    });
    return { prGone: liveness };
  };
}

const handler = makeHandler();
export default handler;
