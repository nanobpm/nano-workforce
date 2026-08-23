// Integration tests for the epic promotion poller pass (issue #299). `pollPromotion` is the missing
// counterpart to `ensureBaseBranch`: once an epic has LANDED on its custom `epic/*` integration
// branch (every slice PR merged → `plans.delivery = landed`), it opens exactly ONE `epic/* →
// <default>` promotion PR and enrolls it into the convergence + merge loop. These tests exercise the
// issue's red/green plan against an in-memory data layer + a stubbed GitHub (token) transport + a
// recording engine: open exactly one PR, never a duplicate on re-run, never for a converging epic,
// and never for a `main`-based epic.
import { test } from "node:test";
import { withTrackingViews } from "../test/trackingViews.ts";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { resetDefaultBranchCache } from "./github.ts";
import { pollPromotion } from "./service.ts";

// In-memory record gateway (all/get/find/insert/update/delete), mirroring app/delivery.test.ts but
// with `delete` (submitPr's `registerDependencies` clears the PR's dep set on submit).
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
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      async delete(id: any) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i][pk] === id) rows.splice(i, 1);
      },
    };
  }
  const data = { table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)) } as any as DataLayer;
  return { data, stores };
}

// A recording engine stub: every `submitPr` starts a convergence instance via `createInstance`.
function recordingEngine(): { engine: EngineClient; instances: any[] } {
  const instances: any[] = [];
  const engine = {
    async createInstance(req: any) {
      instances.push(req);
      return { processInstanceKey: `pi-${instances.length}` };
    },
  } as any as EngineClient;
  return { engine, instances };
}

// A fake GitHub repo model served over the token transport. Tracks the default branch and the PRs
// keyed by head branch; records every create so a test can assert exactly-once.
interface FakeRepo {
  repo: string;
  defaultBranch: string;
  prsByHead: Map<string, { number: number; state: string; baseRef: string }[]>;
  creates: { head: string; base: string; title: string; number: number }[];
  nextNumber: number;
}

function githubFetch(state: FakeRepo) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    const json = (obj: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));

    if (method === "GET" && path === `/repos/${state.repo}`) {
      return json({ default_branch: state.defaultBranch });
    }
    if (method === "GET" && path === `/repos/${state.repo}/pulls`) {
      // listPrsForHead: ?head=owner:branch
      const head = (u.searchParams.get("head") ?? "").split(":").pop() ?? "";
      const list = state.prsByHead.get(head) ?? [];
      return json(
        list.map((p) => ({
          number: p.number,
          html_url: `https://github.com/${state.repo}/pull/${p.number}`,
          state: p.state,
          base: { ref: p.baseRef },
        })),
      );
    }
    if (method === "POST" && path === `/repos/${state.repo}/pulls`) {
      // biome-ignore lint/plugin: test fixture parsing an external body shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { head?: string; base?: string; title?: string };
      const head = String(body.head ?? "");
      const number = state.nextNumber++;
      state.creates.push({ head, base: String(body.base ?? ""), title: String(body.title ?? ""), number });
      const arr = state.prsByHead.get(head) ?? [];
      arr.push({ number, state: "open", baseRef: String(body.base ?? "") });
      state.prsByHead.set(head, arr);
      return json({ number, html_url: `https://github.com/${state.repo}/pull/${number}` }, 201);
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withGithub<T>(state: FakeRepo, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  const prevToken = process.env.GITHUB_TOKEN;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  // Leave GITHUB_TOKEN empty so submitPr's best-effort PR-meta enrichment is skipped (no fetch),
  // while pollPromotion's own GitHub calls use the explicit "tok" argument.
  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = githubFetch(state) as typeof fetch;
  resetDefaultBranchCache();
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    resetDefaultBranchCache();
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken;
  }
}

function freshRepo(defaultBranch = "main"): FakeRepo {
  return { repo: "o/r", defaultBranch, prsByHead: new Map(), creates: [], nextNumber: 500 };
}

test("pollPromotion: a landed epic on an epic/* base opens exactly one epic/*→default PR", async () => {
  const { data, stores } = memData();
  const { engine, instances } = recordingEngine();
  stores.plans = [
    { plan_key: "o/r#295", repo: "o/r", title: "Assertion DSL", status: "done", base_branch: "epic/test-dsl", delivery: "landed", promotion_pr: null, promotion_state: null },
  ];
  stores.plan_tasks = [
    { id: 1, plan_key: "o/r#295", pr_key: "o/r#299" },
    { id: 2, plan_key: "o/r#295", pr_key: "o/r#304" },
  ];
  stores.pull_requests = [
    { pr_key: "o/r#299", status: "merged" },
    { pr_key: "o/r#304", status: "merged" },
  ];
  const state = freshRepo();

  await withGithub(state, () => pollPromotion(data, engine, "tok"));

  assertEquals(state.creates.length, 1);
  assertEquals(state.creates[0].head, "epic/test-dsl");
  assertEquals(state.creates[0].base, "main");
  assertEquals(stores.plans[0].promotion_pr, "o/r#500");
  assertEquals(stores.plans[0].promotion_state, "open");
  // The promotion PR was enrolled into the convergence loop (a real PR, not an auto-merge).
  assertEquals(instances.length, 1);
  assertEquals(instances[0].variables.prKey, "o/r#500");
  const prRow = stores.pull_requests.find((p) => p.pr_key === "o/r#500");
  assert(prRow, "promotion PR row registered by submitPr");
});

