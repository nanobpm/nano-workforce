// Guard matrix for the promoteEpic operation (issue #160, P2/P5). Drives the seam-injected core
// `runPromoteEpic` against an in-memory data layer with stubbed GitHub helpers so every branch —
// the rejections, the idempotency short-circuit, the happy open, and GitHub's "already exists"
// recovery — is exercised without a live GitHub. The default export's missing-body 400 is covered too.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import type { OpenPrResult } from "../app/github.ts";
import { noopLog } from "../test/log.ts";
import promoteEpic, { type PromoteEpicDeps, runPromoteEpic } from "./promoteEpic.ts";

interface Row {
  [k: string]: unknown;
}

/** A minimal in-memory data layer with the two tables the delegate reads (`plans`, `plan_tasks`). */
function makeApp(plansRows: Row[], taskRows: Row[] = []) {
  const tables: Record<string, { key: string; rows: Row[] }> = {
    plans: { key: "plan_key", rows: plansRows },
    plan_tasks: { key: "id", rows: taskRows },
  };
  const data = {
    table: (name: string, key: string) => {
      const t = tables[name] ?? { key, rows: [] };
      return {
        get: (k: unknown) => Promise.resolve(t.rows.find((r) => r[t.key] === k) ?? null),
        find: (q: Record<string, unknown>) =>
          Promise.resolve(t.rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
        insert: (r: Row) => {
          t.rows.push(r);
          return Promise.resolve(r);
        },
        update: (k: unknown, patch: Row) => {
          const row = t.rows.find((r) => r[t.key] === k);
          if (row) Object.assign(row, patch);
          return Promise.resolve(row);
        },
        delete: (k: unknown) => {
          const i = t.rows.findIndex((r) => r[t.key] === k);
          if (i >= 0) t.rows.splice(i, 1);
          return Promise.resolve();
        },
      };
    },
  };
  return { app: { data, log: noopLog() } as unknown as AppApi, plansRows, taskRows };
}

function donePlan(over: Row = {}): Row {
  return {
    plan_key: "o/r#160",
    repo: "o/r",
    issue_number: 160,
    issue_url: "https://github.com/o/r/issues/160",
    title: "Epic",
    status: "done",
    task_count: 2,
    base_branch: "epic/promote-to-main",
    promotion_pr_url: null,
    promote_ready: 1,
    created_at: "t",
    updated_at: "t",
    ...over,
  };
}

/** Deps that count calls, so a test can assert "opened exactly one PR" / "opened nothing". */
function deps(over: Partial<PromoteEpicDeps> = {}) {
  const calls = { open: 0, byHead: 0, defaultBranch: 0 };
  const d: PromoteEpicDeps = {
    token: "tok",
    fetchDefaultBranch: async () => {
      calls.defaultBranch++;
      return "main";
    },
    openPullRequest: async (): Promise<OpenPrResult | null> => {
      calls.open++;
      return { outcome: "opened", url: "https://github.com/o/r/pull/9", number: 9 };
    },
    fetchOpenPrByHead: async () => {
      calls.byHead++;
      return { url: "https://github.com/o/r/pull/7", number: 7 };
    },
    ...over,
  };
  return { d, calls };
}

test("(a) not-done plan → rejected, opens nothing", async () => {
  const { app } = makeApp([donePlan({ status: "running" })]);
  const { d, calls } = deps();
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 409);
  assertEquals(calls.open, 0);
});

test("(b) base_branch null → rejected, opens nothing", async () => {
  const { app } = makeApp([donePlan({ base_branch: null })]);
  const { d, calls } = deps();
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 409);
  assertEquals(calls.open, 0);
});

test("(c) base_branch equals repo default → rejected, opens nothing", async () => {
  const { app } = makeApp([donePlan({ base_branch: "main" })]);
  const { d, calls } = deps();
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 409);
  assertEquals(calls.defaultBranch, 1);
  assertEquals(calls.open, 0);
});

test("unknown plan → 404", async () => {
  const { app } = makeApp([]);
  const { d, calls } = deps();
  const res = await runPromoteEpic(app, "o/r#999", d);
  assertEquals(res.status, 404);
  assertEquals(calls.open, 0);
});

test("(d) already-promoted (promotion_pr_url set) → returns existing PR, opens nothing", async () => {
  const url = "https://github.com/o/r/pull/3";
  const { app } = makeApp([donePlan({ promotion_pr_url: url, promote_ready: 0 })]);
  const { d, calls } = deps();
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 200);
  assert(res.status === 200);
  assertEquals(res.body.url, url);
  assertEquals(res.body.promoted, false);
  assertEquals(calls.open, 0);
  assertEquals(calls.defaultBranch, 0);
});

