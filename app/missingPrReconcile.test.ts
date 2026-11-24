// Issue #1089: a missing `pull_requests` row must not keep an epic or feature live forever. The
// reconciler looks the PR up on GitHub: merged/closed → a terminal row is written; absent past the
// grace period → the slice/feature is failed with a reason. Waiters then see a terminal state.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { withTrackingViews } from "../test/trackingViews.ts";
import { deriveFeatureDelivery } from "./feature.ts";
import {
  classifyMissingPrError,
  derivePlanDelivery,
  lookupMissingPr,
  pollFeatureDelivery,
  MISSING_PR_GRACE_MS,
  MISSING_PR_RECHECK_MS, type MissingPrLookup,
  reconcileMissingPrRows,
} from "./service.ts";

function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  const stores: Record<string, any[]> = {};
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      async findOne(where: any = {}) {
        return rows.find((r) => match(r, where));
      },
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      async delete() {},
    };
  }
  // The guarded feature CAS (foldCompletedFeatureRun) is the only raw SQL this reconciler issues.
  const exec = async (sql: string, args: any[]) => {
    if (!/^UPDATE "feature_runs"/.test(sql)) throw new Error(`unexpected sql: ${sql}`);
    if (/"process_key" IS NULL/.test(sql)) {
      const [st, lb, ts, fk, prKey, exp, seenAt] = args;
      const k = (stores.feature_runs ?? []).find(
        (row) =>
          row.feature_key === fk && row.process_key == null && row.pr_key === prKey && row.status === exp && row.updated_at === seenAt,
      );
      if (k) Object.assign(k, { status: st, delivery_label: lb, updated_at: ts });
      return { changed: k ? 1 : 0 };
    }
    const [status, label, at, featureKey, processKey, expect] = args;
    const r = (stores.feature_runs ?? []).find(
      (row) => row.feature_key === featureKey && row.process_key === processKey && row.status === expect,
    );
    if (r) Object.assign(r, { status, delivery_label: label, updated_at: at });
    return { changed: r ? 1 : 0 };
  };
  const data = {
    table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)),
    open: () => ({ exec, tx: async (fn: any) => fn({ exec: async () => ({ changed: 0 }) }) }),
  } as any as DataLayer;
  return { data, stores };
}

const T0 = Date.parse("2026-01-01T00:00:00Z");
const ISO0 = new Date(T0).toISOString();
const lookupOf = (answer: MissingPrLookup) => async () => answer;

function seedEpic(stores: Record<string, any[]>, prKey: string) {
  stores.plans = [{ plan_key: "o/r#1", status: "done", created_at: ISO0, updated_at: ISO0 }];
  stores.plan_tasks = [{ id: 1, plan_key: "o/r#1", task_id: "a", pr_key: prKey, created_at: ISO0, updated_at: ISO0 }];
}

function seedFeature(stores: Record<string, any[]>, prKey: string) {
  stores.feature_runs = [
    { feature_key: "o/r#2", process_key: "p1", status: "converging", pr_key: prKey, converge: 1, delivery_label: "PR record missing", created_at: ISO0, updated_at: ISO0 },
  ];
}

test("epic: a slice PR merged on GitHub with no PR row → row written, epic delivery terminal", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#10");
  const plan = stores.plans[0];
  assertEquals(await derivePlanDelivery(data, plan), "converging");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("merged"), nowMs: T0 + 1000, lastChecked: new Map() });
  assertEquals(stores.pull_requests?.[0]?.status, "merged");
  assertEquals(await derivePlanDelivery(data, plan), "landed");
});

test("feature: PR merged on GitHub with no PR row → row written, feature rolls up merged", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#11");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("merged"), nowMs: T0 + 1000, lastChecked: new Map() });
  assertEquals(stores.pull_requests[0].status, "merged");
  assertEquals(deriveFeatureDelivery(stores.pull_requests[0].status).status, "merged");
});

test("closed on GitHub → abandoned row with reason (terminal)", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#12");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("closed"), nowMs: T0, lastChecked: new Map() });
  assertEquals(stores.pull_requests[0].status, "abandoned");
  assertEquals(/closed on GitHub/.test(stores.pull_requests[0].outcome), true);
  assertEquals(await derivePlanDelivery(data, stores.plans[0]), null);
});

