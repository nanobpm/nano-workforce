// pr.progress-check — the deterministic no-progress guard for the convergence loop.
//
// After a round is recorded (pr.persist-round), this step reads the PR's current head SHA and
// compares it to the head observed at the previous recorded round. An `addressed` round whose head
// did NOT advance pushed no commit, so requesting another Copilot review would loop on
// byte-identical code — the same comments, round after round, until the round cap escalates. It
// returns `progressed:false`, and the model's `gw-progress` gateway escalates to the human
// `wait-answer` task instead of soliciting another review.
//
// Every other case returns `progressed:true` (continue): a `waiting` round (round 1, awaiting the
// first review) legitimately has no push; an advanced head means real work landed; and a head we
// could not read fails OPEN — the round cap and the review-wait timeout stay the safety nets so a
// transient GitHub hiccup can never fabricate a no-progress escalation. The routing decision lives
// in app/roundProgress.ts, the single source of truth this worker and `gw-progress` both mirror.
import type { AppJobHandler } from "@nanobpm/urban";
import { fetchPrHead } from "../../app/github.ts";
import { routeProgress } from "../../app/roundProgress.ts";
import { parsePr } from "../../app/service.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

// Input/output typed off the model data envelopes (`PrProgressCheckIn` / `PrProgressCheckOut` in
// convergence-loop.bpmn), the single source of truth for this worker's wire contract (ADR 0040).
type In = WorkerInputs["pr.progress-check"];
type Out = WorkerOutputs["pr.progress-check"];

// Reads a PR's current head SHA. Injectable so unit tests never touch git/network; the default
// binds the real GitHub reader (the shared gh | token transport) and swallows any failure to
// `null` so the guard fails OPEN.
export type HeadReader = (repo: string, prNumber: number) => Promise<string | null>;

const defaultReadHead: HeadReader = async (repo, prNumber) => {
  const token = process.env.GITHUB_TOKEN ?? "";
  const head = await fetchPrHead(repo, prNumber, token).catch(() => null);
  return head?.headSha ?? null;
};

/** Build the handler with an injectable head reader (see {@link HeadReader}). The default export
 * binds the real GitHub reader; tests inject a stub. */
export function makeHandler(deps: { readHead: HeadReader }): AppJobHandler<In, Out> {
  return async (job, app) => {
    const { prKey, status, repo, prNumber } = job.variables;

    // Only an `addressed` round claims a push, so only it can be a no-progress round. Skip the
    // GitHub read entirely for any other status — a `waiting` round costs nothing and continues.
    if ((status ?? "") !== "addressed") return { progressed: true };

    // Prefer the carried repo/prNumber; fall back to parsing the canonical `owner/repo#N` prKey so
    // an older in-flight instance (or a process-variable regression) still resolves a target. If
    // neither yields one, fail open rather than guess.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") return { progressed: true };

    const currentHead = await deps.readHead(ghRepo, ghNumber).catch(() => null);
    const prs = app.data.table<{ pr_key: string; last_round_head: string | null }>(
      "pull_requests",
      "pr_key",
    );
    const row = await prs.get(prKey);
    const previousHead = row?.last_round_head ?? null;

    // Record the observed head as the baseline for the next round's comparison — but only when we
    // actually read one, so a null (unreadable) head never clobbers a good baseline.
    if (currentHead) {
      await prs.update(prKey, { last_round_head: currentHead });
    }

    return { progressed: routeProgress(status, previousHead, currentHead) === "continue" };
  };
}

const handler = makeHandler({ readHead: defaultReadHead });
export default handler;
