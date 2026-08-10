// Red/green regression for re-submit clearing stale open escalations (Magikcraft/nano-bpm
// #597/#599). When a cancelled/converged PR is re-submitted, `submitPr` re-opens it for a fresh
// convergence run. Any escalation left `open` by the prior run — plus the denormalised
// `open_escalation_*` pointer on the PR row — must be cleared, or the answer form resurfaces a
// dead "(no question provided)" question on the re-opened PR (the same stale-row class the plan
// loop already guards in `startPlan`). Drives `submitPr` against an in-memory data layer with the
// GitHub transport forced off so it is hermetic.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { pollIncidentsImpl, submitPr } from "./service.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
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

function withGithubOff(run: () => Promise<void>): Promise<void> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token"; // no token below -> fetchPrMeta returns null
  delete process.env["GITHUB_TOKEN"];
  return run().finally(() => {
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
  });
}

test("re-submit of a cancelled PR clears stale open escalations + the denormalised pointer", async () => {
  await withGithubOff(async () => {
    const PR_KEY = "owner/repo#42";
    const stores: Record<string, { rows: unknown[]; key: string }> = {
      pull_requests: {
        rows: [{
          pr_key: PR_KEY,
          repo: "owner/repo",
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          title: "old title",
          status: "abandoned", // terminal -> re-open path
          current_round: 3,
          open_escalation_id: 5,
          open_escalation_question: "(no question provided)",
        }],
        key: "pr_key",
      },
      escalations: {
        rows: [{ id: 5, pr_key: PR_KEY, round_no: 3, kind: "question", question: "(no question provided)", status: "open" }],
        key: "id",
      },
      pr_dependencies: { rows: [], key: "pr_key" },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    } as any;
    const engine = {
      createInstance: () => Promise.resolve({ processInstanceKey: "PI-9" }),
    } as any;

    await submitPr(data, engine, {
      repo: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      prKey: PR_KEY,
    });

    // The prior run's open escalation is retired (not left "open" to resurface a dead form) …
    const esc = stores.escalations.rows[0] as Record<string, unknown>;
    assertEquals(esc.status, "stale");
    // … and the PR row is re-opened with the denormalised escalation pointer cleared.
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.status, "converging");
    assertEquals(pr.current_round, 1);
    assertEquals(pr.open_escalation_id, null);
    assertEquals(pr.open_escalation_question, null);
    assertEquals(pr.process_key, "PI-9");
  });
});