test("not found within grace → nothing written; open / unknown → nothing written", async () => {
  for (const answer of ["not_found", "open", null] as MissingPrLookup[]) {
    const { data, stores } = memData();
    seedEpic(stores, "o/r#13");
    seedFeature(stores, "o/r#14");
    const late = answer === "not_found" ? T0 + MISSING_PR_GRACE_MS - 1 : T0 + 10 * MISSING_PR_GRACE_MS;
    await reconcileMissingPrRows(data, "", { lookup: lookupOf(answer), nowMs: late, lastChecked: new Map() });
    assertEquals(stores.pull_requests ?? [], []);
    assertEquals(stores.feature_runs[0].status, "converging");
  }
});

test("absent past grace → slice and feature failed with a reason", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#15");
  seedFeature(stores, "o/r#16");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked: new Map() });
  const slice = stores.pull_requests.find((r: any) => r.pr_key === "o/r#15");
  assertEquals(slice.status, "abandoned");
  assertEquals(/not found on GitHub/.test(slice.outcome), true);
  assertEquals(await derivePlanDelivery(data, stores.plans[0]) !== "converging", true);
  assertEquals(stores.feature_runs[0].status, "failed");
  assertEquals(/not found on GitHub/.test(stores.feature_runs[0].delivery_label), true);
});

test("a feature re-seeded to a fresh incarnation is NOT failed (guarded CAS, #808)", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#17");
  const lookup = async () => {
    // startFeature re-seeds between the scan and the write: NULL process_key, status running.
    Object.assign(stores.feature_runs[0], { status: "running", process_key: null });
    return "not_found" as MissingPrLookup;
  };
  await reconcileMissingPrRows(data, "", { lookup, nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked: new Map() });
  assertEquals(stores.feature_runs[0].status, "running");
});

test("opened + converge=1 feature is reconciled; opened without converge is ignored", async () => {
  for (const converge of [1, 0]) {
    const { data, stores } = memData();
    seedFeature(stores, "o/r#18");
    Object.assign(stores.feature_runs[0], { status: "opened", converge });
    await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked: new Map() });
    assertEquals(stores.feature_runs[0].status, converge ? "failed" : "opened");
  }
});

test("lookups for the same missing key are throttled", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#19");
  let calls = 0;
  const lookup = async () => {
    calls++;
    return "open" as MissingPrLookup;
  };
  const lastChecked = new Map<string, number>();
  await reconcileMissingPrRows(data, "", { lookup, nowMs: T0, lastChecked });
  await reconcileMissingPrRows(data, "", { lookup, nowMs: T0 + MISSING_PR_RECHECK_MS - 1, lastChecked });
  assertEquals(calls, 1);
  await reconcileMissingPrRows(data, "", { lookup, nowMs: T0 + MISSING_PR_RECHECK_MS, lastChecked });
  assertEquals(calls, 2);
});

test("classifyMissingPrError: only a PR-level miss is not_found", () => {
  assertEquals(classifyMissingPrError(new Error("GraphQL: Could not resolve to a PullRequest with the number of 9.")), "not_found");
  for (const msg of [
    "GraphQL: Could not resolve to a Repository with the name 'o/private'.",
    "HTTP 404: Not Found",
    "github 404 Not Found",
    "HTTP 401: Bad credentials",
    "API rate limit exceeded",
    "connect ECONNREFUSED",
  ]) {
    assertEquals(classifyMissingPrError(new Error(msg)), null);
  }
});

test("a verified-absent feature PR is not re-enrolled between passes, so grace expiry still fails it", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#20");
  const notFound = new Set<string>();
  const lastChecked = new Map<string, number>();
  let creates = 0;
  const engine = {
    createInstance: async () => {
      creates++;
      return { processInstanceKey: "x" };
    },
    searchProcessInstances: async () => [],
  } as any;
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + 1000, lastChecked, notFound });
  // A second, throttled pass must not drop the verdict (it once was, as the stale-verdict sweep ran
  // before feature runs were noted).
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + 2000, lastChecked, notFound });
  assertEquals(notFound.has("o/r#20"), true);
  await pollFeatureDelivery(data, engine, { missingPrNotFound: notFound });
  assertEquals(creates, 0);
  assertEquals(stores.pull_requests ?? [], []);
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked, notFound });
  assertEquals(stores.feature_runs[0].status, "failed");
  assertEquals(notFound.size, 0);
});

