// Regression for issue #1023: a convergence loop dispatched an agent job after its PR merged and its
// head branch was deleted; provisioning failed (`Remote branch … not found`), retries ran out and the
// instance parked on an INCIDENT. An incident on a loop whose PR is merged/closed is a finished PR,
// not a fault: the incident pass must retire the loop (merged / abandoned) instead of mirroring a
// dead-end incident for a human to cancel by hand.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import { pollIncidentsImpl } from "./service.ts";

const REPO = "owner/repo";
const NUMBER = 226;

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) => Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) => Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: () => Promise.resolve(),
  };
}

async function run(prState: { merged: boolean; state: string } | null, withFinisher = true) {
  const row: any = {
    pr_key: `${REPO}#${NUMBER}`,
    repo: REPO,
    number: NUMBER,
    status: "converging",
    process_key: "84080",
    incident_key: null,
    incident_type: null,
    incident_message: null,
    incident_since: null,
    updated_at: "t0",
  };
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
    merges: { rows: [], key: "id" },
    plan_tasks: { rows: [], key: "id" },
  };
  const data = {
    table: withTrackingViews((name: string, key: string) => {
      stores[name] ??= { rows: [], key };
      return memTable(stores[name].rows, stores[name].key);
    }),
  } as any;
  const cancelled: string[] = [];
  const engine = {
    publishMessage: () => Promise.resolve(),
    cancelInstance: (a: { processInstanceKey: string }) => {
      cancelled.push(a.processInstanceKey);
      return Promise.resolve();
    },
    searchProcessInstances: () => Promise.resolve([]),
  } as any;
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status }));
    if (u.endsWith("/incidents/search")) {
      return json({
        items: [
          {
            incidentKey: "INC-1",
            errorType: "JOB_NO_RETRIES",
            errorMessage: "git clone failed: Remote branch feat/issue-223 not found",
            state: "ACTIVE",
            creationTime: "2026-11-22T11:30:00Z",
          },
        ],
      });
    }
    if (u.endsWith(`/pulls/${NUMBER}`)) {
      return prState ? json({ ...prState, mergeable_state: "clean", head: { sha: "abc" } }) : json({}, 502);
    }
    return json({}, 404);
  }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", {}, withFinisher ? { engine, token: "t" } : undefined);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
  }
  return { row, cancelled, stores };
}

test("#1023: an incident on a loop whose PR MERGED retires the loop as merged — no incident left", async () => {
  const { row, cancelled } = await run({ merged: true, state: "closed" });
  assertEquals(cancelled, ["84080"]);
  assertEquals(row.status, "merged");
  assertEquals(row.incident_key, null);
});

test("#1023: an incident on a loop whose PR CLOSED unmerged retires and abandons it", async () => {
  const { row, cancelled, stores } = await run({ merged: false, state: "closed" });
  assertEquals(cancelled, ["84080"]);
  assertEquals(row.incident_key, null);
  assertEquals(
    stores.merges.rows.some((m: any) => m.outcome === "abandoned" && m.method === "pr-closed"),
    true,
  );
});

test("#1023: an incident on an OPEN PR is mirrored as before (a real fault for a human)", async () => {
  const { row, cancelled } = await run({ merged: false, state: "open" });
  assertEquals(cancelled, []);
  assertEquals(row.status, "converging");
  assertEquals(row.incident_key, "INC-1");
});

test("#1023: an unreadable PR state is conservative — the incident is mirrored, the loop untouched", async () => {
  const { row, cancelled } = await run(null);
  assertEquals(cancelled, []);
  assertEquals(row.incident_key, "INC-1");
});
