// pr.persist-escalation — records the round that raised an escalation and opens an escalation
// row for a human to answer. Handles both the agent-raised path (status = needs_input | blocked)
// and the MAX_ROUNDS guard (status = blocked, question set by the process). Returns
// `escalationId` for the UI.
import type { AppJobHandler } from "@nanobpm/urban";
import { abandonTokenFromUrl } from "../../app/abandon.ts";
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

// Synthesize a concrete, answerable question when the agent left one blank. A blank question is
// almost always a *no-result* round: a prompt-less agent that never wrote its result file, so
// `status` is empty and `gw-status` falls through its default `f_escalate` arm (the empty
// "(no question provided)" escalations on Magikcraft/nano-bpm #597/#599). Throwing here parked a
// `JobNoRetries` incident that could NOT be diagnosed or remediated from the UI. Instead we open
// an escalation a human can actually answer, with the agent's transcript attached below it.
function fabricateQuestion(rawStatus: string | undefined, hasTranscript: boolean): string {
  const tail = hasTranscript
    ? " Review the agent's response shown below, then reply with how it should proceed — or cancel and resubmit."
    : " No agent response was captured. Reply with how it should proceed, or cancel and resubmit.";
  if (!rawStatus) {
    return "The review agent finished without a machine-readable result (no status was reported), " +
      "so this round could not be classified as converged, addressed, or a specific request." + tail;
  }
  return `The review agent reported status "${rawStatus}" without a question, so this round ` +
    "could not be resolved automatically." + tail;
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
  // A blank question must never open an unanswerable escalation. Every legitimate arm sets a
  // concrete question — the agent contract requires one for needs_input/blocked, and the
  // max-rounds + review-timeout arms set a literal via the model. When one is still missing
  // (a no-result round through the `gw-status` default), fabricate an actionable question that
  // references the attached transcript rather than throwing (which parked an un-remediable
  // incident). This keeps the loop recoverable entirely from the UI.
  const question = nonBlank(job.variables.question) ?? fabricateQuestion(rawStatus, transcript != null);
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

  return { escalationId: Number(escalationId) };
};

export default handler;