test("a key GitHub reports again (open) loses its absent verdict and is re-enrollable", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#21");
  const notFound = new Set<string>(["o/r#21"]);
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("open"), nowMs: T0, lastChecked: new Map(), notFound });
  assertEquals(notFound.has("o/r#21"), false);
});

test("settled done epics cost one task read per pass, not one per epic", async () => {
  const { data, stores } = memData();
  stores.plans = Array.from({ length: 5 }, (_, i) => ({ plan_key: `o/r#${100 + i}`, status: "done" }));
  stores.plan_tasks = [];
  const tasks = (data as any).table("plan_tasks");
  let finds = 0;
  let alls = 0;
  const orig = (data as any).table;
  (data as any).table = (n: string, pk?: string) => {
    const t = orig(n, pk);
    if (n !== "plan_tasks") return t;
    return { ...t, find: async (w: any) => (finds++, t.find(w)), all: async () => (alls++, t.all()) };
  };
  void tasks;
  await reconcileMissingPrRows(data, "", { lookup: lookupOf(null), nowMs: T0, lastChecked: new Map(), notFound: new Set() });
  assertEquals({ finds, alls }, { finds: 0, alls: 1 });
});

test("a terminal write racing an in-flight submitPr enrollment waits for it (no PK conflict)", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#30");
  // Make submitPr's first PR-row read slow, so without the shared per-PR lock the reconciler's insert
  // lands between submitPr's "no row" read and its own insert.
  const orig = (data as any).table;
  let gate!: () => void;
  const held = new Promise<void>((r) => (gate = r));
  let firstGet = true;
  (data as any).table = (n: string, pk?: string) => {
    const t = orig(n, pk);
    if (n !== "pull_requests") return t;
    return {
      ...t,
      get: async (id: any) => {
        const v = await t.get(id);
        if (firstGet) {
          firstGet = false;
          await held;
        }
        return v;
      },
      insert: async (row: any) => {
        if (await t.get(row.pr_key)) throw new Error("UNIQUE constraint failed: pull_requests.pr_key");
        return t.insert(row);
      },
    };
  };
  const engine = {
    createInstance: async () => ({ processInstanceKey: "x" }),
    searchProcessInstances: async () => [],
    setVariables: async () => {},
  } as any;
  const { submitPr } = await import("./service.ts");
  const prev = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevFetch = globalThis.fetch;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  globalThis.fetch = (async () => new Response(JSON.stringify({ title: "t", body: "", head: { ref: "h", sha: "s" }, base: { ref: "main" } }), { status: 200 })) as typeof fetch;
  try {
    const sub = submitPr(data, engine, { repo: "o/r", number: 30, prKey: "o/r#30" } as any);
    const rec = reconcileMissingPrRows(data, "", { lookup: lookupOf("merged"), nowMs: T0, lastChecked: new Map(), notFound: new Set() });
    await new Promise((r) => setTimeout(r, 10));
    gate();
    await sub;
    await rec;
  } finally {
    globalThis.fetch = prevFetch;
    if (prev === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prev;
  }
  assertEquals(stores.pull_requests.length, 1);
});

async function withFetch(responses: Array<{ status: number; body?: unknown } | Error>, fn: () => Promise<void>) {
  const prevFetch = globalThis.fetch;
  const prevT = process.env.NANO_PR_GITHUB_TRANSPORT;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  const queue = responses.slice();
  globalThis.fetch = (async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevT === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prevT;
  }
}

test("lookupMissingPr (token): 404 + readable PR list → not_found", async () => {
  await withFetch([{ status: 404 }, { status: 200, body: [] }], async () => {
    assertEquals(await lookupMissingPr("o/r", 1, "t"), "not_found");
  });
});

test("lookupMissingPr (token): 404 + denied/failed PR-list probe → unknown", async () => {
  for (const probe of [{ status: 404 }, { status: 403 }, { status: 500 }, new Error("ECONNRESET")]) {
    await withFetch([{ status: 404 }, probe], async () => {
      assertEquals(await lookupMissingPr("o/r", 1, "t"), null);
    });
  }
});