test("pollPromotion: re-running is idempotent — no duplicate promotion PR", async () => {
  const { data, stores } = memData();
  const { engine } = recordingEngine();
  stores.plans = [
    { plan_key: "o/r#295", repo: "o/r", title: "Assertion DSL", status: "done", base_branch: "epic/test-dsl", delivery: "landed", promotion_pr: null, promotion_state: null },
  ];
  stores.plan_tasks = [{ id: 1, plan_key: "o/r#295", pr_key: "o/r#299" }];
  stores.pull_requests = [{ pr_key: "o/r#299", status: "merged" }];
  const state = freshRepo();

  await withGithub(state, async () => {
    await pollPromotion(data, engine, "tok");
    await pollPromotion(data, engine, "tok");
    await pollPromotion(data, engine, "tok");
  });

  assertEquals(state.creates.length, 1, "exactly one promotion PR across three passes");
  assertEquals(stores.plans[0].promotion_pr, "o/r#500");
});

test("pollPromotion: a still-converging epic opens no promotion PR", async () => {
  const { data, stores } = memData();
  const { engine } = recordingEngine();
  stores.plans = [
    { plan_key: "o/r#296", repo: "o/r", title: "WIP", status: "done", base_branch: "epic/wip", delivery: "converging", promotion_pr: null, promotion_state: null },
  ];
  stores.plan_tasks = [{ id: 1, plan_key: "o/r#296", pr_key: "o/r#310" }];
  stores.pull_requests = [{ pr_key: "o/r#310", status: "converging" }];
  const state = freshRepo();

  await withGithub(state, () => pollPromotion(data, engine, "tok"));

  assertEquals(state.creates.length, 0);
  assertEquals(stores.plans[0].promotion_pr, null);
  assertEquals(stores.plans[0].promotion_state, null);
});

test("pollPromotion: a main-based epic has nothing to promote", async () => {
  const { data, stores } = memData();
  const { engine } = recordingEngine();
  stores.plans = [
    { plan_key: "o/r#297", repo: "o/r", title: "Direct", status: "done", base_branch: "main", delivery: "landed", promotion_pr: null, promotion_state: null },
  ];
  stores.plan_tasks = [{ id: 1, plan_key: "o/r#297", pr_key: "o/r#320" }];
  stores.pull_requests = [{ pr_key: "o/r#320", status: "merged" }];
  const state = freshRepo();

  await withGithub(state, () => pollPromotion(data, engine, "tok"));

  assertEquals(state.creates.length, 0);
  assertEquals(stores.plans[0].promotion_pr, null);
  assertEquals(stores.plans[0].promotion_state, null);
});

test("pollPromotion: reuses an existing PR from the integration branch (crash-recovery idempotency)", async () => {
  const { data, stores } = memData();
  const { engine } = recordingEngine();
  stores.plans = [
    { plan_key: "o/r#295", repo: "o/r", title: "Assertion DSL", status: "done", base_branch: "epic/test-dsl", delivery: "landed", promotion_pr: null, promotion_state: null },
  ];
  stores.plan_tasks = [{ id: 1, plan_key: "o/r#295", pr_key: "o/r#299" }];
  stores.pull_requests = [{ pr_key: "o/r#299", status: "merged" }];
  const state = freshRepo();
  // A prior pass created the PR on GitHub but crashed before persisting `promotion_pr`.
  state.prsByHead.set("epic/test-dsl", [{ number: 777, state: "open", baseRef: "main" }]);

  await withGithub(state, () => pollPromotion(data, engine, "tok"));

  assertEquals(state.creates.length, 0, "existing PR reused, not duplicated");
  assertEquals(stores.plans[0].promotion_pr, "o/r#777");
  assertEquals(stores.plans[0].promotion_state, "open");
});

test("pollPromotion: projects `promoted` once the promotion PR merges", async () => {
  const { data, stores } = memData();
  const { engine } = recordingEngine();
  stores.plans = [
    { plan_key: "o/r#295", repo: "o/r", title: "Assertion DSL", status: "done", base_branch: "epic/test-dsl", delivery: "landed", promotion_pr: "o/r#500", promotion_state: "open" },
  ];
  stores.plan_tasks = [{ id: 1, plan_key: "o/r#295", pr_key: "o/r#299" }];
  stores.pull_requests = [
    { pr_key: "o/r#299", status: "merged" },
    { pr_key: "o/r#500", status: "merged" },
  ];
  const state = freshRepo();

  await withGithub(state, () => pollPromotion(data, engine, "tok"));

  assertEquals(state.creates.length, 0);
  assertEquals(stores.plans[0].promotion_state, "promoted");
});
