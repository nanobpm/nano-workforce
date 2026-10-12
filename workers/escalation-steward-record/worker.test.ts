// Unit coverage for the pr.escalation-steward-record worker (issue #889) — the steward tick's final
// step. Drives the handler against an in-memory data layer + a completeUserTask-capturing engine and
// asserts:
//   • a `resolved` decision is submitted through the canonical attributed door with AGENT attribution
//     (recorded in `task_completions`, never a human) AND written to `escalation_auto_resolutions`;
//   • a destructive/irreversible choice (`abandon`) is recorded `abstained` and NEVER submitted;
//   • the loop guard records `abstained` (no submission) once a subject hits the resolution cap;
//   • an `abstained` decision is recorded without any engine completion.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { taskCompletions } from "../../app/agentCompletion.ts";
import { recordAgentJobObservation } from "../../app/agentActivationLedger.ts";
import { claimEscalations, escalationAutoResolutions, LOOP_GUARD_MAX_RESOLUTIONS, recordResolution } from "../../app/escalationSteward.ts";
import type { UserTaskRow } from "../../app/userTasks.ts";
import handler, { FREE_TEXT_VALUE_KEYS, SELECTED_VALUE_KEYS } from "./worker.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

function taskRow(over: Partial<UserTaskRow>): UserTaskRow {
  return {
    user_task_key: "UT-1",
    element_id: "wait-answer",
    kind_label: "PR review",
    subject_type: "pr",
    subject_key: "o/r#1",
    subject_title: "o/r#1",
    subject_url: "https://github.com/o/r/pull/1",
    question: "Which approach?",
    process_key: "PI-1",
    form_key: "pr-escalation",
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

/** Boot the real data layer + a completeUserTask-capturing engine, run the record worker, and return
 *  the captured completions plus the post-run records read BEFORE the app stops (the DB closes on
 *  stop, so all assertions must read inside the callback). */
async function run(
  decisions: Record<string, unknown>[],
  seed: (data: DataLayer) => Promise<void>,
  assertAfter: (data: DataLayer, completed: { userTaskKey: string; variables: Record<string, unknown> }[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-steward-rec-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  const completed: { userTaskKey: string; variables: Record<string, unknown> }[] = [];
  try {
    await seed(app.db);
    // The record worker completes through `completeEscalationAsAgent`, which resolves the open task via
    // `openUserTasks` (CREATED only) before calling `completeUserTask`. Report every claimed task as an
    // open `wait-answer` escalation so the door resolves it (a key with no open task is a no-op).
    const engine = {
      openUserTasks: async () => {
        const claims = await escalationAutoResolutions(app.db).all();
        return claims
          .filter((c) => c.outcome === "claimed")
          // Report each claimed task under its OWN element_id so the completer validates against the
          // task's real form contract (a trial-merge-decision validates `action`, not `answer`).
          .map((c) => ({ userTaskKey: c.user_task_key, elementId: c.element_id ?? "wait-answer", processInstanceKey: "PI-1" }));
      },
      completeUserTask: (userTaskKey: string, variables: Record<string, unknown>) => {
        completed.push({ userTaskKey, variables });
        return Promise.resolve();
      },
    };
    const job = {
      jobKey: "J-1",
      processInstanceKey: "PI-STEWARD",
      variables: { resolutions: JSON.stringify(decisions) },
    };
    await handler(job as never, { data: app.db, engine: engine as never, log: { info: () => {}, warn: () => {}, error: () => {} } } as never);
    await assertAfter(app.db, completed);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("record worker: a resolved decision is submitted with AGENT attribution and recorded", async () => {
  await run(
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "Retry with a note." }, rationale: "nothing pushed", evidence: "ls-remote empty", options: ["retry", "abandon"] }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      // Submitted through the canonical door exactly once, with the agent's variables.
      assertEquals(completed.length, 1);
      assertEquals(completed[0].userTaskKey, "UT-1");
      assertEquals(completed[0].variables.answer, "Retry with a note.");
      // Recorded `resolved` with the variables + rationale.
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(rows[0].rationale, "nothing pushed");
      // Attribution: the completion is recorded AGENT, never human (ADR 0046).
      const completions = await taskCompletions(data).find({ user_task_key: "UT-1" });
      assertEquals(completions.length, 1);
      assertEquals(completions[0].actor_kind, "agent", "steward resolutions are agent-attributed, never a human decision");
      assertEquals(completions[0].actor_id.startsWith("escalation-steward:"), true);
    },
  );
});

test("record worker: a destructive/irreversible choice (abandon) is abstained, never submitted", async () => {
  await run(
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "abandon", variables: { resolution: "abandon" }, rationale: "agent chose abandon" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "a destructive option is NEVER submitted to the engine");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "abstained");
      assert(/destructive|irreversible/i.test(rows[0].rationale ?? ""), "the rationale names the destructive guard");
    },
  );
});

