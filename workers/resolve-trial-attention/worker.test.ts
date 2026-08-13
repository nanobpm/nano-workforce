import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { recordTrialMergeAudit, resolveTrialMergeAttention } from "../../app/trialMerge.ts";
import handler from "./worker.ts";

// In-memory DataLayer.table shim backing `plan_trial_merges` for the audit helpers.
function fakeApp() {
  const rows: any[] = [];
  let nextId = 1;
  const table = {
    async find(q: Record<string, unknown>) {
      return rows.filter((r) => Object.entries(q).every(([k, v]) => r[k] === v));
    },
    async insert(row: Record<string, unknown>) {
      const id = nextId++;
      rows.push({ id, ...row });
      return id;
    },
    async update(id: number, patch: Record<string, unknown>) {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
  };
  const app = {
    data: { table: (_name: string, _key: string) => table },
    log: noopLog(),
  };
  return { app, rows };
}

// Red/green regression: a `proceed` override on a trial-merge escalation records NO re-run row, so
// without this serviceTask the wave's red `plan_trial_merges` audit row stays unresolved forever in
// the epic page's "Needs attention" tab (the caller was dropped in the userTask refactor). The
// worker must clear it. (Confirmed red against a no-op handler.)
test("resolve-trial-attention clears the wave's unresolved audit rows", async () => {
  const { app, rows } = fakeApp();
  await recordTrialMergeAudit(app.data as any, {
    planKey: "o/r#69",
    wave: 2,
    result: "suite-failed",
    summary: "combined suite red",
  });
  // A different wave must be left untouched.
  await recordTrialMergeAudit(app.data as any, { planKey: "o/r#69", wave: 3, result: "suite-failed" });

  assertEquals(rows.filter((r) => r.wave === 2 && r.resolved !== 1).length, 1);

  await handler(
    { key: 1, variables: { planKey: "o/r#69", currentWave: 2 } } as any,
    app as any,
  );

  assertEquals(rows.filter((r) => r.wave === 2 && r.resolved !== 1).length, 0);
  // Wave 3 is a distinct escalation and must remain unresolved.
  assertEquals(rows.filter((r) => r.wave === 3 && r.resolved !== 1).length, 1);
  // Idempotent: a follow-up (e.g. rebase re-entry) clears nothing new.
  assertEquals(await resolveTrialMergeAttention(app.data as any, "o/r#69", 2), 0);
});

test("resolve-trial-attention never throws when cleanup fails", async () => {
  const app = {
    data: {
      table: () => ({
        find: async () => {
          throw new Error("db down");
        },
        insert: async () => 1,
        update: async () => {},
      }),
    },
    log: noopLog(),
  };
  // Best-effort/cosmetic: a transient failure must not wedge the plan.
  const out = await handler({ key: 2, variables: { planKey: "o/r#1", currentWave: 0 } } as any, app as any);
  assertEquals(out, {});
});
