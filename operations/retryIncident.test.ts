// Tests for POST /app/api/actions/incident/retry — operationId `retryIncident` (issue #931).
//
// The app-owned, RECORD-AWARE incident-retry door. Before it, unsticking an incident-parked loop
// meant hand-calling engine REST — `PATCH /v2/jobs/<k> {changeset:{retries:1}}` + `POST
// /v2/incidents/<k>/resolution` — with no app door at all (the two observed incidents on merlin sat
// dead for 1.3h / 5h partly because nothing surfaced them and nothing offered the retry). This
// delegate wraps exactly that two-call remedy in one operator action:
//   1. resolve the ACTIVE incident on the tracked record's instance (404 when no tracked record
//      owns the key — we never retry an instance we don't track; 409 when the instance carries no
//      active incident — nothing to retry),
//   2. bump the failed job's retries (a JOB_NO_RETRIES incident parks until the job has retries
//      again) and resolve the incident,
//   3. clear the mirrored incident columns off the record row immediately, so the `/status` row
//      leaves `incident` on the action's return instead of waiting out a poll tick.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";

/** The engine base every test here targets — set BEFORE the delegate module is (lazily) imported,
 *  since the engine REST address is resolved at module load. */
const ENGINE = "http://engine.test/v2";
process.env["CAMUNDA_REST_ADDRESS"] = ENGINE;

const { default: handler } = await import("./retryIncident.ts");

interface EngineCall {
  method: string;
  url: string;
  body?: unknown;
}

/** A fetch stub serving the engine's Camunda-8 v2 REST surface for one instance: the ACTIVE
 *  incident search, the job retries PATCH, and the incident resolution POST. */