test("record worker: an abstained record clears selected_option — no proposed-but-rejected option leaks (issue #889 review)", async () => {
  // The destructive guard converts a `resolved` abandon decision to `abstained`. Because the steward
  // submitted NOTHING, the record's `selected_option` must be NULL — persisting the derived (rejected)
  // `abandon` value would tell consumers the steward "chose abandon" on a record where it chose to
  // abstain, contradicting the OpenAPI contract ("Null when abstained") and misrepresenting the audit.
  await run(
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "abandon", variables: { resolution: "abandon" }, rationale: "agent chose abandon" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "a destructive option is NEVER submitted to the engine");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "abstained");
      assertEquals(rows[0].selected_option, null, "an abstained record has NO chosen option — the rejected value is not persisted");
    },
  );
});

test("record worker: a benign `choice` paired with a destructive `variables` value is abstained (variables win over the hint)", async () => {
  await run(
    // The auxiliary `choice` says "retry" but the submitted variables carry `resolution: "abandon"` —
    // the destructive guard must derive the selected value from the variables FIRST, never wave the
    // destructive submission through on the benign hint.
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { resolution: "abandon" }, rationale: "agent contradicts itself" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "a destructive value in variables is NEVER submitted, regardless of the choice hint");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "abstained");
      assert(/destructive|irreversible/i.test(rows[0].rationale ?? ""), "the rationale names the destructive guard");
    },
  );
});

test("record worker: the loop guard abstains once a subject hits the resolution cap", async () => {
  await run(
    [{ userTaskKey: "UT-NEW", outcome: "resolved", choice: "retry", variables: { answer: "retry again" } }],
    async (data) => {
      // Seed LOOP_GUARD_MAX_RESOLUTIONS prior RESOLVED rows for the same subject.
      for (let i = 0; i < LOOP_GUARD_MAX_RESOLUTIONS; i++) {
        const key = `UT-OLD-${i}`;
        await claimEscalations(data, [taskRow({ user_task_key: key })], "s");
        await recordResolution(data, key, { outcome: "resolved", submittedVariables: { answer: "x" } });
      }
      // The fresh escalation for the SAME subject, claimed this tick.
      await claimEscalations(data, [taskRow({ user_task_key: "UT-NEW" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "the loop guard blocks the submission");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-NEW" });
      assertEquals(rows[0].outcome, "abstained");
      assert(/auto-resolved|isn't working|loop/i.test(rows[0].rationale ?? ""), "the rationale names the loop guard");
    },
  );
});

test("record worker: an abstained decision is recorded without any engine completion", async () => {
  await run(
    [{ userTaskKey: "UT-1", outcome: "abstained", rationale: "unclear — needs a human" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0);
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "abstained");
      assertEquals(rows[0].submitted_variables, null);
      assertEquals(rows[0].rationale, "unclear — needs a human");
    },
  );
});

test("record worker: the loop guard is scoped by subject_type — a DIFFERENT subject type sharing the key is NOT tripped (issue #889 review)", async () => {
  await run(
    // A PLAN subject `plan:o/r#1` escalates. A PR subject `pr:o/r#1` (SAME key, DIFFERENT type) has
    // already hit the resolution cap. Before the fix the guard counted by bare `subject_key`, so the
    // PR's resolutions tripped the UNRELATED plan's guard on its FIRST escalation.
    [{ userTaskKey: "UT-PLAN", outcome: "resolved", variables: { directive: "proceed" }, rationale: "ok", evidence: "checked" }],
    async (data) => {
      // Seed LOOP_GUARD_MAX_RESOLUTIONS prior RESOLVED rows for the PR subject (subject_type "pr").
      for (let i = 0; i < LOOP_GUARD_MAX_RESOLUTIONS; i++) {
        const key = `UT-PR-${i}`;
        await claimEscalations(data, [taskRow({ user_task_key: key, subject_type: "pr", subject_key: "o/r#1" })], "s");
        await recordResolution(data, key, { outcome: "resolved", submittedVariables: { answer: "x" } });
      }
      // The fresh escalation is for a PLAN subject with the SAME key but a DIFFERENT type.
      await claimEscalations(data, [taskRow({ user_task_key: "UT-PLAN", subject_type: "plan", subject_key: "o/r#1", element_id: "plan-review-decision", kind_label: "Plan review", form_key: "plan-review-decision" })], "PI-STEWARD");
    },
    async (data, completed) => {
      // The plan subject has ZERO prior resolutions of its OWN type, so the guard must NOT trip.
      assertEquals(completed.length, 1, "a different subject type sharing the key is not tripped by the other's cap");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-PLAN" });
      assertEquals(rows[0].outcome, "resolved", "the unrelated subject type resolves normally");
    },
  );
});

test("record worker: malformed (non-object) decision entries are skipped, never thrown on", async () => {
  await run(
    // `[null]` / a scalar are valid JSON but not decision objects — they must be skipped without
    // incidenting the record task (which would wedge the steward's overlap guard).
    [null, "not-an-object", { userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "ok" }, rationale: "ok", evidence: "checked" }] as unknown as Record<string, unknown>[],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      // Only the one well-formed entry is processed; the malformed ones are skipped.
      assertEquals(completed.length, 1);
      assertEquals(completed[0].userTaskKey, "UT-1");
    },
  );
});

test("record worker: a hallucinated key with no live claim held by THIS run is skipped, never recorded over the foreign claim", async () => {
  await run(
    [{ userTaskKey: "UT-FOREIGN", outcome: "resolved", choice: "retry", variables: { answer: "x" } }],
    async (data) => {
      // Claim UT-FOREIGN for a DIFFERENT steward run — this run holds no claim for it.
      await claimEscalations(data, [taskRow({ user_task_key: "UT-FOREIGN" })], "PI-OTHER");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "an unowned/foreign key is NEVER submitted");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-FOREIGN" });
      // Fail-closed: the decision is SKIPPED entirely — never recorded over the foreign claim. The
      // claim row stays a LIVE `claimed` placeholder owned by the other run (recordResolution is
      // keyed only on user_task_key, so writing here would finalise a claim this run does not own).
      assertEquals(rows[0].outcome, "claimed", "the foreign claim is left untouched, not finalised");
      assertEquals(rows[0].claimed_by, "PI-OTHER");
    },
  );
});

