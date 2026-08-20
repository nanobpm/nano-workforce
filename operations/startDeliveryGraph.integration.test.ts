// Integration coverage for the S5 DISPATCH door (ADR 0005 Decision 7) driven through the operation
// EDGE — `startDeliveryGraph` composing S0 validate → S1 compile → approval gate → S4 launch. The unit
// tests in app/deliveryGraphRun.test.ts prove the pure decision helpers in isolation; this file proves
// the COMPOSED behaviour at the door: each path maps to the correct HTTP status and the correct
// durable-run / launch effect. It runs the real delegate against an in-memory app/data/engine — no
// network, deterministic on a single run.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import startDeliveryGraph from "./startDeliveryGraph.ts";

// ── in-memory app (data + engine) ────────────────────────────────────────────
// A generic table over an array (the DataLayer surface the run aggregate uses: get/find/insert/update)
// plus a fake engine recording each deploy + start so an accept path can assert exactly-once launch.
function makeApp(opts: { failCreate?: boolean } = {}) {
  const tables = new Map<string, Record<string, unknown>[]>();
  const started: { processDefinitionId: string; variables?: Record<string, unknown> }[] = [];
  const deployed: unknown[][] = [];
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
        // Faithful to the durable table's PRIMARY KEY: a duplicate-key insert is rejected with the
        // SQLite fence message `isUniqueConstraintFence` classifies, so the door's claim-before-launch
        // fence is exercised the same way it is against the real store.
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
    data: { table },
    engine: {
      deployResources: (res: unknown[]) => {
        deployed.push(res);
        return Promise.resolve([]);
      },
      createInstance: (req: { processDefinitionId: string; variables?: Record<string, unknown> }) => {
        started.push(req);
        if (opts.failCreate) return Promise.reject(new Error("engine unavailable"));
        return Promise.resolve({ processInstanceKey: "PI-1" });
      },
    },
    log: noopLog(),
  } as unknown as AppApi;
  return { app, started, deployed, runs: () => tables.get("delivery_graph_runs") ?? [] };
}

function input(body: unknown) {
  return {
    req: { method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" } as never,
    params: {},
    query: {},
    body,
  };
}

// A SIDE-EFFECTING graph (an `agent` node → approval required) and a NON-side-effecting one
// (`human`-only → dispatches without approval).
const SIDE_EFFECTING = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:feature", prompt: "un-draft + merge #B" } },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" } },
  ],
  edges: [{ from: "open-b", to: "publish" }],
};
const HUMAN_ONLY = {
  name: "manual gate",
  nodes: [{ id: "ack", kind: "human", human: { prompt: "click done when the release is out" } }],
};

test("missing graph → 400, nothing launched", async () => {
  const { app, started } = makeApp();
  const res = (await startDeliveryGraph(input({}), app)) as { status: number; body: { ok: boolean } };
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assertEquals(started.length, 0);
});

test("a malformed graph fails S0 validation → 400, nothing compiled or launched", async () => {
  const { app, started } = makeApp();
  // Duplicate node ids — a semantic error `validateDeliveryGraph` catches (shape alone is fine).
  const dup = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }, { id: "a", kind: "agent", agent: { jobType: "j" } }] };
  const res = (await startDeliveryGraph(input({ graph: dup }), app)) as { status: number; body: { ok: boolean; errors?: unknown[] } };
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assertEquals(Array.isArray(res.body.errors), true);
  assertEquals(started.length, 0);
});

test("a side-effecting graph WITHOUT approval is refused + PARKED at approval (400, awaiting-approval row, no launch)", async () => {
  const { app, started, runs } = makeApp();
  const res = (await startDeliveryGraph(input({ graph: SIDE_EFFECTING }), app)) as {
    status: number;
    body: { ok: boolean; status: string; approvalToken: string; sideEffecting: boolean };
  };
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assertEquals(res.body.status, "awaiting-approval");
  assertEquals(res.body.sideEffecting, true);
  assertEquals(typeof res.body.approvalToken, "string");
  assertEquals(started.length, 0); // parked, never launched
  // The parked run is durable + visible (cockpit reads this table).
  assertEquals(runs().length, 1);
  assertEquals(runs()[0]?.["status"], "awaiting-approval");
});