test("(e) happy path → opens exactly one PR, persists promotion_pr_url, sets promote_ready = 0", async () => {
  const { app, plansRows } = makeApp([donePlan()], [
    { id: 1, plan_key: "o/r#160", pr_key: "o/r#161", summary: "slice one" },
    { id: 2, plan_key: "o/r#160", pr_key: "o/r#162", summary: "slice two" },
  ]);
  const { d, calls } = deps();
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 202);
  assert(res.status === 202);
  assertEquals(res.body.url, "https://github.com/o/r/pull/9");
  assertEquals(res.body.number, 9);
  assertEquals(res.body.promoted, true);
  assertEquals(calls.open, 1);
  assertEquals(plansRows[0].promotion_pr_url, "https://github.com/o/r/pull/9");
  assertEquals(plansRows[0].promote_ready, 0);
});

test("(e') happy path passes default branch as base and integration branch as head", async () => {
  const { app } = makeApp([donePlan()]);
  let captured: { base?: string; head?: string } = {};
  const { d } = deps({
    openPullRequest: async (_repo, base, head) => {
      captured = { base, head };
      return { outcome: "opened", url: "https://github.com/o/r/pull/9", number: 9 };
    },
  });
  await runPromoteEpic(app, "o/r#160", d);
  assertEquals(captured.base, "main");
  assertEquals(captured.head, "epic/promote-to-main");
});

test("(f) idempotent re-invoke after a successful promote → returns existing PR, opens nothing", async () => {
  const { app, plansRows } = makeApp([donePlan()]);
  const first = deps();
  const r1 = await runPromoteEpic(app, "o/r#160", first.d);
  assertEquals(r1.status, 202);
  assertEquals(first.calls.open, 1);

  // Second call sees the persisted promotion_pr_url and short-circuits.
  const second = deps();
  const r2 = await runPromoteEpic(app, "o/r#160", second.d);
  assertEquals(r2.status, 200);
  assert(r2.status === 200);
  assertEquals(r2.body.url, "https://github.com/o/r/pull/9");
  assertEquals(r2.body.promoted, false);
  assertEquals(second.calls.open, 0);
  assertEquals(second.calls.defaultBranch, 0);
  assertEquals(plansRows[0].promote_ready, 0);
});

test("(g) GitHub-side 'PR already exists' → treated as success, existing URL recovered and persisted", async () => {
  const { app, plansRows } = makeApp([donePlan()]);
  const { d, calls } = deps({
    openPullRequest: async (): Promise<OpenPrResult> => {
      calls.open++;
      return { outcome: "exists", detail: "A pull request already exists for o:epic/promote-to-main." };
    },
  });
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 200);
  assert(res.status === 200);
  assertEquals(res.body.url, "https://github.com/o/r/pull/7");
  assertEquals(res.body.number, 7);
  assertEquals(res.body.promoted, false);
  assertEquals(calls.byHead, 1);
  assertEquals(plansRows[0].promotion_pr_url, "https://github.com/o/r/pull/7");
  assertEquals(plansRows[0].promote_ready, 0);
});

test("(g') GitHub 'exists' but the open PR can't be recovered → 502, nothing persisted", async () => {
  const { app, plansRows } = makeApp([donePlan()]);
  const { d } = deps({
    openPullRequest: async (): Promise<OpenPrResult> => ({ outcome: "exists", detail: "already exists" }),
    fetchOpenPrByHead: async () => null,
  });
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 502);
  assertEquals(plansRows[0].promotion_pr_url, null);
});

test("GitHub refuses base/head as invalid → 409, nothing persisted", async () => {
  const { app, plansRows } = makeApp([donePlan()]);
  const { d } = deps({
    openPullRequest: async (): Promise<OpenPrResult> => ({ outcome: "invalid", detail: "No commits between main and epic" }),
  });
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 409);
  assertEquals(plansRows[0].promotion_pr_url, null);
});

test("no GitHub transport (openPullRequest → null) → 502", async () => {
  const { app } = makeApp([donePlan()]);
  const { d } = deps({ openPullRequest: async () => null });
  const res = await runPromoteEpic(app, "o/r#160", d);
  assertEquals(res.status, 502);
});

test("default export: missing/invalid body → 400", async () => {
  const { app } = makeApp([]);
  const input = (body: unknown) => ({
    req: { method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" },
    params: {},
    query: {},
    body,
  });
  // biome-ignore lint/suspicious/noExplicitAny: driving the delegate with an intentionally-invalid body
  assertEquals((await promoteEpic(input(undefined) as any, app)).status, 400);
  // biome-ignore lint/suspicious/noExplicitAny: driving the delegate with an intentionally-invalid body
  assertEquals((await promoteEpic(input({ planKey: "   " }) as any, app)).status, 400);
  // A well-formed non-empty string that isn't `owner/repo#N` is a client error (400), not a 404.
  // biome-ignore lint/suspicious/noExplicitAny: driving the delegate with an intentionally-malformed key
  assertEquals((await promoteEpic(input({ planKey: "not-a-plan-key" }) as any, app)).status, 400);
  // biome-ignore lint/suspicious/noExplicitAny: driving the delegate with an intentionally-malformed key
  assertEquals((await promoteEpic(input({ planKey: "o/r#" }) as any, app)).status, 400);
  // biome-ignore lint/suspicious/noExplicitAny: driving the delegate with an intentionally-malformed key
  assertEquals((await promoteEpic(input({ planKey: "o/r160" }) as any, app)).status, 400);
});