test("record worker: an abstained decision for a foreign key is skipped, never finalising another run's claim", async () => {
  await run(
    // An ABSTAINED decision carries no submission, but recording it would still finalise the foreign
    // claim (recordResolution overwrites the claimed placeholder keyed on user_task_key alone).
    [{ userTaskKey: "UT-FOREIGN", outcome: "abstained", rationale: "unclear" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-FOREIGN" })], "PI-OTHER");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0);
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-FOREIGN" });
      assertEquals(rows[0].outcome, "claimed", "an abstained decision for a foreign key is skipped, not recorded");
      assertEquals(rows[0].claimed_by, "PI-OTHER");
    },
  );
});

test("record worker: an overlapping tick that RECLAIMED the task mid-run is not finalised by this run's stale write (atomic CAS)", async () => {
  // The race the reviewer cited (issue #889): this run reads its claim on UT-1 and proceeds; before it
  // finalises, its lease lapses and an OVERLAPPING tick (PI-OTHER) releases + reclaims UT-1. This run's
  // recordResolution must then LOSE the owner+lease-scoped CAS — never finalise PI-OTHER's fresh claim.
  await run(
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "x" }, rationale: "ok", evidence: "checked" }],
    async (data) => {
      // This run (PI-STEWARD, the handler's processInstanceKey) claims UT-1 with an ALREADY-EXPIRED
      // lease — by the time it finalises, its claim is stale.
      await claimEscalations(data, [taskRow({})], "PI-STEWARD", -1);
      // The overlapping tick releases the expired claim and reclaims UT-1 for itself.
      const { releaseExpiredClaims } = await import("../../app/escalationSteward.ts");
      await releaseExpiredClaims(data);
      await claimEscalations(data, [taskRow({})], "PI-OTHER");
    },
    async (data, completed) => {
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      // The stale owner's finalise must NOT have overwritten the overlapping run's live claim.
      assertEquals(rows[0].outcome, "claimed", "the overlapping run's claim is not finalised by the stale owner");
      assertEquals(rows[0].claimed_by, "PI-OTHER", "the live claim still belongs to the overlapping run");
    },
  );
});