// Red/green regression for technical-incident surfacing (issue #94). A convergence/merge instance
// can hit an engine incident that parks the token; until `pollIncidents` nothing on the PR row
// reflected it, so the grid kept showing "converging" while the run was dead in the water. This
// drives the pass's reconciliation core against a stubbed `/v2/incidents/search`:
//   1. an ACTIVE incident is mirrored onto `incident_key` + `incident_message` (status untouched),
//   2. once the engine reports no active incident, the columns are cleared idempotently,
//   3. a PR with no live instance (no process_key / terminal status) is never queried and any
//      stale incident on it is cleared.
function incidentFetch(byInstance: Record<string, unknown[]>) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (!u.endsWith("/incidents/search")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      filter?: { processInstanceKey?: string };
    };
    const items = byInstance[body.filter?.processInstanceKey ?? ""] ?? [];
    return Promise.resolve(
      new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

test("pollIncidents mirrors an ACTIVE incident onto the PR row, then clears it, leaving status untouched", async () => {
  const row = {
    pr_key: "owner/repo#7",
    repo: "owner/repo",
    number: 7,
    status: "converging",
    process_key: "PI-7",
    incident_key: null as string | null,
    incident_message: null as string | null,
    updated_at: "t0",
  };
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  const headers = { "content-type": "application/json" };

  const prevFetch = globalThis.fetch;

  // Red-ish: with an ACTIVE incident on the instance, the pass must surface it (before this
  // feature the columns stayed null and the incident was invisible).
  globalThis.fetch = incidentFetch({
    "PI-7": [{ incidentKey: "INC-1", errorMessage: "boom: unhandled error", state: "ACTIVE", creationTime: "2024-01-01T00:00:00Z" }],
  }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(row.incident_key, "INC-1");
  assertEquals(row.incident_message, "boom: unhandled error");
  assertEquals(row.status, "converging"); // orthogonal: status is never touched

  // Green: once the engine reports no active incident, the columns clear idempotently.
  globalThis.fetch = incidentFetch({ "PI-7": [] }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(row.incident_key, null);
  assertEquals(row.incident_message, null);
  assertEquals(row.status, "converging");
});

test("pollIncidents never queries a PR with no live instance and clears any stale incident", async () => {
  const noKey = {
    pr_key: "owner/repo#8",
    status: "converging",
    process_key: null as string | null,
    incident_key: "STALE-A",
    incident_message: "left over",
    updated_at: "t0",
  };
  const terminal = {
    pr_key: "owner/repo#9",
    status: "merged",
    process_key: "PI-9",
    incident_key: "STALE-B",
    incident_message: "left over",
    updated_at: "t0",
  };
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [noKey, terminal], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  const headers = { "content-type": "application/json" };

  const prevFetch = globalThis.fetch;
  // Any fetch here is a bug — neither PR has a live instance to inspect.
  globalThis.fetch = (() => {
    throw new Error("pollIncidents must not query a PR with no live instance");
  }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(noKey.incident_key, null);
  assertEquals(noKey.incident_message, null);
  assertEquals(terminal.incident_key, null);
  assertEquals(terminal.incident_message, null);
});

test("pollIncidents picks the oldest incident by creationTime, sorting a missing timestamp last", async () => {
  const row = {
    pr_key: "owner/repo#11",
    status: "converging",
    process_key: "PI-11",
    incident_key: null as string | null,
    incident_message: null as string | null,
    updated_at: "t0",
  };
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  const headers = { "content-type": "application/json" };

  const prevFetch = globalThis.fetch;
  // A no-`creationTime` incident must not masquerade as the oldest (empty-string sort bug): the
  // real earliest ISO timestamp wins even when a timestamp-less incident is returned first.
  globalThis.fetch = incidentFetch({
    "PI-11": [
      { incidentKey: "INC-NOTS", errorMessage: "no timestamp", state: "ACTIVE" },
      { incidentKey: "INC-OLD", errorMessage: "the first fault", state: "ACTIVE", creationTime: "2024-01-01T00:00:00Z" },
      { incidentKey: "INC-NEW", errorMessage: "a later fault", state: "ACTIVE", creationTime: "2024-06-01T00:00:00Z" },
    ],
  }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(row.incident_key, "INC-OLD");
  assertEquals(row.incident_message, "the first fault");
});


// Red/green regression (nano-workforce#102 review): the engine can hand back a numeric
// `processInstanceKey`, but the OpenAPI `SubmitResult.processKey` contract is `string | null`, so
// under api `validateResponses:"dev"` a raw number fails response validation. Stringifying at the
// source also keeps the returned key aligned with the DB-persisted `String(...)` value and dodges
// JS 53-bit precision limits for large 64-bit keys (which is why keys travel as strings in
// practice). `submitPr` must stringify it both in the returned body and the persisted row.
test("submitPr stringifies a numeric processInstanceKey (contract: string | null)", async () => {
  await withGithubOff(async () => {
    const PR_KEY = "owner/repo#7";
    const stores: Record<string, { rows: unknown[]; key: string }> = {
      pull_requests: { rows: [], key: "pr_key" },
      escalations: { rows: [], key: "id" },
      pr_dependencies: { rows: [], key: "pr_key" },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    } as any;
    const engine = {
      // A large key delivered as a JS number — the exact case that breaks dev response validation
      // (number vs the `string | null` contract). Kept within MAX_SAFE_INTEGER so the fixture
      // itself is exact; true 64-bit keys travel as strings for the same precision reason.
      createInstance: () => Promise.resolve({ processInstanceKey: 2251799813685249 }),
    } as any;

    const res = await submitPr(data, engine, {
      repo: "owner/repo",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      prKey: PR_KEY,
    });

    const processKey = (res as any).processKey;
    assertEquals(typeof processKey, "string");
    assertEquals(processKey, "2251799813685249");
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.process_key, "2251799813685249");
  });
});
