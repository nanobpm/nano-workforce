// Unit coverage for pr.record-feature-implementing (issue #642) — the twin of
// `record-feature-escalation`. It runs on BOTH edges into `implement-task` (first entry + answer
// re-entry) and must flip the run to the non-terminal `running` status so `escalated` holds ONLY
// while parked on the native `feature-escalation` user task. Without it, the answer loop-back left
// `feature_runs.status` a stale `escalated` through the whole re-implementation (the #632 tear).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory app double, mirrors record-feature-escalation.worker.test
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

test("record-feature-implementing: resets an escalated run back to running on the answer re-entry", async () => {
  // The answer loop-back routes through this task before re-dispatching implement-task; it must clear
  // the stale `escalated` the run parked on so the Overview no longer reads it as escalated while it
  // re-implements (issue #642 — the #632 tear).
  const rows = [{ feature_key: "owner/repo#7", status: "escalated", updated_at: "2025-01-01T00:00:00.000Z" }];
  const app = fakeApp(rows);
  const out = await handler({ jobKey: "job-1", variables: { featureKey: "owner/repo#7" } } as never, app);
  assertEquals(out, {});
  assertEquals(rows[0].status, "running");
  assertEquals(rows[0].updated_at !== "2025-01-01T00:00:00.000Z", true, "updated_at was refreshed");
});

test("record-feature-implementing: a confirming write on the first entry (already running) is a no-op", async () => {
  // On `f_toImplement` (first entry) the row is already `running` from dispatch — re-stamping is a
  // harmless idempotent confirming write, so a retried at-least-once job never regresses the status.
  const rows = [{ feature_key: "owner/repo#8", status: "running" }];
  const app = fakeApp(rows);
  await handler({ jobKey: "job-8", variables: { featureKey: "owner/repo#8" } } as never, app);
  assertEquals(rows[0].status, "running");
});