test("record worker: an EXPIRED-but-still-owned claim is RENEWED and finalised, not discarded (unbounded agent run, issue #889 review)", async () => {
  // The liveness bug the reviewer cited: the claim's 15-minute lease starts at claim time, but the
  // `senior:escalation-steward` agent has NO bounded runtime. On a long agent run the lease lapses
  // before this record step runs. Last round's owner+lease CAS then REJECTED the expired claim and
  // SKIPPED every decision, so the valid agent result was thrown away and the next tick repeated the
  // work. THIS run still owns the claim (no overlapping tick could have reclaimed it — the steward's
  // overlap guard blocks any other tick while this run is ACTIVE), so the record step must RE-ACQUIRE
  // (renew) its own lease atomically and finalise, not discard.
  await run(
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "x" }, rationale: "ok", evidence: "checked" }],
    async (data) => {
      // This run (PI-STEWARD, the handler's processInstanceKey) claims UT-1 with an ALREADY-EXPIRED
      // lease (ttlMs=-1), mimicking an agent that ran longer than the lease TTL. No overlapping tick
      // reclaims it — the row stays `claimed` by PI-STEWARD, just with a lapsed `claimed_until`.
      await claimEscalations(data, [taskRow({})], "PI-STEWARD", -1);
    },
    async (data, completed) => {
      // The decision is RENEWED + submitted, not discarded.
      assertEquals(completed.length, 1, "the owned claim is renewed and the decision is submitted");
      assertEquals(completed[0].userTaskKey, "UT-1");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "resolved", "the expired-but-owned claim is finalised, not left `claimed`");
      assertEquals(rows[0].claimed_by, null, "finalising clears the claim");
    },
  );
});

test("record worker: a destructive value smuggled in `variables` (no `choice`) is abstained", async () => {
  await run(
    // No `choice` field — the destructive option is only in the form variables (`resolution`).
    [{ userTaskKey: "UT-1", outcome: "resolved", variables: { resolution: "abandon" }, rationale: "agent chose abandon" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "a destructive option derived from variables is NEVER submitted");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "abstained");
      assert(/destructive|irreversible/i.test(rows[0].rationale ?? ""), "the rationale names the destructive guard");
    },
  );
});

test("record worker: a `resolved` decision with malformed `variables` is recorded abstained, not falsely resolved", async () => {
  await run(
    [{ userTaskKey: "UT-1", outcome: "resolved", variables: null, rationale: "claims resolved" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "no completion without valid variables");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "abstained", "fail-closed: malformed variables never record a false resolved");
      assertEquals(rows[0].submitted_variables, null);
    },
  );
});

test("record worker: agent_job_key records the ANSWERING agent's activation key, not the record task's job key", async () => {
  await run(
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "Retry." }, rationale: "ok", evidence: "ls-remote empty" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
      // The poller observed the senior:escalation-steward AGENT job (key J-AGENT) activated on this
      // steward process instance — distinct from the record task's own job key (J-1 in `run`).
      await recordAgentJobObservation(data, {
        processInstanceKey: "PI-STEWARD",
        jobType: "senior:escalation-steward",
        worker: "agent-a",
        jobKey: "J-AGENT",
        now: new Date().toISOString(),
      });
    },
    async (data, completed) => {
      assertEquals(completed.length, 1);
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(
        rows[0].agent_job_key,
        "J-AGENT",
        "provenance points at the agent job that made the decision, not the record service job (J-1)",
      );
      // The leasing worker captured in the SAME activation row is persisted too (issue #889 review) —
      // the Auto-resolutions grid's Worker column reads it, and it was always blank before.
      assertEquals(rows[0].worker, "agent-a", "the leasing worker's provenance is persisted on the record");
    },
  );
});

test("record worker: agent_job_key is NULL (never the record task's own key) when the ledger has no activation row", async () => {
  await run(
    // No recordAgentJobObservation — the best-effort poll missed the fast agent job. The fallback must
    // be an honest NULL, NOT the record service task's own job key (J-1), which is known to identify a
    // DIFFERENT job and would give the audit record confidently-wrong provenance.
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "Retry." }, rationale: "ok", evidence: "checked" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 1);
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(rows[0].agent_job_key, null, "unknown provenance stays NULL — never the record task's own key (J-1)");
      assertEquals(rows[0].worker, null, "no activation row ⇒ worker provenance stays NULL, never fabricated");
    },
  );
});

test("record worker: a `resolved` decision with no rationale/evidence is abstained (fail-closed audit record)", async () => {
  await run(
    // `resolved` but NO rationale and NO evidence — the PR's promise is a reviewable audit record for
    // every automatic resolution, so this must degrade to `abstained` (left for a human), never
    // auto-complete an escalation with no reviewable basis.
    [{ userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "x" } }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "a resolved decision with no rationale/evidence is NEVER submitted");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "abstained", "fail-closed: an unauditable resolved is abstained");
      assert(/rationale|evidence|audit/i.test(rows[0].rationale ?? ""), "the rationale names the missing audit record");
    },
  );
});

