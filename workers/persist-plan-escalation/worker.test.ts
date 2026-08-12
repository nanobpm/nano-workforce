import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

function fakeApp(escalations: any[] = []) {
  const plans = [{ plan_key: "owner/repo#12", status: "dispatched" }];
  const match = (r: Record<string, unknown>, q: Record<string, unknown>) =>
    Object.entries(q).every(([f, v]) => r[f] === v);
  const table = (rows: any[], key: string) => ({
    find: (q: any) => Promise.resolve(rows.filter((r) => match(r, q))),
    insert: (row: any) => {
      row.id = row.id ?? rows.length + 1;
      rows.push(row);
      return Promise.resolve(row.id);
    },
    update: (id: any, patch: any) => {
      const row = rows.find((r) => r[key] === id);
      if (row) Object.assign(row, patch);
      return Promise.resolve(row);
    },
  });
  return {
    data: {
      table(name: string) {
        return name === "plans" ? table(plans, "plan_key") : table(escalations, "id");
      },
    },
    log: noopLog(),
    _plans: plans,
    _escalations: escalations,
  } as any;
}

test("records an open plan-review escalation and surfaces it on the plan", async () => {
  const app = fakeApp();
  const out = await handler({
    variables: {
      planKey: "owner/repo#12",
      planReviewEpoch: 1,
      planReviewRound: 2,
      planFindings: "needs a seam",
    },
    jobKey: "j1",
  } as any, app as any);

  assertEquals(out.planEscalationId, 1);
  assertEquals(app._escalations[0].plan_key, "owner/repo#12");
  assertEquals(app._escalations[0].epoch, 1);
  assertEquals(app._escalations[0].round, 2);
  assertEquals(app._escalations[0].findings, "needs a seam");
  assertEquals(app._plans[0].open_plan_escalation_id, 1);
  assertEquals(app._plans[0].open_plan_findings, "needs a seam");
  assertEquals(app._plans[0].status, "planning");
});
