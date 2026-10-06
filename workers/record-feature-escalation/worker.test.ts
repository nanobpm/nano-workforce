// Unit coverage for pr.record-feature-escalation — the shared `implement-cell`'s escalation recorder
// (ADR 0006 S4). It runs on the cell's `escalated` arm for BOTH callers of the cell: a standalone
// `feature` run (`subjectKey` = its `feature_key`, which HAS a `feature_runs` row to flip to
// `escalated`) and a plan-fanout wave slice (`subjectKey` = the epic's `plan_key`, which has NO
// `feature_runs` row — the flip must be a guarded no-op there). In both cases it appends the resolved
// `question` to the canonical `feature_escalations` audit log (the poller can't read task-local vars,
// so this is the question's source of truth) and re-emits it, synthesising an answerable one via the
// #360 no-result net when the agent left none.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler, { NO_RESULT_QUESTION } from "./worker.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory app double, mirrors record-blocked-ack.worker.test
function fakeApp(rows: Record<string, unknown>[]): any {
  const stores: Record<string, Record<string, unknown>[]> = { feature_runs: rows };
  return {
    stores,
    data: {
      table(name: string, key: string) {
        const store = (stores[name] ??= []);
        return {
          // biome-ignore lint/suspicious/noExplicitAny: test double
          get: (k: any) => Promise.resolve(store.find((r) => r[key] === k)),
          // biome-ignore lint/suspicious/noExplicitAny: test double
          find: (q: any) => Promise.resolve(store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
          // biome-ignore lint/suspicious/noExplicitAny: test double
          findOne: (q: any) =>
            Promise.resolve(store.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
          // biome-ignore lint/suspicious/noExplicitAny: test double
          insert: (row: any) => {
            store.push(row);
            return Promise.resolve(store.length);
          },
          // biome-ignore lint/suspicious/noExplicitAny: test double
          update: (k: any, patch: any) => {
            const row = store.find((r) => r[key] === k);
            if (row) Object.assign(row, patch);
            return Promise.resolve(row);
          },
        };
      },
    },
    log: noopLog(),
  };
}

test("feature subject: flips the run to escalated, appends the agent's question, and re-emits it", async () => {
  const rows = [{ feature_key: "owner/repo#7", status: "running" }];
  const app = fakeApp(rows);
  const out = await handler(
    {
      jobKey: "job-1",
      variables: { subjectKey: "owner/repo#7", status: "escalated", question: "Which API should I use?" },
    } as never,
    app,
  );
  assertEquals(out, { question: "Which API should I use?" });
  assertEquals(rows[0].status, "escalated");
  // Issue #305/#332: the question is the sole responsibility of the canonical `feature_escalations`
  // audit log so `pollUserTasks` can source it from a surviving table (the denormalised column is gone).
  assertEquals(app.stores.feature_escalations.length, 1);
  assertEquals(app.stores.feature_escalations[0].feature_key, "owner/repo#7");
  assertEquals(app.stores.feature_escalations[0].question, "Which API should I use?");
  assertEquals(app.stores.feature_escalations[0].job_key, "job-1");
});

test("wave subject (no feature_runs row): the status flip is a guarded no-op, the audit row is still keyed by planKey", async () => {
  // A plan-embedded wave slice's `subjectKey` is the epic's `plan_key`; there is NO standalone
  // `feature_runs` row, so the escalated-status flip must be a no-op (never fabricating a bogus row),
  // while the question is still appended keyed by the plan for the poller to surface.
  const app = fakeApp([]);
  const out = await handler(
    {
      jobKey: "job-w",
      variables: { subjectKey: "owner/repo#1", status: "escalated", question: "Rebase or rework?" },
    } as never,
    app,
  );
  assertEquals(out, { question: "Rebase or rework?" });
  assertEquals(app.stores.feature_runs.length, 0, "no feature_runs row is fabricated for a wave subject");
  assertEquals(app.stores.feature_escalations.length, 1);
  assertEquals(app.stores.feature_escalations[0].feature_key, "owner/repo#1");
  assertEquals(app.stores.feature_escalations[0].question, "Rebase or rework?");
});

test("no-result: a missing status/question synthesises the #360 answerable question and re-emits it", async () => {
  // The implement stage was the only agent stage with no net for "I couldn't read the agent's result".
  // A non-clean-terminal slice with no machine-readable status routes onto the SAME escalation task, so
  // a human can enrol the PR or abandon the slice instead of the epic dying with a blank reason.
  const rows = [{ feature_key: "owner/repo#8", status: "running" }];
  const app = fakeApp(rows);
  const out = await handler({ jobKey: "job-8", variables: { subjectKey: "owner/repo#8" } } as never, app);
  assertEquals(out, { question: NO_RESULT_QUESTION });
  assertEquals(rows[0].status, "escalated");
  assertEquals(app.stores.feature_escalations.length, 1);
  assertEquals(app.stores.feature_escalations[0].question, NO_RESULT_QUESTION);
});

test("blank-question escalated: synthesises an ACCURATE reported-status reason, not the false no-result text (#865 review)", async () => {
  // A reported `escalated` with a blank question reaches the builder. It must name the reported status
  // accurately — never the false "no status was reported" (no-result) diagnosis — and never dead-end.
  const app = fakeApp([]);
  const out = await handler(
    { jobKey: "job-b", variables: { subjectKey: "owner/repo#2", status: "escalated", question: "   " } } as never,
    app,
  );
  assertEquals(out.question.includes('reported status "escalated"'), true);
  assertEquals(out.question.includes("gave no answerable question"), true);
  assertEquals(out.question.includes("without a machine-readable result"), false);
  assertEquals(app.stores.feature_escalations[0].question, out.question);
});

test("escalated with a question + summary + transcript: preserves ALL context, not just the question (#865 review)", async () => {
  // The #865-review defect: an `escalated` result carrying a question, summary, and transcript persisted
  // ONLY the question, leaving pollUserTasks without the supporting decision context.
  const rows = [{ feature_key: "owner/repo#9", status: "running" }];
  const app = fakeApp(rows);
  const out = await handler(
    {
      jobKey: "job-9",
      variables: {
        subjectKey: "owner/repo#9",
        status: "escalated",
        question: "Should I target the epic base or main?",
        summary: "drafted the migration but the base is ambiguous",
        transcriptUrl: "http://merlin.local:3000/t?stream=job%3A777",
      },
    } as never,
    app,
  );
  assertEquals(out.question.startsWith("Should I target the epic base or main?"), true);
  assertEquals(out.question.includes('The agent\'s own summary: "drafted the migration but the base is ambiguous".'), true);
  assertEquals(out.question.includes("Transcript: http://merlin.local:3000/t?stream=job%3A777"), true);
  assertEquals(rows[0].status, "escalated");
  assertEquals(app.stores.feature_escalations[0].question, out.question);
});

test("fails fast (incident) when subjectKey is absent — never appends a corrupt undefined-keyed audit row", async () => {
  // The cell's escalation arm always supplies `subjectKey` (the callActivity input), so a missing key
  // can only mean the `implement-cell` ioMapping/dataEnvelope regressed. The worker must raise an
  // incident (throw) rather than keying `feature_escalations`/`feature_runs` with `undefined` and
  // masking the regression — symmetric with `record-feature-implementing`'s fail-fast guard (#642).
  const app = fakeApp([]);
  await assertRejects(() => handler({ jobKey: "job-x", variables: {} } as never, app));
  assertEquals(app.stores.feature_escalations, undefined, "no audit row is appended when subjectKey is absent");
});

test("a retried job (same jobKey) reuses its audit row, never duplicating", async () => {
  // `record-feature-escalation` is at-least-once: a job that crashed/timed out AFTER the insert but
  // before job completion re-runs with the SAME jobKey. The `job_key` idempotency guard must reuse the
  // existing `feature_escalations` row rather than append a duplicate (mirrors `record-plan-review`).
  const rows = [{ feature_key: "owner/repo#7", status: "running" }];
  const app = fakeApp(rows);
  const job = {
    jobKey: "job-retry",
    variables: { subjectKey: "owner/repo#7", status: "escalated", question: "Which API?" },
  } as never;
  await handler(job, app);
  await handler(job, app); // retry with the same jobKey
  assertEquals(app.stores.feature_escalations.length, 1, "the retry reuses the row, no duplicate append");
  assertEquals(app.stores.feature_escalations[0].job_key, "job-retry");
});

test("claimed-completion (off-vocabulary status) with no question: accurate reason, not the false no-result text (issue #865)", async () => {
  // The #865 defect reproduction: the agent reported `status: "completed"` with a summary but no PR.
  // The synthesised reason must name the reported status + fold in the summary and transcript link —
  // never the false "no status was reported" diagnosis.
  const rows = [{ feature_key: "owner/repo#41", status: "running" }];
  const app = fakeApp(rows);
  const out = await handler(
    {
      jobKey: "job-41",
      variables: {
        subjectKey: "owner/repo#41",
        status: "completed",
        summary: "implemented src/pin.rs and supporting changes",
        transcriptUrl: "http://merlin.local:3000/t?stream=job%3A215572",
      },
    } as never,
    app,
  );
  assertEquals(out.question.includes('reported status "completed"'), true);
  assertEquals(out.question.includes("without a machine-readable result"), false);
  assertEquals(out.question.includes('The agent\'s own summary: "implemented src/pin.rs and supporting changes".'), true);
  assertEquals(out.question.includes("Transcript: http://merlin.local:3000/t?stream=job%3A215572"), true);
  assertEquals(rows[0].status, "escalated");
  assertEquals(app.stores.feature_escalations[0].question, out.question);
});
