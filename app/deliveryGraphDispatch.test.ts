// Unit coverage for `dispatchDeliveryGraphRun` (app/deliveryGraphDispatch.ts) — the retained
// delivery-graph DISPATCH core extracted out of the removed agent `start` door (ADR 0005 Decision 7,
// issue #460). It has NO approval gate: the authorization lives in the fact that only the cockpit
// dispatch seam reaches this code (never the agent surface). What it DOES keep is the durable
// at-most-once launch fence + idempotency short-circuit, so a double-dispatch never double-launches a
// graph's side effects. These tests drive it against an in-memory app/data/engine faithful to the run
// aggregate's PRIMARY KEY fence and the guarded raw UPDATE the claim issues.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { dispatchDeliveryGraphRun } from "./deliveryGraphDispatch.ts";
import { noopLog } from "../test/log.ts";

function makeApp() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const started: { processDefinitionId: string }[] = [];
  const table = (name: string, key: string) => {
    const rows =
      tables.get(name) ??
      (() => {
        const fresh: Record<string, unknown>[] = [];
        tables.set(name, fresh);
        return fresh;
      })();
    return {
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      all: () => Promise.resolve([...rows]),
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

const HUMAN_ONLY = {
  name: "manual gate",
  nodes: [{ id: "ack", kind: "human", human: { prompt: "click done" } }],
};
const SIDE_EFFECTING = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:demo", prompt: "merge #B" } },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" } },
  ],
  edges: [{ from: "open-b", to: "publish" }],
};

test("dispatchDeliveryGraphRun: a human-only graph launches straight away (running), one engine instance", async () => {
  const { app, started, runs } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.status, "running");
  assertEquals(res.alreadyRunning, false);
  assertEquals(res.sideEffecting, false);
  assertEquals(started.length, 1);
  assertEquals(runs()[0].status, "running");
});

test("dispatchDeliveryGraphRun: a side-effecting graph dispatches with NO approval token — the operator seam IS the approval", async () => {
  const { app, started, runs } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.status, "running");
  assertEquals(res.sideEffecting, true);
  assertEquals(started.length, 1);
  assertEquals(runs()[0].status, "running");
});

test("dispatchDeliveryGraphRun: a re-dispatch of a still-running run short-circuits (alreadyRunning) — the side effect launches at most once", async () => {
  const { app, started } = makeApp();
  const first = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assert(first.ok);
  const second = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.alreadyRunning, true);
  assertEquals(started.length, 1); // never a second launch
});

test("dispatchDeliveryGraphRun: an explicit idempotency key forces a distinct run row", async () => {
  const { app, started } = makeApp();
  await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { repoless: true });
  await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { runKey: "second-run", repoless: true });
  assertEquals(started.length, 2);
});

test("dispatchDeliveryGraphRun: a malformed graph → ok:false with path-qualified errors, nothing launched", async () => {
  const { app, started } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, { name: "empty", nodes: [] });
  assertEquals(res.ok, false);
  if (res.ok) return;
  assert(Array.isArray(res.errors) && res.errors.length > 0);
  for (const e of res.errors) {
    assert(typeof e.path === "string" && typeof e.message === "string");
  }
  assertEquals(started.length, 0);
});