test("re-submitting the SAME side-effecting graph WITH its approval token dispatches (202, running, launched once)", async () => {
  const { app, started, runs } = makeApp();
  // First submit parks + hands back the token.
  const parked = (await startDeliveryGraph(input({ graph: SIDE_EFFECTING }), app)) as { body: { approvalToken: string } };
  const token = parked.body.approvalToken;
  // Second submit approves → dispatch. The SAME run row transitions parked → running (not a new row).
  const res = (await startDeliveryGraph(input({ graph: SIDE_EFFECTING, approvalToken: token }), app)) as {
    status: number;
    body: { ok: boolean; status: string; processInstanceKey?: string };
  };
  assertEquals(res.status, 202);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.status, "running");
  assertEquals(res.body.processInstanceKey, "PI-1");
  assertEquals(started.length, 1);
  assertEquals(runs().length, 1); // still ONE row — approval updated it, did not duplicate
  assertEquals(runs()[0]?.["status"], "running");
});

test("a non-side-effecting (human-only) graph dispatches WITHOUT approval (202, running)", async () => {
  const { app, started } = makeApp();
  const res = (await startDeliveryGraph(input({ graph: HUMAN_ONLY }), app)) as {
    status: number;
    body: { ok: boolean; status: string; sideEffecting: boolean };
  };
  assertEquals(res.status, 202);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.status, "running");
  assertEquals(res.body.sideEffecting, false);
  assertEquals(started.length, 1);
});

test("a duplicate submit of an already-running graph short-circuits — no second launch", async () => {
  const { app, started } = makeApp();
  await startDeliveryGraph(input({ graph: HUMAN_ONLY }), app); // launch #1
  const res = (await startDeliveryGraph(input({ graph: HUMAN_ONLY }), app)) as {
    status: number;
    body: { alreadyRunning: boolean; status: string };
  };
  assertEquals(res.status, 202);
  assertEquals(res.body.alreadyRunning, true);
  assertEquals(res.body.status, "running");
  assertEquals(started.length, 1); // still ONE launch — the re-POST did not double-launch
});

test("a caller idempotencyKey scopes the run — the same key short-circuits, a different key launches again", async () => {
  const { app, started } = makeApp();
  await startDeliveryGraph(input({ graph: HUMAN_ONLY, idempotencyKey: "run-1" }), app);
  const same = (await startDeliveryGraph(input({ graph: HUMAN_ONLY, idempotencyKey: "run-1" }), app)) as { body: { alreadyRunning: boolean } };
  assertEquals(same.body.alreadyRunning, true);
  assertEquals(started.length, 1);
  const other = (await startDeliveryGraph(input({ graph: HUMAN_ONLY, idempotencyKey: "run-2" }), app)) as { body: { status: string; runKey: string } };
  assertEquals(other.body.status, "running");
  assertEquals(other.body.runKey, "run-2");
  assertEquals(started.length, 2); // a distinct key is a distinct run
});

test("two SIMULTANEOUS submits of the same graph launch it exactly ONCE — the loser hits the run_key fence and short-circuits, no double side effect", async () => {
  const { app, started, runs } = makeApp();
  // Fire both before awaiting either: both read `existing === null`, then race to claim the run_key.
  // The claim-before-launch fence means the loser's insert collides on the PK and it NEVER launches.
  const [a, b] = (await Promise.all([
    startDeliveryGraph(input({ graph: HUMAN_ONLY }), app),
    startDeliveryGraph(input({ graph: HUMAN_ONLY }), app),
  ])) as { status: number; body: { ok: boolean; status: string; alreadyRunning: boolean } }[];
  assertEquals(a.status, 202);
  assertEquals(b.status, 202);
  assertEquals(a.body.ok, true);
  assertEquals(b.body.ok, true);
  // Exactly ONE launch and ONE durable row — no double-dispatch of side effects, no duplicate row.
  assertEquals(started.length, 1);
  assertEquals(runs().length, 1);
  assertEquals(runs()[0]?.["status"], "running");
  // Exactly one racer is the short-circuited loser (alreadyRunning); the other is the fresh winner.
  assertEquals([a, b].filter((r) => r.body.alreadyRunning === true).length, 1);
});

test("a launch failure rolls the claimed run to `failed` — no stranded null-process_key `running` row", async () => {
  const { app, started, runs } = makeApp({ failCreate: true });
  let threw = false;
  try {
    await startDeliveryGraph(input({ graph: HUMAN_ONLY }), app);
  } catch {
    threw = true; // a thrown engine error propagates (framework maps it to a 500) — but only after rollback
  }
  assertEquals(threw, true);
  assertEquals(started.length, 1); // the launch was attempted once
  // The claim was written, then rolled back to a TERMINAL `failed` — the reconciler/poller skip null-
  // key rows, so leaving it `running` would strand it forever; `failed` lets it drop out cleanly.
  assertEquals(runs().length, 1);
  assertEquals(runs()[0]?.["status"], "failed");
  assertEquals(runs()[0]?.["process_key"], null);
});
