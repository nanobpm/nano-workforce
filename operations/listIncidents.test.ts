// Tests for GET /app/api/incidents operation `listIncidents` (issue #931): the incident projection
// lists every mirrored ACTIVE incident (PR + delivery-graph rows) with its retry remedy, oldest first.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./listIncidents.ts";

function memApp(stores: Record<string, Record<string, unknown>[]>): AppApi {
  const app = {
    data: { table: (n: string) => ({ all: async () => [...(stores[n] ?? [])] }) },
    log: noopLog(),
    // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
  } as any as AppApi;
  return app;
}

// biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
async function call(app: AppApi): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return (await handler({ req: { headers: new Headers() } as any, params: {}, query: {}, body: undefined } as any, app)) as any;
}

test("listIncidents: lists PR + delivery incidents oldest-first with the retry remedy; skips healthy rows", async () => {
  const app = memApp({
    pull_requests: [
      { pr_key: "o/r#1", process_key: "11", incident_key: null },
      {
        pr_key: "o/r#2",
        process_key: "22",
        incident_key: "i2",
        incident_type: "JOB_NO_RETRIES",
        incident_message: "idle",
        incident_since: "2026-11-09T10:00:00Z",
      },
    ],
    delivery_graph_runs: [
      {
        run_key: "run-a",
        process_key: "33",
        incident_key: "i3",
        incident_type: "IO_MAPPING_ERROR",
        incident_message: "boom",
        incident_since: "2026-11-09T09:00:00Z",
      },
    ],
  });
  const res = await call(app);
  assertEquals(res.status, 200);
  assertEquals(res.body.count, 2);
  assertEquals(
    res.body.incidents.map((i: { kind: string; subjectKey: string }) => `${i.kind}:${i.subjectKey}`),
    ["delivery:run-a", "pr:o/r#2"],
  );
  assertEquals(res.body.incidents[1], {
    kind: "pr",
    subjectKey: "o/r#2",
    processInstanceKey: "22",
    incidentKey: "i2",
    type: "JOB_NO_RETRIES",
    message: "idle",
    since: "2026-11-09T10:00:00Z",
    retry: { path: "/app/api/actions/incident/retry", body: { processInstanceKey: "22" } },
  });
});

test("listIncidents: empty when nothing is parked", async () => {
  const res = await call(memApp({ pull_requests: [{ pr_key: "x", incident_key: null }] }));
  assertEquals(res.body, { count: 0, incidents: [] });
});
