// Red/green for issue #931 — an engine incident parked on a convergence loop's job must be VISIBLE
// on the `/status` row, not hide behind a healthy-looking `status: "converging"`.
//
// The defect (observed on merlin, 2026-11-09): a loop whose `senior:pr-review` job exhausted its
// retries (`JOB_NO_RETRIES`, the agent idle-timeout) sat dead for hours while `/status` reported
// `status: "converging"`, `openEscalation: null`, `activeWorker: null` — indistinguishable from a
// healthy queued run. `pollIncidents` mirrored the incident onto `incident_key`/`incident_message`
// (issue #94), but the `/status` projection never READ those columns, so the only discovery path
// was a hand-run `POST /v2/incidents/search`.
//
// The fix surfaces the mirrored incident on every ActivePr/ActiveDelivery row:
//   status   — overlaid to "incident" while the row carries an ACTIVE incident (the base
//              `pull_requests.status` workflow transient is untouched; the overlay is derived at
//              read time so it can never wedge the status machine), and
//   incident — { key, type, message, since }: the engine incidentKey, errorType, errorMessage and
//              creationTime the poller mirrored, so an operator sees WHAT broke and WHEN without
//              opening the engine.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import { activeDeliveries, activePrs } from "./service.ts";

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

type Stores = Record<string, { rows: any[]; key: string }>;

function memData(stores: Stores) {
  return {
    table: withTrackingViews((name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key)),
  } as any;
}

/** A fake engine whose `searchVariables` serves the given per-instance variables (none here — the
 *  merge policy degrades to its historical default, which these tests do not exercise). */
function fakeEngine() {
  return {
    searchVariables: () => Promise.resolve([]),
  } as any;
}

function prRow(over: Record<string, unknown>) {
  return {
    pr_key: "owner/repo#1",
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    title: "t",
    status: "converging",
    current_round: 1,
    process_key: "PI-1",
    updated_at: "2024-01-01",
    ...over,
  };
}

async function statusOf(rowOver: Record<string, unknown> = {}) {
  const stores: Stores = {
    pull_requests: { rows: [prRow(rowOver)], key: "pr_key" },
    user_tasks: { rows: [], key: "id" },
  };
  const [pr] = await activePrs(memData(stores), fakeEngine());
  return pr;
}

test("incident surfacing: a PR row carrying an ACTIVE incident reads status 'incident', not 'converging' (the #931 defect)", async () => {
  const pr = await statusOf({
    incident_key: "598235",
    incident_type: "JOB_NO_RETRIES",
    incident_message: 'agent "nano-coder" failed: no output and no subtree progress for >= 300000ms (idle)',
    incident_since: "2026-11-09T01:00:00.000Z",
  });
  assertEquals(pr.status, "incident");
  assertEquals(pr.incident, {
    key: "598235",
    type: "JOB_NO_RETRIES",
    message: 'agent "nano-coder" failed: no output and no subtree progress for >= 300000ms (idle)',
    since: "2026-11-09T01:00:00.000Z",
  });
});

test("incident surfacing: a healthy PR row keeps its workflow status and a null incident", async () => {
  const pr = await statusOf({
    incident_key: null,
    incident_type: null,
    incident_message: null,
    incident_since: null,
  });
  assertEquals(pr.status, "converging");
  assertEquals(pr.incident, null);
});

test("incident surfacing: the overlay applies to any live workflow status (e.g. waiting_merge), never just converging", async () => {
  const pr = await statusOf({
    status: "waiting_merge",
    incident_key: "INC-9",
    incident_type: "EXTRACT_VALUE_ERROR",
    incident_message: "failed to evaluate expression",
    incident_since: "2026-11-09T02:00:00.000Z",
  });
  assertEquals(pr.status, "incident");
  assertEquals(pr.incident?.key, "INC-9");
});

test("incident surfacing: a delivery run carrying an ACTIVE incident reads status 'incident' with the incident block", async () => {
  const run = {
    run_key: "dg-1",
    title: "ship it",
    status: "running",
    phase: "Running",
    process_key: "PI-DG-1",
    updated_at: "2024-01-01",
    auto_resolve_escalations: 0,
    incident_key: "INC-DG-1",
    incident_type: "JOB_NO_RETRIES",
    incident_message: "delivery node job exhausted retries",
    incident_since: "2026-11-09T03:00:00.000Z",
  };
  const stores: Stores = {
    delivery_graph_runs: { rows: [run], key: "run_key" },
    user_tasks: { rows: [], key: "id" },
  };
  const [delivery] = await activeDeliveries(memData(stores));
  assertEquals(delivery.status, "incident");
  assertEquals(delivery.incident, {
    key: "INC-DG-1",
    type: "JOB_NO_RETRIES",
    message: "delivery node job exhausted retries",
    since: "2026-11-09T03:00:00.000Z",
  });
});

test("incident surfacing: a healthy delivery run keeps its status and a null incident", async () => {
  const run = {
    run_key: "dg-2",
    title: "ship it",
    status: "running",
    phase: "Running",
    process_key: "PI-DG-2",
    updated_at: "2024-01-01",
    auto_resolve_escalations: 0,
    incident_key: null,
    incident_type: null,
    incident_message: null,
    incident_since: null,
  };
  const stores: Stores = {
    delivery_graph_runs: { rows: [run], key: "run_key" },
    user_tasks: { rows: [], key: "id" },
  };
  const [delivery] = await activeDeliveries(memData(stores));
  assertEquals(delivery.status, "running");
  assertEquals(delivery.incident, null);
});
