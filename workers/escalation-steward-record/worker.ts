// pr.escalation-steward-record — the steward tick's final step (issue #889). Takes the
// `senior:escalation-steward` agent's per-escalation decisions and, for each:
//   • ABSTAIN  → records an `abstained` row (the escalation is left for a human);
//   • RESOLVE  → submits the chosen variables through the ONE canonical attributed door
//     (`completeUserTaskAttributed`, app/agentCompletion.ts) with AGENT attribution — never a human
//     decision (ADR 0046) — and records a `resolved` row.
//
// Two host-side guards run BEFORE any submission, so a mis-prompted agent can never force them:
//   • the destructive/irreversible-option guard (`isDestructiveOption`) — an `abandon`/`force-merge`/
//     credential choice is recorded `abstained`, never submitted;
//   • the loop guard (`loopGuardTripped`) — a subject already auto-resolved N times that escalates
//     again is recorded `abstained`.
// Both are defence-in-depth under the prompt's own abstain rules, enforced in ONE place here.
import type { AppJobHandler } from "@nanobpm/urban";
import { completeUserTaskAttributed } from "../../app/agentCompletion.ts";
import {
  countSubjectResolutions,
  escalationAutoResolutions,
  isDestructiveOption,
  LOOP_GUARD_MAX_RESOLUTIONS,
  loopGuardTripped,
  recordResolution,
} from "../../app/escalationSteward.ts";

interface In extends Record<string, unknown> {
  stewardInstanceKey?: string;
  /** The agent's decisions, as a JSON string (the job envelope carries lists as serialised strings). */
  resolutions?: string;
}

/** One decision the agent returned for a claimed escalation. */
interface StewardDecision {
  userTaskKey: string;
  /** `resolved` — submit `variables`; `abstained` — leave for a human. */
  outcome: "resolved" | "abstained";
  variables?: Record<string, unknown>;
  /** The chosen option value (used by the destructive-option guard). */
  choice?: string;
  rationale?: string;
  evidence?: string;
  options?: unknown[];
}

const handler: AppJobHandler<In, Record<string, never>> = async (job, app) => {
  const raw = typeof job.variables.resolutions === "string" ? job.variables.resolutions : "";
  let decisions: StewardDecision[] = [];
  if (raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      // biome-ignore lint/plugin: the agent's resolutions payload is parsed JSON; narrowed to the decision array (validated Array above)
      if (Array.isArray(parsed)) decisions = parsed as StewardDecision[];
    } catch (err) {
      app.log.error("escalation-steward record: unparseable resolutions", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const agentId = `escalation-steward:${job.processInstanceKey != null ? String(job.processInstanceKey) : "unknown"}`;
  const jobKey = job.jobKey != null ? String(job.jobKey) : null;

  for (const d of decisions) {
    const key = typeof d.userTaskKey === "string" ? d.userTaskKey.trim() : "";
    if (!key) continue;
    // Default to abstain on any malformed/unsafe decision — never submit on ambiguity.
    let outcome: "resolved" | "abstained" = d.outcome === "resolved" ? "resolved" : "abstained";
    let rationale = typeof d.rationale === "string" ? d.rationale : null;

    // Destructive/irreversible-option guard (host-side, fail-closed).
    if (outcome === "resolved" && typeof d.choice === "string" && isDestructiveOption(d.choice)) {
      outcome = "abstained";
      rationale = `abstained: '${d.choice}' is a destructive/irreversible option — left for a human`;
    }

    if (outcome === "resolved") {
      // Loop guard: look up the subject from the claim row and refuse to keep re-answering a subject
      // that has already been auto-resolved LOOP_GUARD_MAX_RESOLUTIONS times.
      const claimRows = await escalationAutoResolutions(app.data).find({ user_task_key: key });
      const subjectKey = claimRows[0]?.subject_key ?? null;
      if (subjectKey) {
        const prior = await countSubjectResolutions(app.data, subjectKey);
        if (loopGuardTripped(prior, LOOP_GUARD_MAX_RESOLUTIONS)) {
          outcome = "abstained";
          rationale = `abstained: subject ${subjectKey} already auto-resolved ${prior}× and escalated again — the automatic answer isn't working; a human must decide`;
        }
      }
    }

    let submitted: Record<string, unknown> | null = null;
    if (outcome === "resolved" && d.variables && typeof d.variables === "object") {
      try {
        await completeUserTaskAttributed(
          app.data,
          app.engine,
          { userTaskKey: key, variables: d.variables },
          { kind: "agent", id: agentId },
        );
        submitted = d.variables;
      } catch (err) {
        // A failed completion (task already answered by a human, or gone) degrades to abstain — the
        // escalation is simply left for a human. Never fail the whole tick on one task.
        outcome = "abstained";
        rationale = `abstained: completion failed (${err instanceof Error ? err.message : String(err)}) — left for a human`;
        app.log.warn("escalation-steward record: completion failed, recorded abstained", { userTaskKey: key });
      }
    }

    await recordResolution(app.data, key, {
      outcome,
      submittedVariables: submitted,
      rationale,
      evidence: typeof d.evidence === "string" ? d.evidence : null,
      options: Array.isArray(d.options) ? d.options : null,
      agentJobKey: jobKey,
      worker: null,
      model: null,
    });
  }
  app.log.info("escalation-steward record", { processed: decisions.length });
  return {};
};

export default handler;
