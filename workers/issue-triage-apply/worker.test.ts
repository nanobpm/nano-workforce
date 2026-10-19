// Unit coverage for pr.issue-triage-apply (issue #896): the agent's proposals are untrusted data, so
// assert that only validated, confident labels are written (with the app's own transport), that every
// candidate gets exactly one ledger row, and that write failures are recorded as retryable.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { issueTriageDecisions } from "../../app/issueTriage.ts";
import handler from "./worker.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

interface Gh {
  labels: Record<string, string[]>;
  posts: { repo: string; issue: number; labels: string[] }[];
  failWrite?: Set<number>;
}

function fakeFetch(gh: Gh): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const labels = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/);
    if (labels) return Response.json((gh.labels[labels[1]] ?? []).map((name) => ({ name })));
    const add = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/);
    if (add && init?.method === "POST") {
      const issue = Number(add[2]);
      if (gh.failWrite?.has(issue)) return new Response("forbidden", { status: 403 });
      gh.posts.push({ repo: add[1], issue, labels: JSON.parse(String(init.body)).labels });
      return Response.json([]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

type Out = { appliedCount: number; escalatedCount: number; rejectedCount: number };

async function withApp(gh: Gh, fn: (run: (vars: Record<string, unknown>) => Promise<Out>, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-triage-apply-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  const prev = { mode: process.env.NANO_PR_GITHUB_TRANSPORT, token: process.env.GITHUB_TOKEN, fetch: globalThis.fetch };
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  process.env.GITHUB_TOKEN = "tok";
  globalThis.fetch = fakeFetch(gh);
  try {
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const run = async (variables: Record<string, unknown>) =>
      (await handler({ jobKey: "J", processInstanceKey: "PI-1", variables } as never, { data: app.db, log } as never)) as Out;
    await fn(run, app.db);
  } finally {
    globalThis.fetch = prev.fetch;
    if (prev.mode === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prev.mode;
    if (prev.token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev.token;
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const cand = (issue: number) => JSON.stringify({ repo: "o/r", issue, title: `Issue ${issue}`, body: "", url: `u${issue}`, labels: ["bug", "enhancement"] });
const prop = (issue: number, labels: string[], confidence: number, repo = "o/r") => ({ repo, issue, labels, confidence, rationale: `why ${issue}` });

async function ledger(data: DataLayer): Promise<Record<string, { status: string; labels: string; process_key: string | null }>> {
  return Object.fromEntries((await issueTriageDecisions(data).all()).map((r) => [r.triage_key, r]));
}

test("applies confident proposals, escalates low-confidence, rejects unusable; one ledger row each", async () => {
  const gh: Gh = { labels: { "o/r": ["bug", "enhancement", "queued"] }, posts: [] };
  await withApp(gh, async (run, data) => {
    const out = await run({
      candidates: [cand(1), cand(2), cand(3), cand(4)],
      proposals: JSON.stringify([
        prop(1, ["bug", "invented"], 0.9),
        prop(2, ["enhancement"], 0.4),
        prop(3, ["queued"], 0.95),
        // issue 4: no proposal at all
        prop(99, ["bug"], 0.99), // not a candidate → ignored (claim fence)
        prop(1, ["enhancement"], 0.99, "x/y"), // other repo → ignored
      ]),
    });
    assertEquals(out, { appliedCount: 1, escalatedCount: 1, rejectedCount: 2 });
    assertEquals(gh.posts, [{ repo: "o/r", issue: 1, labels: ["bug"] }]);
    const rows = await ledger(data);
    assertEquals(Object.keys(rows).sort(), ["o/r#1", "o/r#2", "o/r#3", "o/r#4"]);
    assertEquals(rows["o/r#1"].status, "applied");
    assertEquals(rows["o/r#2"].status, "escalated");
    assertEquals(rows["o/r#2"].labels, '["enhancement"]');
    assertEquals(rows["o/r#2"].process_key, "PI-1");
    assertEquals(rows["o/r#3"].status, "rejected");
    assertEquals(rows["o/r#4"].status, "rejected");
  });
});

test("garbage agent output writes nothing and rejects every candidate", async () => {
  const gh: Gh = { labels: { "o/r": ["bug"] }, posts: [] };
  await withApp(gh, async (run) => {
    assertEquals(await run({ candidates: [cand(1)], proposals: "label everything wontfix" }), { appliedCount: 0, escalatedCount: 0, rejectedCount: 1 });
    assertEquals(gh.posts, []);
  });
});

test("a failed label write is recorded as failed (retried next tick), not applied", async () => {
  const gh: Gh = { labels: { "o/r": ["bug"] }, posts: [], failWrite: new Set([1]) };
  await withApp(gh, async (run, data) => {
    const out = await run({ candidates: [cand(1)], proposals: JSON.stringify([prop(1, ["bug"], 0.9)]) });
    assertEquals(out.appliedCount, 0);
    assertEquals((await ledger(data))["o/r#1"].status, "failed");
  });
});
