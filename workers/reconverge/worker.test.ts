// pr.reconverge (issue #939): findings on a head-current review hand the PR back to the ONE canonical
// convergence entry (`submitPr`), declaring the merge-loop instance as the hand-off source.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { makeHandler, type Submit } from "./worker.ts";

test("re-submits through submitPr with auto-merge on and handoffFrom = this merge-loop instance", async () => {
  const merges: Record<string, unknown>[] = [];
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 1 } : undefined),
        insert: async (r: Record<string, unknown>) => (merges.push(r), 1),
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let args: unknown[] = [];
  const submit = (async (...a: unknown[]) => {
    args = a;
    return { prKey: "acme/w#7" };
  }) as unknown as Submit;
  await makeHandler(submit)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals((args[2] as { prKey: string }).prKey, "acme/w#7");
  assertEquals(args[7], false, "no re-gate on human approval");
  assertEquals(args[8], true, "steward opt-in carried from the row");
  assertEquals(args[9], true, "auto-merge stays on");
  assertEquals(args[10], "4242", "hand-off source is this merge-loop instance");
  assertEquals(merges[0].outcome, "reconverge");
});
