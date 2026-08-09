// pr.persist-round — records a completed round (an `addressed` round where the agent pushed
// changes, or a `waiting` round where there was nothing to triage yet) and parks the PR in
// `waiting_review` so the poller starts watching for / soliciting the next review.
//
// Data access goes through the injected app datasource gateway (`app.data.table<T>`), the RAD
// `Table<T>` surface — `rounds.insert(...)` / `pull_requests.update(...)`, not hand-written SQL.
import type { AppJobHandler } from "@nanobpm/urban";
import { ensurePr, parsePr } from "../../app/service.ts";
import { abandonTokenFromUrl } from "../../app/abandon.ts";

// Extends Record so the declared fields are typed while the job may still carry
// other process variables (e.g. io.nanobpm.agentResult, read by transcriptOf).
interface In extends Record<string, unknown> {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
  // Carried by the convergence-loop instance (set at createInstance) so a missing
  // `pull_requests` parent can be reconstructed before the FK-child `rounds` insert.
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  // The per-PR abandon capability URL the review agent was handed; its token is preserved on a
  // heal so the agent's cooperative-abort check keeps resolving (see ensurePr).
  abandonUrl?: string;
}

// The harness records the agent's full (byte-capped) stdout on the result envelope; keep it
// for audit so a human can see what the agent did this round.
const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler<In> = async (job, app) => {
  // This worker is the "addressed"/"waiting" path, so `status` resolves to one of those
  // domain values. `summary` is left undefined when absent: the write boundary omits it so the
  // nullable `rounds.summary` column stays NULL rather than being coerced to "".
  const { prKey, round, status = "addressed", summary, repo, prNumber, prUrl, abandonUrl } = job.variables;
  const now = new Date().toISOString();

  // Heal a missing FK parent (engine/app.db desync) before the child `rounds` insert so this
  // never dies with an opaque `FOREIGN KEY constraint failed` incident. Prefer the carried
  // repo/prNumber; if either is missing (an older in-flight instance, or a process-variable
  // regression) fall back to parsing them out of the canonical `owner/repo#N` prKey so the heal
  // still runs.
  const parsed = parsePr(prKey);
  const healRepo = repo ?? parsed?.repo;
  const healNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
  if (healRepo && typeof healNumber === "number") {
    await ensurePr(app.data, {
      prKey,
      repo: healRepo,
      number: healNumber,
      url: prUrl,
      round,
      abandonToken: abandonTokenFromUrl(abandonUrl),
    });
  }

  await app.data.table("rounds", "id").insert({
    pr_key: prKey,
    round_no: round,
    status,
    summary,
    transcript: transcriptOf(job.variables),
    started_at: now,
    ended_at: now,
  });
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "waiting_review",
    current_round: round,
    waiting_since: now,
    updated_at: now,
  });

  return {};
};

export default handler;