test("record worker: the SELECTED option is persisted on the record (the review surface shows what was chosen)", async () => {
  await run(
    // The chosen value is carried in the form variables (`answer`) — `selectedOption` derives it
    // host-side and the record persists it as a first-class column.
    [{ userTaskKey: "UT-1", outcome: "resolved", variables: { answer: "retry" }, rationale: "ok", evidence: "checked" }],
    async (data) => {
      await claimEscalations(data, [taskRow({})], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 1);
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(rows[0].selected_option, "retry", "the selected option is a first-class column, not buried in submitted_variables");
    },
  );
});

test("record worker: `options` snapshots the REAL form choices host-side, never the agent's self-reported array", async () => {
  await run(
    // The agent MISSTATES the choices (`options: ["only-this"]`), but the trial-merge-decision form's
    // real `action` select is [proceed, rebase, abandon]. The record must persist the host-side snapshot.
    // Uses `rebase` (the steward-safe non-override path on this red gate) so the destructive/override
    // guard doesn't abstain it — this test asserts the OPTIONS snapshot, not the override guard.
    [{ userTaskKey: "UT-TM", outcome: "resolved", variables: { action: "rebase" }, rationale: "ok", evidence: "checked", options: ["only-this"] }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-TM", element_id: "trial-merge-decision", kind_label: "Trial merge", form_key: "trial-merge-decision" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 1);
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-TM" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(
        rows[0].options,
        JSON.stringify(["proceed", "rebase", "abandon"]),
        "the record snapshots the deployed form's real choices, not the agent's self-reported array",
      );
    },
  );
});

test("record worker: a `proceed` on trial-merge-decision OVERRIDES a red integration gate — abstained, never auto-applied (issue #889 review)", async () => {
  await run(
    // On `trial-merge-decision`, `action: "proceed"` explicitly overrides a `suite-failed` D3 trial
    // merge and lets the wave continue past a RED integration gate (SPEC.md §13.2). A value-only guard
    // (`isDestructiveOption("proceed")` is false) would let the steward auto-bypass that red gate. The
    // element-aware guard must abstain it — only the non-override `rebase` path is steward-safe there.
    [{ userTaskKey: "UT-TM", outcome: "resolved", variables: { action: "proceed" }, rationale: "override the red trial", evidence: "checked" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-TM", element_id: "trial-merge-decision", kind_label: "Trial merge", form_key: "trial-merge-decision" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "a red-gate OVERRIDE (proceed on trial-merge-decision) is NEVER auto-applied");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-TM" });
      assertEquals(rows[0].outcome, "abstained", "the override is left for a human");
      assert(/override|red|destructive|irreversible/i.test(rows[0].rationale ?? ""), "the rationale names the red-gate/override guard");
    },
  );
});

test("record worker: an `abandon` on trial-merge-decision is abstained (destructive), and a `proceed` on a NON-trial-merge element is unaffected", async () => {
  await run(
    // Two decisions: (1) abandon on trial-merge-decision — destructive, abstained; (2) proceed on
    // wait-answer (a NON-trial-merge element) — the element-aware guard must NOT abstain a benign
    // `proceed` elsewhere (no over-broadening).
    [
      { userTaskKey: "UT-TM", outcome: "resolved", variables: { action: "abandon" }, rationale: "give up", evidence: "checked" },
      { userTaskKey: "UT-WA", outcome: "resolved", variables: { answer: "proceed" }, rationale: "ok", evidence: "checked" },
    ],
    async (data) => {
      await claimEscalations(data, [
        taskRow({ user_task_key: "UT-TM", element_id: "trial-merge-decision", kind_label: "Trial merge", form_key: "trial-merge-decision" }),
        taskRow({ user_task_key: "UT-WA", element_id: "wait-answer", kind_label: "PR review", form_key: "pr-escalation" }),
      ], "PI-STEWARD");
    },
    async (data, completed) => {
      // Only the benign non-trial-merge proceed is submitted; the trial-merge abandon is abstained.
      assertEquals(completed.length, 1, "the benign proceed on a non-trial-merge element is unaffected");
      assertEquals(completed[0].userTaskKey, "UT-WA");
      const tm = await escalationAutoResolutions(data).find({ user_task_key: "UT-TM" });
      assertEquals(tm[0].outcome, "abstained", "abandon on the trial merge is abstained");
      const wa = await escalationAutoResolutions(data).find({ user_task_key: "UT-WA" });
      assertEquals(wa[0].outcome, "resolved", "the benign proceed elsewhere resolves normally");
    },
  );
});

