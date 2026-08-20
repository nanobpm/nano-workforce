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
// question (the retired failure mode) or throwing an un-remediable incident. EVERY convergence-loop
// escalation arm — the agent-verdict `persist-escalation` AND the four control-flow arms
// (`persist-escalation-noprogress`, `persist-review-stalled`, `persist-escalation-blockedcomments`,
// `persist-escalation-maxrounds`) — now routes its `escalated` output through the `gw-escalated`
// gateway (issue #333): a `false` return re-enters the loop via `gw-guard` instead of flowing into
// the `wait-answer` catch, so a non-escalation (e.g. a blank `convergeBlockReason`) can never wedge
// a token on a durable wait that has no escalation for a human to answer.
import type { AppJobHandler } from "@nanobpm/urban";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
import { classifyEscalation } from "../../app/escalationTaxonomy.ts";
import { ensurePr, parsePr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`EscalationIn` in convergence-loop.bpmn) — ADR 0040.
// Framework-injected variables (`io.nanobpm.agentResult`, `agent`) are read through the
// `Record`-typed helpers below rather than the envelope.
type In = WorkerInputs["pr.persist-escalation"];

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
  const { prKey, round, summary, repo, prNumber, prUrl, abandonUrl, headSha, scopeBlock } = job.variables;
  // `status` drives the escalation kind (control flow); a blank/absent status is an
  // unclassified escalation -> a question needing input. `question` is returned as a
  // process variable below so the downstream `wait-answer` userTask + `pr-escalation.form`
  // can display it, so it must be a concrete, non-blank value. `summary` is left undefined
  // so the write boundary omits it and the nullable column stays NULL.
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
    // Bind a scope-integrity escalation to the reviewed commit (issue #395) so the converge-gate
    // can honour a human answer as an override for THIS HEAD instead of re-deriving the block from
    // the PR body and re-escalating forever. Only the scope-integrity arm passes these; every other
    // arm leaves them absent (→ head_sha NULL, scope_block DEFAULT 0), so the override door opens
    // exclusively for the block the human can actually answer.
    head_sha: headSha,
    scope_block: scopeBlock === true ? 1 : 0,
  });
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "escalated",
    current_round: round,
    updated_at: now,
  });

  return { escalationId: Number(escalationId), escalated: true, question };
};

export default handler;
