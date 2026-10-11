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
import { claimEscalations, escalationAutoResolutions, LOOP_GUARD_MAX_RESOLUTIONS, recordResolution } from "../../app/escalationSteward.ts";
import type { UserTaskRow } from "../../app/userTasks.ts";
import handler from "./worker.ts";

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
          .map((c) => ({ userTaskKey: c.user_task_key, elementId: "wait-answer", processInstanceKey: "PI-1" }));
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

test("record worker: malformed (non-object) decision entries are skipped, never thrown on", async () => {
  await run(
    // `[null]` / a scalar are valid JSON but not decision objects — they must be skipped without
    // incidenting the record task (which would wedge the steward's overlap guard).
    [null, "not-an-object", { userTaskKey: "UT-1", outcome: "resolved", choice: "retry", variables: { answer: "ok" } }] as unknown as Record<string, unknown>[],
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

test("record worker: a hallucinated key with no live claim held by THIS run is abstained, never submitted", async () => {
  await run(
    [{ userTaskKey: "UT-FOREIGN", outcome: "resolved", choice: "retry", variables: { answer: "x" } }],
    async (data) => {
      // Claim UT-FOREIGN for a DIFFERENT steward run — this run holds no claim for it.
      await claimEscalations(data, [taskRow({ user_task_key: "UT-FOREIGN" })], "PI-OTHER");
    },
    async (data, completed) => {
      assertEquals(completed.length, 0, "an unowned/foreign key is NEVER submitted");
      const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-FOREIGN" });
      // Fail-closed: the decision is recorded `abstained` (the escalation is left for a human), and the
      // claim placeholder is finalised so it never lingers as a live claim.
      assertEquals(rows[0].outcome, "abstained");
      assert(/no live claim|unclaimed|foreign/i.test(rows[0].rationale ?? ""), "the rationale names the ownership fence");
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
