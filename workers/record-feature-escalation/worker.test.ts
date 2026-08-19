// Unit coverage for pr.record-feature-escalation — a feature run parked on the native
// `feature-escalation` user task (issue #210). Runs on the `escalated` arm, before the user task
// exists, and must flip the row to the non-terminal `escalated` status and append the agent's
// `question` to the canonical `feature_escalations` audit log so the nwf UI can surface it (the poller
// can't read task-local vars, so this is the question's source of truth). Issue #332 dropped the
// denormalised `feature_runs.escalation_question` / `escalation_user_task_key` columns, so this worker
// now only flips the status and appends the audit row.
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

test("record-feature-escalation: flips the run to escalated and appends the question to the audit log", async () => {
  const rows = [{ feature_key: "owner/repo#7", status: "running" }];
  const app = fakeApp(rows);
  const out = await handler(
    { jobKey: "job-1", variables: { featureKey: "owner/repo#7", question: "Which API should I use?" } } as never,
    app,
  );
  assertEquals(out, {});
  assertEquals(rows[0].status, "escalated");
  // Issue #305/#332: the question is the sole responsibility of the canonical `feature_escalations`
  // audit log so `pollUserTasks` can source it from a surviving table (the denormalised column is gone).
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
  const rows = [{ feature_key: "owner/repo#7", status: "running" }];
  const app = fakeApp(rows);
  const job = { jobKey: "job-retry", variables: { featureKey: "owner/repo#7", question: "Which API?" } } as never;
  await handler(job, app);
  await handler(job, app); // retry with the same jobKey
  assertEquals(app.stores.feature_escalations.length, 1, "the retry reuses the row, no duplicate append");
  assertEquals(app.stores.feature_escalations[0].job_key, "job-retry");
});

test("record-feature-escalation: a blank/absent question is appended as NULL (badge/affordance stay off)", async () => {
  const rows = [{ feature_key: "owner/repo#8", status: "running" }];
  const app = fakeApp(rows);
  await handler({ jobKey: "job-8", variables: { featureKey: "owner/repo#8", question: "   " } } as never, app);
  assertEquals(rows[0].status, "escalated");
  assertEquals(app.stores.feature_escalations.length, 1);
  assertEquals(app.stores.feature_escalations[0].question, null);
});