test("record worker: a foreign SAFE key must NOT shadow a destructive own-form key (selection-key bypass, issue #889 review)", async () => {
  await run(
    // The exact bypass the reviewer cited: `trial-merge-decision`'s OWN select is `action`, but the
    // decision ALSO carries a benign foreign `resolution: "rebase"`. The OLD first-nonblank sweep reads
    // `resolution` BEFORE `action` in SELECTED_VALUE_KEYS, so it judged `rebase` (safe) and SUBMITTED the
    // destructive `action: "abandon"`. The form-scoped guard must judge the own-form `action` — and the
    // two DISTINCT recognized values are a conflict, so it abstains either way and NEVER submits.
    [{ userTaskKey: "UT-TM", outcome: "resolved", variables: { resolution: "rebase", action: "abandon" }, rationale: "sneaky", evidence: "checked" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-TM", element_id: "trial-merge-decision", kind_label: "Trial merge", form_key: "trial-merge-decision" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "a destructive own-form `action` shadowed by a foreign safe `resolution` is NEVER submitted");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-TM" });
      assertEquals(rows[0].outcome, "abstained", "the conflicting/destructive decision is left for a human");
    },
  );
});

test("record worker: conflicting recognized selection fields are abstained as ambiguous (fail-closed), never guessed", async () => {
  await run(
    // Two DISTINCT recognized selection values on a form whose own select is `action` — even with both
    // individually non-destructive-looking, the ambiguity itself must fail closed (the guard cannot
    // attribute the decision to a single choice).
    [{ userTaskKey: "UT-TM", outcome: "resolved", variables: { action: "rebase", mergeDecision: "approve" }, rationale: "ambiguous", evidence: "checked" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-TM", element_id: "trial-merge-decision", kind_label: "Trial merge", form_key: "trial-merge-decision" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "an ambiguous multi-selection decision is never submitted");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-TM" });
      assertEquals(rows[0].outcome, "abstained");
      assert(/conflicting|ambiguous/i.test(rows[0].rationale ?? ""), "the rationale names the conflicting-selection fence");
    },
  );
});

