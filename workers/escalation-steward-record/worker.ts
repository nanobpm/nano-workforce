// pr.escalation-steward-record — the steward tick's final step (issue #889). Takes the
// `senior:escalation-steward` agent's per-escalation decisions and, for each:
//   • ABSTAIN  → records an `abstained` row (the escalation is left for a human);
//   • RESOLVE  → submits the chosen variables through the ONE canonical attributed door
//     (`completeEscalationAsAgent`, app/agentCompletion.ts) — which resolves the open task against
//     `ESCALATION_TASK_ELEMENTS`, validates its real form contract, and completes it with AGENT
//     attribution (never a human decision, ADR 0046) — and records a `resolved` row.
//
// Host-side guards run BEFORE any submission, so a mis-prompted or hallucinating agent can never
// force one (fail-closed — every malformed/unsafe decision degrades to `abstained`, never throws,
// so one bad entry can never incident the record task and wedge the steward's overlap guard):
//   • the CLAIM/OWNERSHIP fence — this steward instance must hold a live claim for the key, so a
//     hallucinated key can never complete an unclaimed (or another run's) task;
//   • the destructive/irreversible-option guard (`isDestructiveOption`) — derived from the decision's
//     OWN selected value (`choice`, else the well-known form fields in `variables`), never trusted
//     from an optional auxiliary field alone; an `abandon`/`force-merge`/credential choice is recorded
//     `abstained`, never submitted;
//   • the loop guard (`loopGuardTripped`) — a subject already auto-resolved N times that escalates
//     again is recorded `abstained`;
//   • the malformed-variables guard — a `resolved` decision whose `variables` are missing/null/not a
//     plain object is converted to `abstained` BEFORE completion, so no false `resolved` record is
//     ever written for a submission that never happened.
import type { AppJobHandler } from "@nanobpm/urban";
import { getAgentJobActivation } from "../../app/agentActivationLedger.ts";
import { completeEscalationAsAgent, priorAgentCompletion, snapshotEscalationFormOptions } from "../../app/agentCompletion.ts";
import {
  countSubjectResolutions,
  ESCALATION_STEWARD_JOB_TYPE,
  type EscalationAutoResolution,
  escalationAutoResolutions,
  isUnsafeAutoOption,
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
  /** The chosen option value (an auxiliary hint for the destructive-option guard). */
  choice?: string;
  rationale?: string;
  evidence?: string;
  options?: unknown[];
}

/** True only for a non-null, non-array plain object — the shape `variables`/`decisions` entries must
 *  have. Anything else (`null`, an array, a scalar) is malformed and must never be dereferenced. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The well-known escalation-form SELECT field keys whose value carries the chosen option. This set
 *  MUST cover every `select`/`radio` key across `resources/forms/*.form`, so a destructive choice can
 *  never slip through on a key the guard doesn't read — the missing-key class is what let a
 *  `{directive:"abandon"}` (plan-review / empty-plan) or a `{mergeDecision:"force-merge"}`
 *  (merge-approval) submit unguarded and record `selected_option=NULL` (issue #889 review). The
 *  canonical keys today are `decision` (delivery), `directive` (plan-review / empty-plan),
 *  `resolution` (feature / readiness), `mergeDecision` (merge-approval) and `action` (trial-merge);
 *  `choice` is the auxiliary hint and `answer` the free-text field. A drift test
 *  (`worker.test.ts`) derives the form key set and fails if any is absent, so a NEW form select key
 *  can't silently fall out of this guard. */
export const SELECTED_VALUE_KEYS = [
  "choice",
  "resolution",
  "action",
  "decision",
  "directive",
  "mergeDecision",
  "answer",
] as const;

/** Derive the option value a decision actually selected — the well-known form-variable keys FIRST
 *  (the values the completion would really submit), then the auxiliary `choice` hint only as a
 *  fallback. The destructive guard tests this, so it must reflect what the completion submits rather
 *  than trusting a single optional field: an agent returning `choice: "retry"` with
 *  `variables: { resolution: "abandon" }` must be caught by the `abandon` in its variables, never
 *  waved through by the benign hint. */
