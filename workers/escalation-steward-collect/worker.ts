// pr.escalation-steward-collect — the steward tick's first step (issue #889). Collects the OPEN
// escalation user tasks that are ELIGIBLE for auto-resolution and claims them for THIS steward run,
// so the agent dispatched next has a bounded, non-overlapping work set.
//
// Eligibility (app/escalationSteward.ts, the ONE derivation):
//   • the escalation's owning work OPTED IN (`auto_resolve_escalations` on its subject row, resolved
//     via the task's process/root instance key);
//   • the kind is steward-answerable (never a human-only / irreversible / credential kind);
//   • the task is past the minimum age (a human already answering wins);
//   • it is not already claimed by a live steward run (the claim/lease fence).
//
// Overlap guard: if the PREVIOUS steward instance is still ACTIVE, this tick claims nothing and
// reports `skippedOverlap` — the process's gateway then routes straight to done (a no-op tick), so
// two steward runs never double-answer.
import type { AppJobHandler } from "@nanobpm/urban";
import {
  claimEscalations,
  DEFAULT_MIN_AGE_MS,
  ESCALATION_STEWARD_PROCESS_ID,
  finalRecordedTaskKeys,
  isEligibleEscalation,
  liveClaimedTaskKeys,
  optInByProcessKey,
  optInBySubjectKey,
} from "../../app/escalationSteward.ts";
import { type UserTaskRow, userTasks } from "../../app/userTasks.ts";

interface In extends Record<string, unknown> {
  stewardInstanceKey?: string;
  minAgeMs?: number;
}

interface Out extends Record<string, unknown> {
  eligibleCount: number;
  /** The claimed escalations, serialised for the agent's `claimedTasks` input (JSON). */
  claimed: string[];
  skippedOverlap: boolean;
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const stewardKey = job.processInstanceKey != null ? String(job.processInstanceKey) : `steward-${Date.now()}`;
  const minAgeMs = typeof job.variables.minAgeMs === "number" && job.variables.minAgeMs >= 0 ? job.variables.minAgeMs : DEFAULT_MIN_AGE_MS;

  // Overlap guard: a still-active prior steward instance means this tick is a no-op.
  const active = await app.engine.searchProcessInstances({ processDefinitionId: ESCALATION_STEWARD_PROCESS_ID, state: "ACTIVE" });
  const prior = active.filter((i) => String(i.processInstanceKey) !== stewardKey);
  if (prior.length > 0) {
    app.log.info("escalation-steward collect: prior run still active — no-op tick", { active: prior.length });
    return { eligibleCount: 0, claimed: [], skippedOverlap: true };
  }

  const open = await userTasks(app.data).all();
  const optInByProc = await optInByProcessKey(app.data);
  const optInBySubject = await optInBySubjectKey(app.data);
  // The claim fence's partial UNIQUE index only fences an OPEN claim; once a row is finalised
  // (`resolved`/`abstained`) it leaves that index, and because an abstention does NOT complete the
  // task, the same `user_task_key` would be re-claimed every tick (issue #889 review). Union the
  // already-final keys into the exclusion set so a task the steward already answered/abstained is
  // never re-claimed (a genuinely NEW escalation gets a NEW engine key, so this never blocks one).
  const claimedKeys = await liveClaimedTaskKeys(app.data);
  for (const k of await finalRecordedTaskKeys(app.data)) claimedKeys.add(k);
  const at = Date.now();

  // Resolve each task's opt-in from its owning subject. A top-level escalation's `process_key` IS the
  // subject's instance; an escalation parked INSIDE a callActivity child cell (the shared
  // `human-escalation`/`implement-cell`) instead carries the CHILD's `process_key` (no subject row
  // tracks it) but the PARENT run's `subject_key` (pollUserTasks correlates it via the root instance).
  // So check the direct `process_key` first; only when that lookup is ABSENT (no subject row keyed on
  // this process instance at all) fall back to the correlated `<subject_type>:<subject_key>`. A direct
  // lookup that returned `false` is an explicit opt-OUT and MUST be trusted — never OR-ed past with a
  // subject-key fallback that could flip it back to eligible (issue #889 review). The subject fallback
  // is COMPOUND-keyed by `subject_type` so a `plan_key`/`pr_key`/`run_key` colliding across tables
  // can't cross-match. A task with no tracked subject either way is NOT opted in (fail-closed).
  const eligible: UserTaskRow[] = [];
  for (const row of open) {
    const procKey = row.process_key ?? "";
    const directOptIn = procKey !== "" ? optInByProc.get(procKey) : undefined;
    const optedIn =
      directOptIn !== undefined
        ? directOptIn
        : row.subject_key != null && row.subject_key !== "" &&
          optInBySubject.get(`${row.subject_type}:${row.subject_key}`) === true;
    if (isEligibleEscalation(row, { optedIn, minAgeMs, claimedUserTaskKeys: claimedKeys, at })) {
      eligible.push(row);
    }
  }

  const claimed = await claimEscalations(app.data, eligible, stewardKey);
  app.log.info("escalation-steward collect", { open: open.length, eligible: eligible.length, claimed: claimed.length });
  // Serialise the claimed rows for the agent (the message/job envelope is scalar-only for lists, so
  // carry each as a compact JSON string the agent + record step parse).
  return {
    eligibleCount: claimed.length,
    claimed: claimed.map((r) => JSON.stringify(r)),
    skippedOverlap: false,
  };
};

export default handler;
