// Unit coverage for pr.record-feature-escalation — a feature run parked on the native
// `feature-escalation` user task (issue #210). Runs on the `escalated` arm, before the user task
// exists, and must flip the row to the non-terminal `escalated` status and persist the agent's
// `question` so the nwf UI can surface it (the poller can't read task-local vars, so this is the
// question's source of truth). It clears the completable-task pointer to NULL (the task does not
// exist yet, so any non-null value is stale); the poller fills the real key once it is observable.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

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

test("record-feature-escalation: flips the run to escalated and persists the question", async () => {
  const rows = [{ feature_key: "owner/repo#7", status: "running", escalation_question: null, escalation_user_task_key: null }];
  const app = fakeApp(rows);
  const out = await handler(
    { jobKey: "job-1", variables: { featureKey: "owner/repo#7", question: "Which API should I use?" } } as never,
    app,
  );
  assertEquals(out, {});
  assertEquals(rows[0].status, "escalated");
  assertEquals(rows[0].escalation_question, "Which API should I use?");
  // The user task does not exist yet — the pointer is cleared to NULL here (poller fills the real key).
  assertEquals(rows[0].escalation_user_task_key, null);
  // Dual-write (issue #305): the question is ALSO appended to the canonical `feature_escalations`
  // audit log so `pollUserTasks` can source it from a surviving table once the denormalised column drops.
  assertEquals(app.stores.feature_escalations.length, 1);
  assertEquals(app.stores.feature_escalations[0].feature_key, "owner/repo#7");
  assertEquals(app.stores.feature_escalations[0].question, "Which API should I use?");
  assertEquals(app.stores.feature_escalations[0].job_key, "job-1");
});

test("record-feature-escalation: a retried job (same jobKey) reuses its audit row, never duplicating", async () => {
  // `record-feature-escalation` is at-least-once: a job that crashed/timed out AFTER the insert but
  // before job completion re-runs with the SAME jobKey. The `job_key` idempotency guard must reuse the
  // existing `feature_escalations` row rather than append a duplicate (which would bloat the append-only
  // log and could skew "latest question" selection). Mirrors `record-plan-review`'s `plan_reviews` guard.
  const rows = [{ feature_key: "owner/repo#7", status: "running", escalation_question: null, escalation_user_task_key: null }];
  const app = fakeApp(rows);
  const job = { jobKey: "job-retry", variables: { featureKey: "owner/repo#7", question: "Which API?" } } as never;
  await handler(job, app);
  await handler(job, app); // retry with the same jobKey
  assertEquals(app.stores.feature_escalations.length, 1, "the retry reuses the row, no duplicate append");
  assertEquals(app.stores.feature_escalations[0].job_key, "job-retry");
});

test("record-feature-escalation: clears a stale completable-task pointer at escalation entry", async () => {
  // The task does not exist yet here, so a non-null key can only be stale (a prior escalation's key
  // left behind, a manual DB repair, etc). Leaving it would bind the pages' answer/abandon affordance
  // to the wrong task until the poller overwrites it; clear it so the row reads "key unknown here".
  const rows = [{ feature_key: "owner/repo#9", status: "running", escalation_question: null, escalation_user_task_key: "stale-ut" }];
  const app = fakeApp(rows);
  await handler({ jobKey: "job-9", variables: { featureKey: "owner/repo#9", question: "Q?" } } as never, app);
  assertEquals(rows[0].status, "escalated");
  assertEquals(rows[0].escalation_question, "Q?");
  assertEquals(rows[0].escalation_user_task_key, null);
});

test("record-feature-escalation: a blank/absent question is persisted as NULL (badge/affordance stay off)", async () => {
  const rows = [{ feature_key: "owner/repo#8", status: "running", escalation_question: null }];
  const app = fakeApp(rows);
  await handler({ jobKey: "job-8", variables: { featureKey: "owner/repo#8", question: "   " } } as never, app);
  assertEquals(rows[0].status, "escalated");
  assertEquals(rows[0].escalation_question, null);
});