test("record worker: a SINGLE safe own-form selection still resolves (the form-scoped guard does not over-abstain)", async () => {
  await run(
    // Only the own-form `action: "rebase"` (the steward-safe non-override path on trial-merge-decision),
    // no foreign key — must resolve normally, proving the scoping did not break the legitimate path.
    [{ userTaskKey: "UT-TM", outcome: "resolved", variables: { action: "rebase" }, rationale: "rerun the trial after a fix", evidence: "checked" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-TM", element_id: "trial-merge-decision", kind_label: "Trial merge", form_key: "trial-merge-decision" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 1, "a single safe own-form selection resolves normally");
      assertEquals(completed[0].userTaskKey, "UT-TM");
      assertEquals(completed[0].variables.action, "rebase");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-TM" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(rows[0].selected_option, "rebase", "the persisted selected option is the own-form value");
    },
  );
});

test("record worker: a `directive`-keyed decision records its selected option (not NULL)", async () => {
  await run(
    // The plan-review-decision form's select key is `directive` (NOT `resolution`/`action`/`decision`).
    // Before the fix, `directive` was missing from SELECTED_VALUE_KEYS, so a valid `{directive:"proceed"}`
    // resolution recorded selected_option=NULL — the review surface couldn't show what was chosen
    // (issue #889 review). The selected option must be derived from the `directive` key.
    [{ userTaskKey: "UT-PRD", outcome: "resolved", variables: { directive: "proceed" }, rationale: "plan is sound", evidence: "reviewed" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-PRD", element_id: "plan-review-decision", kind_label: "Plan review", form_key: "plan-review-decision" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 1, "a valid directive resolution is submitted");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-PRD" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(rows[0].selected_option, "proceed", "a `directive`-keyed select must record its chosen value, never NULL");
    },
  );
});

test("record worker: SELECTED_VALUE_KEYS covers EVERY escalation form's select key (drift guard)", async () => {
  // Fix-the-class guard: the selected-option / destructive guard reads the chosen value off these
  // well-known keys, so a NEW `.form` select key that is NOT in SELECTED_VALUE_KEYS would silently
  // record selected_option=NULL and let a destructive value on that key slip the guard (issue #889
  // review — `directive`/`mergeDecision` were the instances). Derive the canonical key set from the
  // deployed forms and assert the guard covers all of them.
  const formsDir = resolve(APP_ROOT, "resources", "forms");
  const { readdirSync, readFileSync } = await import("node:fs");
  const selectKeys = new Set<string>();
  for (const file of readdirSync(formsDir)) {
    if (!file.endsWith(".form")) continue;
    const doc: { components?: { type?: string; key?: string }[] } = JSON.parse(readFileSync(join(formsDir, file), "utf8"));
    for (const c of doc.components ?? []) {
      if ((c.type === "select" || c.type === "radio") && typeof c.key === "string" && c.key) selectKeys.add(c.key);
    }
  }
  const covered = new Set<string>(SELECTED_VALUE_KEYS);
  const missing = [...selectKeys].filter((k) => !covered.has(k));
  assertEquals(missing, [], `every form select key must be in SELECTED_VALUE_KEYS; missing: ${missing.join(", ")}`);
});

test("record worker: a free-text-only form key (never a select/radio anywhere) must NOT leak into SELECTED_VALUE_KEYS (inverse drift guard)", async () => {
  // Fix-the-class guard (the inverse of the drift guard above): a FREE-TEXT field (`textarea`/
  // `textfield`) that is never a `select`/`radio` in ANY form is prose, not a discrete selection. If it
  // leaks into SELECTED_VALUE_KEYS it enters the selection-CONFLICT fence, so a valid answer-path
  // payload (`{ resolution: "answer", answer: "guidance" }` — free-text `answer` beside the `resolution`
  // SELECT) presents two distinct "selection" values and is force-abstained as ambiguous, blocking the
  // supported path (issue #889 review — `answer` was wrongly in the set). Derive the free-text-only keys
  // from the forms and assert none is in SELECTED_VALUE_KEYS. (`choice` is a synthetic auxiliary hint,
  // not a form field, so it is exempt.)
  const formsDir = resolve(APP_ROOT, "resources", "forms");
  const { readdirSync, readFileSync } = await import("node:fs");
  const selectKeys = new Set<string>();
  const freeTextKeys = new Set<string>();
  for (const file of readdirSync(formsDir)) {
    if (!file.endsWith(".form")) continue;
    const doc: { components?: { type?: string; key?: string }[] } = JSON.parse(readFileSync(join(formsDir, file), "utf8"));
    for (const c of doc.components ?? []) {
      if (typeof c.key !== "string" || !c.key) continue;
      if (c.type === "select" || c.type === "radio") selectKeys.add(c.key);
      else if (c.type === "textarea" || c.type === "textfield") freeTextKeys.add(c.key);
    }
  }
  // A key that is free-text in some form AND never a select/radio anywhere is a pure free-text key.
  const pureFreeText = [...freeTextKeys].filter((k) => !selectKeys.has(k));
  const leaked = pureFreeText.filter((k) => (SELECTED_VALUE_KEYS as readonly string[]).includes(k));
  assertEquals(leaked, [], `free-text-only keys must never be in SELECTED_VALUE_KEYS (they belong in FREE_TEXT_VALUE_KEYS); leaked: ${leaked.join(", ")}`);
  // And `answer` — the one free-text accompaniment today — must be classified as free-text, not a select.
  assert((FREE_TEXT_VALUE_KEYS as readonly string[]).includes("answer"), "`answer` must be a FREE_TEXT_VALUE_KEYS member");
  assert(!(SELECTED_VALUE_KEYS as readonly string[]).includes("answer"), "`answer` (free text) must NOT be a SELECTED_VALUE_KEYS member");
});

test("record worker: a feature-escalation answer path (`resolution:answer` + free-text `answer`) RESOLVES, not abstained as a conflict (issue #889 review)", async () => {
  await run(
    // The exact High finding: on `feature-escalation` the SELECT `resolution` offers `answer` (re-dispatch
    // with guidance) and the free-text `answer` textarea carries that guidance. The prior code treated
    // `answer` as a selection key, so `{ resolution: "answer", answer: "..." }` presented two distinct
    // "selection" values (`"answer"` and the guidance prose) and was ALWAYS force-abstained as a conflict,
    // blocking a fully supported, safe escalation path. The free-text field must not enter the conflict
    // fence: the decision resolves on the `resolution` SELECT (`answer`, a safe non-destructive option).
    [{ userTaskKey: "UT-FE", outcome: "resolved", variables: { resolution: "answer", answer: "Re-run with the corrected base branch." }, rationale: "the task just needs the right base", evidence: "inspected the failing run" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-FE", element_id: "feature-escalation", kind_label: "Feature escalation", form_key: "feature-escalation" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 1, "a valid answer-path feature escalation is submitted, not abstained");
      assertEquals(completed[0].userTaskKey, "UT-FE");
      assertEquals(completed[0].variables.resolution, "answer");
      assertEquals(completed[0].variables.answer, "Re-run with the corrected base branch.");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-FE" });
      assertEquals(rows[0].outcome, "resolved", "the answer path resolves — the free-text field is not a selection conflict");
      assertEquals(rows[0].selected_option, "answer", "the selected option is the `resolution` SELECT value, not the prose");
    },
  );
});

test("record worker: a select-less form still records its free-text submitted value as selected_option", async () => {
  await run(
    // `pr-escalation` (element `wait-answer`) has NO select at all — only the free-text `answer`. With
    // `answer` out of SELECTED_VALUE_KEYS, the record must still capture the submitted prose as
    // selected_option via the free-text fallback, so the review surface shows what was submitted.
    [{ userTaskKey: "UT-WA", outcome: "resolved", variables: { answer: "proceed with the documented plan" }, rationale: "the plan is sound", evidence: "read the thread" }],
    async (data) => {
      await claimEscalations(data, [taskRow({ user_task_key: "UT-WA", element_id: "wait-answer", kind_label: "PR review", form_key: "pr-escalation" })], "PI-STEWARD");
    },
    async (data, completed) => {
      assertEquals(completed.length, 1, "a select-less free-text answer still resolves");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-WA" });
      assertEquals(rows[0].outcome, "resolved");
      assertEquals(rows[0].selected_option, "proceed with the documented plan", "the free-text submitted value is captured as selected_option");
    },
  );
});

test("record worker: a service-job RETRY after the engine completion landed recovers the prior agent completion (idempotent, never a false abstain)", async () => {
  // The completion→record pair is NOT atomic: the engine completion lands first, then the claim-row
  // finalise is a SEPARATE write. If that finalise failed transiently, the record service job is
  // retried with the user task ALREADY COMPLETED — `completeEscalationAsAgent` reports "no open
  // completable task". Before the fix the retry degraded the applied decision to `abstained`, losing
  // the submitted variables and falsely auditing an applied automatic decision as a human hand-off
  // (issue #889 review). The retry must detect the prior agent-attributed completion and finalise the
  // ORIGINAL decision idempotently.
  const dir = mkdtempSync(join(tmpdir(), "nwf-steward-rec-retry-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    // Claim UT-1 for THIS steward run.
    await claimEscalations(app.db, [taskRow({})], "PI-STEWARD");
    // Simulate the PRIOR attempt: the engine completion already landed, recorded as an AGENT
    // completion under THIS steward's agentId — but the claim-row finalise never happened (the row is
    // still `claimed`). Insert the attribution row directly (the engine call already happened).
    const agentId = "escalation-steward:PI-STEWARD";
    await taskCompletions(app.db).insert({
      user_task_key: "UT-1",
      process_instance_key: "PI-1",
      element_id: "wait-answer",
      actor_kind: "agent",
      actor_id: agentId,
      variables_json: JSON.stringify({ answer: "Retry with a note." }),
      reversible: 1,
      auto_applied: 0,
      source_adjudication_id: null,
      reverted: 0,
      reverted_by: null,
      reverted_note: null,
      reverted_at: null,
      created_at: new Date().toISOString(),
    });
    // On the retry the task is NO LONGER OPEN (already completed) — the mock engine reports no open
    // tasks, so the attributed door returns "no open completable task".
    const completed: { userTaskKey: string }[] = [];
    const engine = {
      openUserTasks: async () => [] as { userTaskKey: string }[],
      completeUserTask: (userTaskKey: string) => {
        completed.push({ userTaskKey });
        return Promise.resolve();
      },
    };
    const job = {
      jobKey: "J-1",
      processInstanceKey: "PI-STEWARD",
      variables: { resolutions: JSON.stringify([{ userTaskKey: "UT-1", outcome: "resolved", variables: { answer: "Retry with a note." }, rationale: "nothing pushed", evidence: "ls-remote empty" }]) },
    };
    await handler(job as never, { data: app.db, engine: engine as never, log: { info: () => {}, warn: () => {}, error: () => {} } } as never);
    // The retry must NOT re-complete the task NOR record a false abstain — it recovers the prior
    // agent completion and finalises the claim `resolved` with the original variables.
    assertEquals(completed.length, 0, "no SECOND engine completion on the retry");
    const rows = await escalationAutoResolutions(app.db).find({ user_task_key: "UT-1" });
    assertEquals(rows[0].outcome, "resolved", "the applied decision is recovered as resolved, not falsely abstained");
    assertEquals(JSON.parse(rows[0].submitted_variables ?? "null"), { answer: "Retry with a note." }, "the original submitted variables are recovered, not lost");
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