test("lookupMissingPr (token): parses merged / closed-unmerged / open; non-404 error → unknown; no token → unknown", async () => {
  await withFetch([{ status: 200, body: { state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z" } }], async () => {
    assertEquals(await lookupMissingPr("o/r", 1, "t"), "merged");
  });
  await withFetch([{ status: 200, body: { state: "closed", merged: false, merged_at: null } }], async () => {
    assertEquals(await lookupMissingPr("o/r", 1, "t"), "closed");
  });
  await withFetch([{ status: 200, body: { state: "open", merged: false } }], async () => {
    assertEquals(await lookupMissingPr("o/r", 1, "t"), "open");
  });
  await withFetch([{ status: 502 }], async () => {
    assertEquals(await lookupMissingPr("o/r", 1, "t"), null);
  });
  await withFetch([], async () => {
    assertEquals(await lookupMissingPr("o/r", 1, ""), null);
  });
});

test("a recovered merged row runs the epic's merged-completion retro hook", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#40");
  const lookups: unknown[] = [];
  const orig = (data as any).table;
  (data as any).table = (n: string, pk?: string) => {
    const t = orig(n, pk);
    if (n !== "plan_tasks") return t;
    return { ...t, findOne: async (w: any) => (lookups.push(w), t.findOne(w)) };
  };
  const engine = { createInstance: async () => ({ processInstanceKey: "r" }), searchProcessInstances: async () => [] } as any;
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("merged"), nowMs: T0, lastChecked: new Map(), engine });
  assertEquals(stores.pull_requests[0].status, "merged");
  // maybeStartRetro resolves the PR's plan via `plan_tasks`; the lookup proves the hook ran.
  assertEquals(lookups, [{ pr_key: "o/r#40" }]);
  // A second pass sees the restored row, so the PR is no longer missing and the hook does not re-fire.
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("merged"), nowMs: T0 + 1, lastChecked: new Map(), engine });
  assertEquals(lookups, [{ pr_key: "o/r#40" }]);
});

test("delivery edge (3) leaves a verified-absent mid-handoff feature to the grace verdict", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#2", process_key: "p1", status: "opened", pr_key: "o/r#41", converge: 1, created_at: ISO0, updated_at: ISO0 },
  ];
  const notFound = new Set<string>();
  const lastChecked = new Map<string, number>();
  // Feature instance gone: without the guard, edge (3) folds `abandoned` / `handoff interrupted`.
  const engine = { createInstance: async () => ({ processInstanceKey: "x" }), searchProcessInstances: async () => [] } as any;
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + 1000, lastChecked, notFound });
  await pollFeatureDelivery(data, engine, { missingPrNotFound: notFound });
  assertEquals(stores.feature_runs[0].status, "opened");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked, notFound });
  assertEquals(stores.feature_runs[0].status, "failed");
  assertEquals(/not found on GitHub/.test(stores.feature_runs[0].delivery_label), true);
});

test("an UNKNOWN first lookup does not let edge (1) enroll the PR, so a later definitive miss still fails it past grace", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#30");
  const notFound = new Set<string>();
  const unverified = new Set<string>();
  const lastChecked = new Map<string, number>();
  let creates = 0;
  const engine = {
    createInstance: async () => {
      creates++;
      return { processInstanceKey: "x" };
    },
    searchProcessInstances: async () => [],
  } as any;
  await reconcileMissingPrRows(data, "", { lookup: lookupOf(null), nowMs: T0 + 1000, lastChecked, notFound, unverified });
  assertEquals(unverified.has("o/r#30"), true);
  await pollFeatureDelivery(data, engine, { missingPrNotFound: notFound, missingPrUnverified: unverified });
  assertEquals(creates, 0);
  assertEquals(stores.pull_requests ?? [], []);
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked, notFound, unverified });
  assertEquals(stores.feature_runs[0].status, "failed");
  assertEquals(unverified.size, 0);
});

test("a positive open answer clears the unknown verdict so the PR becomes re-enrollable", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#31");
  const unverified = new Set<string>(["o/r#31"]);
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("open"), nowMs: T0, lastChecked: new Map(), notFound: new Set(), unverified });
  assertEquals(unverified.has("o/r#31"), false);
});

