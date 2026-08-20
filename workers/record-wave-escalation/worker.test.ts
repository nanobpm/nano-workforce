// Unit coverage for pr.record-wave-escalation — the plan-fanout implement-stage escalation net (issue
// #360). It runs on the `w_gw` "clean terminal?" gateway's `not clean` arm, BEFORE the shared
// `feature-escalation` user task, and must:
//   • pass through the agent's own answerable question when it declared a genuine escalation, but
//   • SYNTHESISE an answerable question when the agent left none (a no-machine-readable result) so the
//     parked task is never a dead end — the fix for the silent epic-death this issue reports, and
//   • append the resolved question to the canonical `feature_escalations` audit log keyed by `planKey`
//     (the plan-root IS the subject of an embedded slice), the source `pollUserTasks` reads (issue #358),
//   • re-emit the resolved `question` so the `feature-escalation` form and the answer loop see it.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler, { NO_RESULT_QUESTION } from "./worker.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory app double, mirrors record-feature-escalation.worker.test
function fakeApp(): any {
  const stores: Record<string, Record<string, unknown>[]> = {};
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

test("record-wave-escalation: a no-machine-readable result synthesises an answerable question and audits it (issue #360)", async () => {
  const app = fakeApp();
  // The agent finished with no status and no question — the exact failure that used to fall straight to
  // terminal `blocked` and silently kill the epic. It must now become an answerable escalation.
  const out = await handler(
    { jobKey: "job-1", variables: { planKey: "owner/repo#64", status: undefined, question: undefined } } as never,
    app,
  );

  assertEquals(out, { question: NO_RESULT_QUESTION });
  assertEquals(app.stores.feature_escalations.length, 1);
  assertEquals(app.stores.feature_escalations[0].feature_key, "owner/repo#64");
  assertEquals(app.stores.feature_escalations[0].question, NO_RESULT_QUESTION);
  assertEquals(app.stores.feature_escalations[0].job_key, "job-1");
});

test("record-wave-escalation: a genuine agent escalation passes its own question through unchanged (issue #360)", async () => {
  const app = fakeApp();
  const out = await handler(
    { jobKey: "job-2", variables: { planKey: "owner/repo#64", status: "escalated", question: "Which auth library should the scaffold use?" } } as never,
    app,
  );

  assertEquals(out, { question: "Which auth library should the scaffold use?" });
  assertEquals(app.stores.feature_escalations[0].question, "Which auth library should the scaffold use?");
});

test("record-wave-escalation: an escalated status with a blank question is still given an answerable one (issue #360)", async () => {
  // `escalated` with no usable question is as much a dead end as a no-result — the taxonomy classes it a
  // NON-escalation, so without synthesis the parked task would show nothing to decide. Synthesise instead.
  const app = fakeApp();
  const out = await handler(
    { jobKey: "job-3", variables: { planKey: "owner/repo#64", status: "escalated", question: "   " } } as never,
    app,
  );

  assertEquals(out, { question: NO_RESULT_QUESTION });
  assertEquals(app.stores.feature_escalations[0].question, NO_RESULT_QUESTION);
});

test("record-wave-escalation: a retried job (same jobKey) reuses its audit row, never duplicating (issue #360)", async () => {
  const app = fakeApp();
  const job = { jobKey: "job-retry", variables: { planKey: "owner/repo#64", status: undefined, question: undefined } } as never;
  await handler(job, app);
  await handler(job, app);
  assertEquals(app.stores.feature_escalations.length, 1, "the retry reuses the row, no duplicate append");
});
