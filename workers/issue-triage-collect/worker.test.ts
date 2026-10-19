// Unit coverage for pr.issue-triage-collect (issue #896): drives the handler against the real data
// layer, a fake GitHub (token transport over a stubbed `fetch`) and a stubbed engine, asserting the
// off-by-default switch, the overlap guard, and which issues are collected.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { recordTriageDecision } from "../../app/issueTriage.ts";
import handler from "./worker.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

interface Gh {
  labels: Record<string, string[]>;
  issues: Record<string, Record<string, unknown>[]>;
  fail?: Set<string>;
}

function fakeFetch(gh: Gh): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(labels|issues)$/);
    if (!m) return new Response("not found", { status: 404 });
    const [, repo, kind] = m;
    if (gh.fail?.has(repo)) return new Response("boom", { status: 500 });
    const page = Number(url.searchParams.get("page") ?? "1");
    const all = kind === "labels" ? (gh.labels[repo] ?? []).map((name) => ({ name })) : (gh.issues[repo] ?? []);
    return Response.json(all.slice((page - 1) * 100, page * 100));
  }) as typeof fetch;
}

const issue = (n: number, labels: string[] = [], extra: Record<string, unknown> = {}) => ({
  number: n, title: `Issue ${n}`, body: `body ${n}`, html_url: `https://github.com/o/r/issues/${n}`, labels: labels.map((name) => ({ name })), ...extra,
});

type Out = { candidateCount: number; candidates: string[]; agentSlaTimeout?: string; skippedReason?: string };

async function withApp(
  opts: { env: Record<string, string>; gh: Gh; active?: string[] },
  fn: (run: () => Promise<Out>, data: DataLayer) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-triage-col-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  const keys = ["NANO_ISSUE_TRIAGE", "NANO_ISSUE_TRIAGE_REPOS", "NANO_ISSUE_TRIAGE_MAX_ISSUES", "NANO_PR_GITHUB_TRANSPORT", "GITHUB_TOKEN"];
  const prevEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const prevFetch = globalThis.fetch;
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "tok" }, opts.env);
  globalThis.fetch = fakeFetch(opts.gh);
  try {
    const engine = {
      searchProcessInstances: () => Promise.resolve([...(opts.active ?? []), "PI-THIS"].map((processInstanceKey) => ({ processInstanceKey, state: "ACTIVE" }))),
    };
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const run = async () => (await handler({ jobKey: "J", processInstanceKey: "PI-THIS", variables: {} } as never, { data: app.db, engine, log } as never)) as Out;
    await fn(run, app.db);
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of keys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const gh = (): Gh => ({
  labels: { "o/r": ["bug", "enhancement", "queued", "dequeued"] },
  issues: { "o/r": [issue(1), issue(2, ["bug"]), issue(3, [], { pull_request: {} }), issue(4), issue(5)] },
});
const ON = { NANO_ISSUE_TRIAGE: "on", NANO_ISSUE_TRIAGE_REPOS: "o/r" };

test("off by default: the tick is a no-op that still seeds agentSlaTimeout", async () => {
  await withApp({ env: { NANO_ISSUE_TRIAGE_REPOS: "o/r" }, gh: gh() }, async (run) => {
    const out = await run();
    assertEquals(out.candidateCount, 0);
    assertEquals(out.skippedReason, "disabled");
    assertEquals(typeof out.agentSlaTimeout, "string");
  });
});

test("collects open, unlabelled, undecided issues (not PRs) with the repo's applicable labels", async () => {
  await withApp({ env: ON, gh: gh() }, async (run, data) => {
    await recordTriageDecision(data, { repo: "o/r", issue: 4, status: "skipped", labels: [] });
    await recordTriageDecision(data, { repo: "o/r", issue: 5, status: "failed", labels: [] }); // failed → retried
    const out = await run();
    const parsed = out.candidates.map((c) => JSON.parse(c));
    assertEquals(parsed.map((c) => c.issue), [1, 5]);
    assertEquals(out.candidateCount, 2);
    assertEquals(parsed[0], { repo: "o/r", issue: 1, title: "Issue 1", body: "body 1", url: "https://github.com/o/r/issues/1", labels: ["bug", "enhancement"] });
  });
});

test("the per-repo cap bounds the batch", async () => {
  await withApp({ env: { ...ON, NANO_ISSUE_TRIAGE_MAX_ISSUES: "1" }, gh: gh() }, async (run) => {
    assertEquals((await run()).candidateCount, 1);
  });
});

test("overlap guard: a previous tick still running makes this tick a no-op", async () => {
  await withApp({ env: ON, gh: gh(), active: ["PI-OLD"] }, async (run) => {
    const out = await run();
    assertEquals(out.candidateCount, 0);
    assertEquals(out.skippedReason, "previous tick still running");
  });
});

test("a previous tick parked on its human review does not block a new tick", async () => {
  await withApp({ env: ON, gh: gh(), active: ["PI-OLD"] }, async (run, data) => {
    await recordTriageDecision(data, { repo: "o/r", issue: 1, status: "escalated", labels: ["bug"], processKey: "PI-OLD" });
    const out = await run();
    // Issue 1 is already in the ledger (escalated, awaiting that review), so only 4 and 5 are new.
    assertEquals(out.candidates.map((c) => JSON.parse(c).issue), [4, 5]);
  });
});

test("an unreadable repo or invalid slug is skipped without failing the tick", async () => {
  const g = gh();
  g.fail = new Set(["o/r"]);
  await withApp({ env: { ...ON, NANO_ISSUE_TRIAGE_REPOS: "o/r,not a slug" }, gh: g }, async (run) => {
    assertEquals((await run()).candidateCount, 0);
  });
});
