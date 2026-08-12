import { test } from "node:test";
import { assertEquals } from "#test-assert";
import {
  recordTrialMergeAudit,
  resolveTrialMergeAttention,
  shouldRunTrialMerge,
  trialMergeDecision,
  trialMergeWaveFromTaskId,
} from "./trialMerge.ts";

test("trialMergeDecision only escalates clean-merge suite failures", () => {
  assertEquals(trialMergeDecision("clean"), "proceed");
  assertEquals(trialMergeDecision("merge-conflict"), "proceed");
  assertEquals(trialMergeDecision("suite-failed"), "escalate");
});

test("shouldRunTrialMerge skips lone heads and mergify queues", () => {
  assertEquals(shouldRunTrialMerge(0, { land: { method: "gh-merge" } }), false);
  assertEquals(shouldRunTrialMerge(1, { land: { method: "gh-merge" } }), false);
  assertEquals(shouldRunTrialMerge(2, { land: { method: "mergify-queue" } }), false);
  assertEquals(shouldRunTrialMerge(2, { land: { method: "gh-merge" } }), true);
});

// In-memory `plan_trial_merges` table backing the audit-resolution tests.
function memData() {
  const rows: any[] = [];
  let nextId = 1;
  const table = {
    async insert(row: any) {
      const r = { id: nextId++, ...row };
      rows.push(r);
      return r.id;
    },
    async find(where: any = {}) {
      return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).map((r) => ({ ...r }));
    },
    async update(id: any, patch: any) {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
  };
  const data = { table: () => table } as any;
  return { data, rows };
}

test("recordTrialMergeAudit supersedes prior rows for the same wave", async () => {
  const { data, rows } = memData();
  // Wave 1 fails, then re-runs clean; wave 2 is independent.
  const first = await recordTrialMergeAudit(data, { planKey: "o/r#1", wave: 1, result: "suite-failed" });
  await recordTrialMergeAudit(data, { planKey: "o/r#1", wave: 2, result: "suite-failed" });
  const rerun = await recordTrialMergeAudit(data, { planKey: "o/r#1", wave: 1, result: "clean" });

  const byId = (id: number) => rows.find((r) => r.id === id);
  assertEquals(byId(first).resolved, 1, "the superseded wave-1 red row is resolved");
  assertEquals(byId(rerun).resolved, 0, "the fresh wave-1 row stays unresolved");
  // The unrelated wave-2 row is untouched (still needs attention).
  assertEquals(rows.filter((r) => r.wave === 2)[0].resolved, 0);
});

test("recordTrialMergeAudit updates a re-reporting job in place without superseding", async () => {
  const { data, rows } = memData();
  const id = await recordTrialMergeAudit(data, { planKey: "o/r#1", wave: 1, result: "suite-failed", jobKey: "j1" });
  const again = await recordTrialMergeAudit(data, { planKey: "o/r#1", wave: 1, result: "clean", jobKey: "j1" });
  assertEquals(again, id, "the same job_key updates its row in place");
  assertEquals(rows.length, 1, "no duplicate/supersede row is created");
  assertEquals(rows[0].result, "clean");
  assertEquals(rows[0].resolved, 0);
});

test("resolveTrialMergeAttention clears every unresolved row for the wave", async () => {
  const { data, rows } = memData();
  await recordTrialMergeAudit(data, { planKey: "o/r#1", wave: 1, result: "suite-failed" });
  await recordTrialMergeAudit(data, { planKey: "o/r#1", wave: 3, result: "suite-failed" });
  const cleared = await resolveTrialMergeAttention(data, "o/r#1", 1);
  assertEquals(cleared, 1);
  assertEquals(rows.filter((r) => r.wave === 1)[0].resolved, 1);
  assertEquals(rows.filter((r) => r.wave === 3)[0].resolved, 0, "another wave is untouched");
  // Idempotent: a second call resolves nothing new.
  assertEquals(await resolveTrialMergeAttention(data, "o/r#1", 1), 0);
});

test("trialMergeWaveFromTaskId parses only trial-merge task ids", () => {
  assertEquals(trialMergeWaveFromTaskId("trial-merge-wave-2"), 2);
  assertEquals(trialMergeWaveFromTaskId("trial-merge-wave-0"), 0);
  assertEquals(trialMergeWaveFromTaskId("some-feature-task"), null);
  assertEquals(trialMergeWaveFromTaskId("trial-merge-wave-x"), null);
  // Empty suffix must not silently map to wave 0 (Number("") === 0).
  assertEquals(trialMergeWaveFromTaskId("trial-merge-wave-"), null);
  // Non-integer / signed / whitespace suffixes are rejected.
  assertEquals(trialMergeWaveFromTaskId("trial-merge-wave-1.5"), null);
  assertEquals(trialMergeWaveFromTaskId("trial-merge-wave-+2"), null);
  assertEquals(trialMergeWaveFromTaskId("trial-merge-wave-12"), 12);
});
