// Unit coverage for pr.record-feature-escalation — a feature run parked on the native
// `feature-escalation` user task (issue #210). Runs on the `escalated` arm, before the user task
// exists, and must flip the row to the non-terminal `escalated` status and persist the agent's
// `question` so the nwf UI can surface it (the poller can't read task-local vars, so this is the
// question's source of truth). It must NOT touch the completable-task pointer (unknown here — the
// poller fills it once the task is observable).
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
  // The user task does not exist yet — the pointer is the poller's to fill, not this worker's.
  assertEquals(rows[0].escalation_user_task_key, null);
});

test("record-feature-escalation: a blank/absent question is persisted as NULL (badge/affordance stay off)", async () => {
  const rows = [{ feature_key: "owner/repo#8", status: "running", escalation_question: null }];
  const app = fakeApp(rows);
  await handler({ variables: { featureKey: "owner/repo#8", question: "   " } } as never, app);
  assertEquals(rows[0].status, "escalated");
  assertEquals(rows[0].escalation_question, null);
});
