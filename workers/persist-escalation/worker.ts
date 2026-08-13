// pr.persist-escalation — records the round that raised an escalation and opens an escalation
// row for a human to answer. Handles both the agent-raised path (status = needs_input | blocked)
// and the MAX_ROUNDS guard (status = blocked, question set by the process). Returns
// `escalationId` for the UI.
//
// A BLANK question is a NON-escalation (nano-workforce ADR 0002 §1): it must never open an
// answerable escalation. The convergence-loop `gw-status` gateway enforces this upstream — its
// `f_escalate` arm now requires a non-blank question, so a blank-question round re-enters the
// durable review wait instead of routing here (see app/roundResultDefault.ts). This worker keeps
// the same rule as defence-in-depth via the canonical taxonomy: if a blank-question job ever
// reaches it, it opens NO escalation and reports `escalated:false` rather than FABRICATING a
// question (the retired failure mode) or throwing an un-remediable incident. The convergence-loop
// model branches on that `escalated` output (`gw-escalated`): a `false` return re-enters the loop
// via `gw-guard` instead of flowing into the `wait-answer` catch, so a non-escalation can never
// wedge a token on a durable wait that has no escalation for a human to answer.
import type { AppJobHandler } from "@nanobpm/urban";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
import { classifyEscalation } from "../../app/escalationTaxonomy.ts";
import { ensurePr, parsePr } from "../../app/service.ts";

// Extends Record so the declared fields are typed while the job may still carry
// other process variables (e.g. io.nanobpm.agentResult, read by transcriptOf).
interface In extends Record<string, unknown> {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
  question?: string;
  // Carried by the convergence-loop instance so a missing `pull_requests` parent can be
  // reconstructed before the FK-child `rounds`/`escalations` inserts.
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  // The per-PR abandon capability URL the agent was handed; its token is preserved on a heal so
  // the agent's cooperative-abort check keeps resolving (see ensurePr).
  abandonUrl?: string;
  // False on the "review stalled" arm: `persist-round` already recorded this `round` as
  // `addressed`, so this escalation must not insert a second `rounds` row for the same
  // `pr_key`/`round_no` (which would record one round as both addressed and blocked). Absent
  // on the agent-raised / max-rounds arms, where no prior round row exists — so it defaults on.
  recordRound?: boolean;
}

// A string variable, or undefined when it is absent, empty, or whitespace-only.
// The write boundary owns *type* defaults (undefined -> column DEFAULT/NULL); this
// owns a *domain* rule: a blank prompt or status counts as "missing" so it can't
// reach the escalation control flow or the UI answer form.
function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

// The c8ctl harness completes each agent job with an `agent` variable (its profile name), which
// propagates here. Record it on the round/escalation so a human can identify the servicing worker
// from the durable history. Reuses the `nonBlank` domain rule (blank/absent -> NULL column).
function workerOf(vars: Record<string, unknown>): string | undefined {
  return nonBlank(vars.agent);
}

const handler: AppJobHandler<In> = async (job, app) => {
  const { prKey, round, summary, repo, prNumber, prUrl, abandonUrl } = job.variables;
  // `status` drives the escalation kind (control flow); a blank/absent status is an
  // unclassified escalation -> a question needing input. `question` is denormalised
  // onto pull_requests below and bound by the UI answer form, so it must be a
  // concrete, non-blank value. `summary` is left undefined so the write boundary
  // omits it and the nullable column stays NULL.
  const rawStatus = nonBlank(job.variables.status);
  const status = rawStatus ?? "needs_input";
  const transcript = transcriptOf(job.variables);
  const worker = workerOf(job.variables);
  // Classify this job through the single canonical taxonomy (ADR 0002 §1). Only a
  // decision-required escalation opens an answerable escalation row. A blank question (or any
  // non-human-blocking status that reached here defensively) is a NON-escalation: open nothing
  // and report `escalated:false` — never FABRICATE a question and never throw. The `gw-status`
  // gateway already routes blank-question rounds back into the durable review wait, so this is
  // defence-in-depth, not the primary guard.
  const question = nonBlank(job.variables.question);
  const disposition = classifyEscalation({ kind: "review-round", status: rawStatus, question });
  if (disposition !== "decision-required" || question === undefined) {
    return { escalationId: null, escalated: false };
  }
  const kind = status === "needs_input" ? "question" : "blocker";
  const now = new Date().toISOString();

  // Heal a missing FK parent (engine/app.db desync) before the child `rounds`/`escalations`
  // inserts so this never dies with an opaque `FOREIGN KEY constraint failed` incident. Prefer
  // the carried repo/prNumber; if either is missing (an older in-flight instance, or a
  // process-variable regression) fall back to parsing them out of the canonical `owner/repo#N`
  // prKey so the heal still runs.
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

  // Skip the round insert when the caller already recorded this round (the "review stalled"
  // arm runs after `persist-round`): re-inserting would duplicate the `pr_key`/`round_no` row.
  if (job.variables.recordRound !== false) {
    await app.data.table("rounds", "id").insert({
      pr_key: prKey,
      round_no: round,
      status,
      summary,
      transcript,
      worker,
      started_at: now,
      ended_at: now,
    });
  }
  const escalationId = await app.data.table("escalations", "id").insert({
    pr_key: prKey,
    round_no: round,
    kind,
    question,
    transcript,
    worker,
    status: "open",
    asked_at: now,
  });
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "escalated",
    current_round: round,
    updated_at: now,
    open_escalation_id: Number(escalationId),
    open_escalation_question: question,
  });

  return { escalationId: Number(escalationId), escalated: true };
};

export default handler;
