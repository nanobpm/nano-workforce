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
    data: {
      table(name: string, key: string) {
        const store = (stores[name] ??= []);
        return {
          // biome-ignore lint/suspicious/noExplicitAny: test double
          get: (k: any) => Promise.resolve(store.find((r) => r[key] === k)),
          // biome-ignore lint/suspicious/noExplicitAny: test double
          find: (q: any) => Promise.resolve(store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
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
    { variables: { featureKey: "owner/repo#7", question: "Which API should I use?" } } as never,
    app,
  );
  assertEquals(out, {});
  assertEquals(rows[0].status, "escalated");
  assertEquals(rows[0].escalation_question, "Which API should I use?");
  // The user task does not exist yet — the pointer is cleared to NULL here (poller fills the real key).
  assertEquals(rows[0].escalation_user_task_key, null);
});

test("record-feature-escalation: clears a stale completable-task pointer at escalation entry", async () => {
  // The task does not exist yet here, so a non-null key can only be stale (a prior escalation's key
  // left behind, a manual DB repair, etc). Leaving it would bind the pages' answer/abandon affordance
  // to the wrong task until the poller overwrites it; clear it so the row reads "key unknown here".
  const rows = [{ feature_key: "owner/repo#9", status: "running", escalation_question: null, escalation_user_task_key: "stale-ut" }];
  const app = fakeApp(rows);
  await handler({ variables: { featureKey: "owner/repo#9", question: "Q?" } } as never, app);
  assertEquals(rows[0].status, "escalated");
  assertEquals(rows[0].escalation_question, "Q?");
  assertEquals(rows[0].escalation_user_task_key, null);
});

test("record-feature-escalation: a blank/absent question is persisted as NULL (badge/affordance stay off)", async () => {
  const rows = [{ feature_key: "owner/repo#8", status: "running", escalation_question: null }];
  const app = fakeApp(rows);
  await handler({ variables: { featureKey: "owner/repo#8", question: "   " } } as never, app);
  assertEquals(rows[0].status, "escalated");
  assertEquals(rows[0].escalation_question, null);
});