function engineFetch(
  byInstance: Record<string, unknown[]>,
  calls: EngineCall[],
  opts: { failPatch?: boolean; failResolve?: boolean } = {},
) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const json = (body: unknown, status = 200) =>
      status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/incidents/search")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { filter?: { processInstanceKey?: string } };
      calls.push({ method: "POST", url: u, body });
      return Promise.resolve(json({ items: byInstance[body.filter?.processInstanceKey ?? ""] ?? [] }));
    }
    const jobPatch = u.match(/\/jobs\/([^/]+)$/);
    if (jobPatch && init?.method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method: "PATCH", url: u, body });
      return Promise.resolve(opts.failPatch ? json({ detail: "no such job" }, 404) : json({}, 204));
    }
    const resolution = u.match(/\/incidents\/([^/]+)\/resolution$/);
    if (resolution) {
      calls.push({ method: "POST", url: u });
      return Promise.resolve(opts.failResolve ? json({ detail: "engine unhappy" }, 500) : json({}, 204));
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${u}`);
  };
}

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
}

function prRow(over: Record<string, unknown> = {}) {
  return {
    pr_key: "owner/repo#1",
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    title: "t",
    status: "converging",
    current_round: 1,
    process_key: "PI-1",
    incident_key: "598235",
    incident_type: "JOB_NO_RETRIES",
    incident_message: 'agent "nano-coder" failed: idle',
    incident_since: "2026-11-09T01:00:00.000Z",
    updated_at: "2024-01-01",
    ...over,
  };
}

function memApp(stores: Record<string, { rows: any[]; key: string }>): AppApi {
  return {
    data: {
      table: withTrackingViews((name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key)),
      hasDefaultSource: () => true,
    },
    log: noopLog(),
  } as unknown as AppApi;
}

// biome-ignore lint/suspicious/noExplicitAny: test-only invocation shim for the delegate.
async function call(app: AppApi, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const req = { method: "POST", path: "/app/api/actions/incident/retry", headers: new Headers(headers) };
  // biome-ignore lint/suspicious/noExplicitAny: test-only invocation shim for the delegate.
  return await handler({ req: req as any, params: {}, query: {}, body } as any, app);
}

const ACTIVE_INCIDENT = {
  incidentKey: "598235",
  errorType: "JOB_NO_RETRIES",
  errorMessage: 'agent "nano-coder" failed: idle',
  state: "ACTIVE",
  creationTime: "2026-11-09T01:00:00.000Z",
  jobKey: "595995",
};

test("a missing/non-string processInstanceKey → 400 and never touches the engine", async () => {
  const calls: EngineCall[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = engineFetch({ "PI-1": [ACTIVE_INCIDENT] }, calls) as typeof fetch;
  const app = memApp({ pull_requests: { rows: [prRow()], key: "pr_key" } });
  try {
    assertEquals((await call(app, {})).status, 400);
    assertEquals((await call(app, { processInstanceKey: "  " })).status, 400);
    assertEquals((await call(app, { processInstanceKey: 2985 })).status, 400);
    assertEquals((await call(app, undefined)).status, 400);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(calls.length, 0, "no engine call without a valid key");
});

test("a key no tracked record owns → 404 and never touches the engine", async () => {
  const calls: EngineCall[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = engineFetch({}, calls) as typeof fetch;
  const app = memApp({ pull_requests: { rows: [prRow()], key: "pr_key" } });
  try {
    const res = await call(app, { processInstanceKey: "PI-UNKNOWN" });
    assertEquals(res.status, 404);
    assertEquals(res.body.ok, false);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(calls.length, 0, "an untracked key never reaches the engine");
});

test("an instance with no ACTIVE incident → 409 (nothing to retry), no mutation", async () => {
  const calls: EngineCall[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = engineFetch({ "PI-1": [] }, calls) as typeof fetch;
  const row = prRow({ incident_key: null, incident_type: null, incident_message: null, incident_since: null });
  const app = memApp({ pull_requests: { rows: [row], key: "pr_key" } });
  try {
    const res = await call(app, { processInstanceKey: "PI-1" });
    assertEquals(res.status, 409);
    assertEquals(res.body.ok, false);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(calls.length, 1, "only the incident search ran");
  assertEquals(calls[0].url.endsWith("/incidents/search"), true);
});

test("the happy path: bumps the failed job's retries, resolves the incident, and clears the mirrored row", async () => {
  const calls: EngineCall[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = engineFetch({ "PI-1": [ACTIVE_INCIDENT] }, calls) as typeof fetch;
  const row = prRow();
  const app = memApp({ pull_requests: { rows: [row], key: "pr_key" } });
  try {
    const res = await call(app, { processInstanceKey: "PI-1" });
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assertEquals(res.body.processInstanceKey, "PI-1");
    assertEquals(res.body.incidentKey, "598235");
    assertEquals(res.body.jobKey, "595995");
  } finally {
    globalThis.fetch = prevFetch;
  }
  // Exactly the manual remedy, in order: search → PATCH retries → POST resolution.
  assertEquals(calls.map((c) => `${c.method} ${c.url}`), [
    "POST http://engine.test/v2/incidents/search",
    "PATCH http://engine.test/v2/jobs/595995",
    "POST http://engine.test/v2/incidents/598235/resolution",
  ]);
  assertEquals(calls[1].body, { changeset: { retries: 1 } });
  // The mirrored row columns clear immediately — the /status row leaves `incident` on return.
  assertEquals(row.incident_key, null);
  assertEquals(row.incident_type, null);
  assertEquals(row.incident_message, null);
  assertEquals(row.incident_since, null);
});

test("a retries-bump failure → 502 and the incident is NOT resolved (no half-applied remedy)", async () => {
  const calls: EngineCall[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = engineFetch({ "PI-1": [ACTIVE_INCIDENT] }, calls, { failPatch: true }) as typeof fetch;
  const row = prRow();
  const app = memApp({ pull_requests: { rows: [row], key: "pr_key" } });
  try {
    const res = await call(app, { processInstanceKey: "PI-1" });
    assertEquals(res.status, 502);
    assertEquals(res.body.ok, false);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(
    calls.some((c) => c.url.endsWith("/resolution")),
    false,
    "the incident is left ACTIVE when the job could not be given retries",
  );
  // The row keeps its incident mirror — the incident is still real.
  assertEquals(row.incident_key, "598235");
});

test("a resolution failure after a successful retries bump → 502, row keeps the mirror (the next poll reconciles)", async () => {
  const calls: EngineCall[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = engineFetch({ "PI-1": [ACTIVE_INCIDENT] }, calls, { failResolve: true }) as typeof fetch;
  const row = prRow();
  const app = memApp({ pull_requests: { rows: [row], key: "pr_key" } });
  try {
    const res = await call(app, { processInstanceKey: "PI-1" });
    assertEquals(res.status, 502);
    assertEquals(res.body.ok, false);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(row.incident_key, "598235", "the mirror stays until the engine confirms resolution");
});

test("a delivery-graph run's incident retries through the same door", async () => {
  const calls: EngineCall[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = engineFetch({ "PI-DG-1": [ACTIVE_INCIDENT] }, calls) as typeof fetch;
  const run = {
    run_key: "dg-1",
    status: "running",
    process_key: "PI-DG-1",
    incident_key: "598235",
    incident_type: "JOB_NO_RETRIES",
    incident_message: "delivery node job exhausted retries",
    incident_since: "2026-11-09T03:00:00.000Z",
    updated_at: "t0",
  };
  const app = memApp({ delivery_graph_runs: { rows: [run], key: "run_key" } });
  try {
    const res = await call(app, { processInstanceKey: "PI-DG-1" });
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(run.incident_key, null);
  assertEquals(run.incident_since, null);
});