function selectedOption(d: StewardDecision): string | null {
  if (isPlainObject(d.variables)) {
    for (const k of SELECTED_VALUE_KEYS) {
      const v = d.variables[k];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
  }
  if (typeof d.choice === "string" && d.choice.trim() !== "") return d.choice;
  return null;
}

/** Narrow a parsed JSON entry to a {@link StewardDecision}: only a non-null plain object qualifies
 *  (anything else — `null`, an array, a scalar — is malformed and skipped by the caller). A type
 *  predicate, not an `as` cast, so the narrowing is a real runtime guard. */
function isDecision(v: unknown): v is StewardDecision {
  return isPlainObject(v);
}

/** The REAL form choices for a claimed task, from the snapshot taken host-side at CLAIM time (parsed
 *  from the claim row's `options` JSON). The claim snapshot already resolves a delivery-graph human
 *  task's dynamic form via its engine `form_key` — which `snapshotEscalationFormOptions(element_id)`
 *  cannot, since that task's element id has no static form linkage (issue #889 review). Fall back to the
 *  element's static form only when the claim carried no snapshot (a legacy/pre-snapshot claim row), and
 *  never throw on malformed stored JSON (degrade to the fallback / null). */
function claimOptions(claim: EscalationAutoResolution): string[] | null {
  if (claim.options != null) {
    try {
      const parsed: unknown = JSON.parse(claim.options);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      // Malformed stored JSON — fall through to re-deriving from the element's static form.
    }
  }
  return claim.element_id != null ? snapshotEscalationFormOptions(claim.element_id) : null;
}

const handler: AppJobHandler<In, Record<string, never>> = async (job, app) => {
  const raw = typeof job.variables.resolutions === "string" ? job.variables.resolutions : "";
  const decisions: StewardDecision[] = [];
  if (raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      // Validate EACH entry as a non-null plain object before it is ever dereferenced — valid JSON such
      // as `[null]` must never reach the loop and throw on `d.userTaskKey` (which would incident the
      // record task and, because the steward process then stays ACTIVE, wedge the overlap guard).
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (isDecision(entry)) decisions.push(entry);
          else app.log.warn("escalation-steward record: skipping a malformed (non-object) decision entry");
        }
      }
    } catch (err) {
      app.log.error("escalation-steward record: unparseable resolutions", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // This steward instance's key — the claim/ownership fence matches it against the claim row's
  // `claimed_by`, so the record step only ever finalises tasks THIS run claimed.
  const stewardKey = job.processInstanceKey != null ? String(job.processInstanceKey) : `steward-${Date.now()}`;
  const agentId = `escalation-steward:${job.processInstanceKey != null ? String(job.processInstanceKey) : "unknown"}`;
  // Provenance (issue #889 review): `job.jobKey` here is the `pr.escalation-steward-record` SERVICE
  // job, NOT the preceding `senior:escalation-steward` AGENT job that actually made the decisions.
  // Persisting the record key as `agent_job_key` would give the audit record the wrong provenance, so
  // read the agent's activation key from the durable activation ledger (keyed by this SAME steward
  // process instance + the agent job type) — the poller records it while the agent job is live. When
  // the ledger has no row (the best-effort activation poll missed a fast agent job, or engine REST is
  // not configured), preserve NULL rather than store the record task's own key — a key known to
  // identify a DIFFERENT job is a confidently-wrong provenance, worse than an honest "unknown".
  const agentActivation =
    job.processInstanceKey != null
      ? await getAgentJobActivation(app.data, String(job.processInstanceKey), ESCALATION_STEWARD_JOB_TYPE).catch(() => undefined)
      : undefined;
  const agentJobKey = agentActivation?.job_key ?? null;

  for (const d of decisions) {
    const key = typeof d.userTaskKey === "string" ? d.userTaskKey.trim() : "";
    if (!key) continue;
    // Claim/ownership fence (fail-closed, applied to EVERY decision — not only `resolved`). This
    // steward instance must hold a LIVE claim for the key. Without it a hallucinated key could
    // complete an unclaimed — or a non-opted-in, or another run's — task. Crucially the fence is a
    // SKIP, not a downgrade-to-abstain: `recordResolution` finalises the claim row keyed only by
    // `user_task_key`, so recording ANY decision (even an `abstained`) for a key this run does not own
    // would finalise ANOTHER run's live claim. Skip every decision not owned by this run instead.
    const claimRows = await escalationAutoResolutions(app.data).find({ user_task_key: key });
    const claim = claimRows.find((r) => r.outcome === "claimed");
    const ownedByThisRun = claim != null && claim.claimed_by === stewardKey;
    if (!ownedByThisRun) {
      app.log.warn("escalation-steward record: no owned claim for key, skipping decision (leaving the claim untouched)", { userTaskKey: key });
      continue;
    }

    // Default to abstain on any malformed/unsafe decision — never submit on ambiguity.
    let outcome: "resolved" | "abstained" = d.outcome === "resolved" ? "resolved" : "abstained";
    let rationale = typeof d.rationale === "string" ? d.rationale : null;
    // The option value the decision actually selected, derived host-side from its OWN form variables
    // (never the agent's optional `choice` hint alone). Computed ONCE here so the destructive guard and
    // the persisted `selected_option` review column read the SAME value (issue #889 review).
    const selected = selectedOption(d);

    // Destructive/irreversible-option guard (host-side, fail-closed, ELEMENT-AWARE). Derive the
    // selected value from the decision's own variables FIRST (not only the optional `choice`), so a
    // `choice`-less `abandon` — or a benign `choice` paired with a destructive `variables` value — is
    // caught. `isUnsafeAutoOption` also refuses an element-specific RED-GATE OVERRIDE: on
    // `trial-merge-decision` a `proceed` overrides a `suite-failed` D3 trial merge (SPEC.md §13.2), so
    // only the non-override `rebase` path is steward-safe there (issue #889 review).
    if (outcome === "resolved") {
      if (selected != null && isUnsafeAutoOption(claim.element_id ?? null, selected)) {
        outcome = "abstained";
        rationale = `abstained: '${selected}' is a destructive/irreversible or red-gate-override option on ${claim.element_id ?? "this element"} — left for a human`;
      }
    }

    if (outcome === "resolved") {
      // Loop guard: look up the subject from the OWNED claim row and refuse to keep re-answering a
      // subject that has already been auto-resolved LOOP_GUARD_MAX_RESOLUTIONS times. Count by BOTH
      // `subject_type` AND `subject_key` (issue #889 review): a bare `subject_key` collides across
      // subject types (a plan `o/r#1` and a PR `o/r#1` share the key), so an unscoped count would let
      // one subject's resolutions force an UNRELATED subject to abstain on its first escalation. Use
      // the owned claim's own subject identity, not `claimRows[0]` (which may be a foreign run's row).
      const subjectType = claim.subject_type ?? null;
      const subjectKey = claim.subject_key ?? null;
      if (subjectKey) {
        const prior = await countSubjectResolutions(app.data, subjectType, subjectKey);
        if (loopGuardTripped(prior, LOOP_GUARD_MAX_RESOLUTIONS)) {
          outcome = "abstained";
          rationale = `abstained: subject ${subjectType ?? "?"}:${subjectKey} already auto-resolved ${prior}× and escalated again — the automatic answer isn't working; a human must decide`;
        }
      }
    }

    // Malformed-variables guard (fail-closed): a `resolved` decision needs a plain-object `variables`.
    // Missing/null/array-valued variables would otherwise skip completion yet still record a false
    // `resolved`; convert to `abstained` BEFORE the completion branch so the record stays honest. Bind
    // the narrowed value once so the completion + record share it without a re-assertion.
    const vars = isPlainObject(d.variables) ? d.variables : null;
    if (outcome === "resolved" && vars === null) {
      outcome = "abstained";
      rationale = "abstained: `resolved` decision carried no valid `variables` object — left for a human";
    }

    // Evidence-before-choosing guard (fail-closed, issue #889 review): the PR's promise is that every
    // automatic resolution carries a reviewable audit record — a non-blank rationale AND the evidence
    // the agent checked. A `resolved` decision that omits either would auto-complete an escalation
    // with no reviewable basis, so convert it to `abstained` (left for a human) exactly as malformed
    // variables are. Read the agent's evidence once so the guard and the record agree.
    const evidence = typeof d.evidence === "string" && d.evidence.trim() !== "" ? d.evidence : null;
    if (outcome === "resolved" && (rationale == null || rationale.trim() === "" || evidence === null)) {
      outcome = "abstained";
      rationale = "abstained: `resolved` decision carried no rationale/evidence — the audit record would be incomplete; left for a human";
    }

    let submitted: Record<string, unknown> | null = null;
    if (outcome === "resolved" && vars !== null) {
      try {
        // The ONE canonical attributed door: resolves the open task against ESCALATION_TASK_ELEMENTS,
        // validates its real form contract, and completes with AGENT attribution (ADR 0046).
        const result = await completeEscalationAsAgent(app.data, app.engine, {
          userTaskKey: key,
          variables: vars,
          agentId,
        });
        if (result.ok) {
          submitted = vars;
        } else {
          // Idempotent-retry recovery (issue #889 review): the completion→record pair is NOT atomic.
          // The engine completion lands first; the claim-row finalise below is a SEPARATE write. If
          // that finalise failed transiently on a prior attempt, this service job is retried with the
          // user task ALREADY COMPLETED — the door then reports "no open completable task". That must
          // NOT degrade the already-applied decision to a false `abstained` (which would lose the
          // submitted variables and mis-audit an applied automatic decision as a human hand-off).
          // Detect the prior agent-attributed completion and finalise the SAME decision idempotently.
          const prior = await priorAgentCompletion(app.data, key, agentId).catch(() => undefined);
          if (prior) {
            let recovered: Record<string, unknown> | null = null;
            try {
              const parsedVars: unknown = JSON.parse(prior.variables_json);
              if (isPlainObject(parsedVars)) recovered = parsedVars;
            } catch {
              // Malformed stored variables_json — fall back to this attempt's variables below.
            }
            submitted = recovered ?? vars;
            app.log.info("escalation-steward record: recovered a prior agent completion on retry — finalising the original decision idempotently", { userTaskKey: key, completionId: prior.id });
          } else {
            outcome = "abstained";
            rationale = `abstained: completion refused (${result.reason ?? "unknown"}) — left for a human`;
            app.log.warn("escalation-steward record: completion refused, recorded abstained", { userTaskKey: key, reason: result.reason });
          }
        }
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
      selectedOption: selected,
      rationale,
      evidence,
      // Carry through the REAL form choices snapshotted host-side at CLAIM time (from the task's
      // engine-resolved `form_key`, issue #889 review) — never the deciding agent's self-reported
      // `options`, which it may omit or misstate. The claim snapshot already resolves a delivery-graph
      // human task's dynamic form (which `snapshotEscalationFormOptions(element_id)` alone cannot); fall
      // back to the element's static form only when the claim carried no snapshot.
      options: claimOptions(claim),
      agentJobKey,
      worker: null,
      model: null,
    });
  }
  app.log.info("escalation-steward record", { processed: decisions.length });
  return {};
};

export default handler;