test("recovered rows carry the origin root_request_key (feature, else epic) for lineage drill-down", async () => {
  for (const answer of ["merged", "closed", "not_found"] as MissingPrLookup[]) {
    const { data, stores } = memData();
    seedEpic(stores, "o/r#32");
    seedFeature(stores, "o/r#33");
    await reconcileMissingPrRows(data, "", { lookup: lookupOf(answer), nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked: new Map(), notFound: new Set(), unverified: new Set() });
    assertEquals(stores.pull_requests.find((r: any) => r.pr_key === "o/r#32").root_request_key, "o/r#1");
    assertEquals(stores.pull_requests.find((r: any) => r.pr_key === "o/r#33").root_request_key, "o/r#2");
  }
});

test("a KEYLESS opened+converge feature is failed past grace; a re-seeded keyless run is not", async () => {
  for (const reseed of [false, true]) {
    const { data, stores } = memData();
    stores.feature_runs = [
      { feature_key: "o/r#2", process_key: null, status: "opened", pr_key: "o/r#34", converge: 1, created_at: ISO0, updated_at: ISO0 },
    ];
    const lookup = async () => {
      if (reseed) Object.assign(stores.feature_runs[0], { updated_at: new Date(T0 + 5).toISOString() });
      return "not_found" as MissingPrLookup;
    };
    await reconcileMissingPrRows(data, "", { lookup, nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked: new Map(), notFound: new Set(), unverified: new Set() });
    assertEquals(stores.feature_runs[0].status, reseed ? "opened" : "failed");
  }
});

test("lookupMissingPr (token): a stalled request is bounded by the lookup deadline → unknown", async () => {
  const prevFetch = globalThis.fetch;
  const prevT = process.env.NANO_PR_GITHUB_TRANSPORT;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  globalThis.fetch = ((_u: string, init: any) =>
    new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))) as any;
  try {
    assertEquals(await lookupMissingPr("o/r", 1, "t", 20), null);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevT === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prevT;
  }
});

test("a KEYLESS opened+converge feature is folded on a recovered merged/closed PR, not stranded", async () => {
  for (const [answer, want] of [["merged", "merged"], ["closed", "abandoned"]] as const) {
    const { data, stores } = memData();
    stores.feature_runs = [
      { feature_key: "o/r#2", process_key: null, status: "opened", pr_key: "o/r#35", converge: 1, created_at: ISO0, updated_at: ISO0 },
    ];
    await reconcileMissingPrRows(data, "", { lookup: lookupOf(answer), nowMs: T0, lastChecked: new Map(), notFound: new Set(), unverified: new Set() });
    assertEquals(stores.feature_runs[0].status, want);
  }
});

test("an opened feature whose first lookup is UNKNOWN is not handoff-abandoned; a later definitive answer decides it", async () => {
  for (const [answer, want] of [["merged", "merged"], ["not_found", "failed"]] as const) {
    const { data, stores } = memData();
    stores.feature_runs = [
      { feature_key: "o/r#2", process_key: "p1", status: "opened", pr_key: "o/r#36", converge: 1, created_at: ISO0, updated_at: ISO0 },
    ];
    const notFound = new Set<string>();
    const unverified = new Set<string>();
    const lastChecked = new Map<string, number>();
    const engine = { createInstance: async () => ({ processInstanceKey: "x" }), searchProcessInstances: async () => [] } as any;
    await reconcileMissingPrRows(data, "", { lookup: lookupOf(null), nowMs: T0 + 1000, lastChecked, notFound, unverified });
    await pollFeatureDelivery(data, engine, { missingPrNotFound: notFound, missingPrUnverified: unverified });
    assertEquals(stores.feature_runs[0].status, "opened");
    await reconcileMissingPrRows(data, "", { lookup: lookupOf(answer), nowMs: T0 + MISSING_PR_GRACE_MS, lastChecked, notFound, unverified });
    if (answer === "merged") await pollFeatureDelivery(data, engine, { missingPrNotFound: notFound, missingPrUnverified: unverified });
    assertEquals(stores.feature_runs[0].status, want);
  }
});
