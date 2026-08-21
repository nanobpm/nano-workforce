// Integration coverage for the POST /app/api/actions/delivery-graph/dispatch operation
// `dispatchDeliveryGraph` (issue #386, ADR 0005 slice S5) — the human-facing UI JSON-paste DISPATCH
// ingress. It parses the operator's pasted JSON STRING and DELEGATES to the SAME gated, idempotent
// `startDeliveryGraph` handler (no parallel dispatch path), deriving the approval token from the graph
// when the operator ticks `approve`. These tests drive the real delegate against an in-memory
// app/data/engine (mirroring startDeliveryGraph.integration.test.ts) so the composed behaviour — parse
// → approval-gate → launch — is proven, and assert the parse guards map to a 400 with a human error.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./dispatchDeliveryGraph.ts";

// A compact in-memory app: a generic table over an array (get/find/insert/update/delete) faithful to
// the run aggregate's PRIMARY KEY fence, plus the guarded raw UPDATE the door issues and a fake engine.
function makeApp() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const started: { processDefinitionId: string }[] = [];
  const table = (name: string, key: string) => {
    const rows = tables.get(name) ?? (() => {
      const fresh: Record<string, unknown>[] = [];
      tables.set(name, fresh);
      return fresh;
    })();
    return {
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      insert: (r: Record<string, unknown>) => {
        if (rows.some((existing) => existing[key] === r[key])) {
          return Promise.reject(new Error(`UNIQUE constraint failed: ${name}.${key}`));
        }
        rows.push(r);
        return Promise.resolve(r);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = rows.findIndex((r) => r[key] === k);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve();
      },
    };
  };
  const app = {
    data: {
      table,
      open: () => ({
        exec: (sql: string, params: unknown[]) =>
          Promise.resolve().then(() => {
            const cols = [...sql.matchAll(/"(\w+)"\s*=\s*\?/g)].map((m) => m[1]);
            const runKey = params[params.length - 1];
            const rows = tables.get("delivery_graph_runs") ?? [];
            const row = rows.find((r) => r["run_key"] === runKey);
            if (row && row["status"] !== "running") {
              for (let i = 0; i < cols.length - 1; i++) row[cols[i]] = params[i];
              return { changed: 1 };
            }
            return { changed: 0 };
          }),
      }),
    },
    engine: {
      deployResources: () => Promise.resolve([]),
      createInstance: (req: { processDefinitionId: string }) => {
        started.push(req);
        return Promise.resolve({ processInstanceKey: "PI-1", processDefinitionId: req.processDefinitionId });
      },
    },
    log: noopLog(),
  } as unknown as AppApi;
  return { app, started, runs: () => tables.get("delivery_graph_runs") ?? [] };
}

async function call(app: AppApi, body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

const SIDE_EFFECTING = JSON.stringify({
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:feature", prompt: "un-draft + merge #B" } },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" } },
  ],
  edges: [{ from: "open-b", to: "publish" }],
});
const HUMAN_ONLY = JSON.stringify({
  name: "manual gate",
  nodes: [{ id: "ack", kind: "human", human: { prompt: "click done when the release is out" } }],
});

test("dispatch-delivery-graph: a non-JSON paste → 400 with a human error, nothing launched", async () => {
  const { app, started } = makeApp();
  const res = await call(app, { graphJson: "{ not json" });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assert(typeof res.body.error === "string" && res.body.error.includes("not valid JSON"));
  assertEquals(started.length, 0);
});

test("dispatch-delivery-graph: a blank paste → 400, never a 500", async () => {
  const { app } = makeApp();
  const res = await call(app, { graphJson: "" });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
});

test("dispatch-delivery-graph: a non-side-effecting graph dispatches straight away (202 running)", async () => {
  const { app, started, runs } = makeApp();
  const res = await call(app, { graphJson: HUMAN_ONLY });
  assertEquals(res.status, 202);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.status, "running");
  assertEquals(started.length, 1);
  assertEquals(runs()[0].status, "running");
});

test("dispatch-delivery-graph: a side-effecting graph WITHOUT approve is parked at approval (400), nothing launched", async () => {
  const { app, started, runs } = makeApp();
  const res = await call(app, { graphJson: SIDE_EFFECTING });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assertEquals(res.body.status, "awaiting-approval");
  // The human banner is populated from the door's park message.
  assert(typeof res.body.error === "string" && res.body.error.length > 0);
  assertEquals(started.length, 0);
  assertEquals(runs()[0].status, "awaiting-approval");
});

test("dispatch-delivery-graph: a side-effecting graph WITH approve dispatches (202 running), token derived server-side", async () => {
  const { app, started, runs } = makeApp();
  const res = await call(app, { graphJson: SIDE_EFFECTING, approve: true });
  assertEquals(res.status, 202);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.status, "running");
  assertEquals(res.body.sideEffecting, true);
  assertEquals(started.length, 1);
  assertEquals(runs()[0].status, "running");
});

test("dispatch-delivery-graph: re-dispatch of a running graph short-circuits (alreadyRunning), no second launch", async () => {
  const { app, started } = makeApp();
  await call(app, { graphJson: HUMAN_ONLY });
  const res = await call(app, { graphJson: HUMAN_ONLY });
  assertEquals(res.status, 202);
  assertEquals(res.body.alreadyRunning, true);
  assertEquals(started.length, 1);
});
