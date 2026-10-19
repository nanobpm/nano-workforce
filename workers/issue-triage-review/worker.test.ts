// Unit coverage for pr.issue-triage-review (issue #896): the human's batched decision on the
// low-confidence proposals one triage instance parked — apply (re-validated against the repo's live
// labels) or skip.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { issueTriageDecisions, recordTriageDecision } from "../../app/issueTriage.ts";
import handler from "./worker.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

interface Gh {
  labels: string[];
  posts: { issue: number; labels: string[] }[];
}

function fakeFetch(gh: Gh): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/o/r/labels") return Response.json(gh.labels.map((name) => ({ name })));
    const add = url.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels$/);
    if (add && init?.method === "POST") {
      gh.posts.push({ issue: Number(add[1]), labels: JSON.parse(String(init.body)).labels });
      return Response.json([]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function withApp(gh: Gh, fn: (run: (vars: Record<string, unknown>) => Promise<void>, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-triage-review-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  const prev = { mode: process.env.NANO_PR_GITHUB_TRANSPORT, token: process.env.GITHUB_TOKEN, fetch: globalThis.fetch };
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  process.env.GITHUB_TOKEN = "tok";
  globalThis.fetch = fakeFetch(gh);
  try {
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const run = async (variables: Record<string, unknown>) => {
      await handler({ jobKey: "J", processInstanceKey: "PI-1", variables } as never, { data: app.db, log } as never);
    };
    // Two parked proposals on this instance, one on another instance (must be left alone).
    await recordTriageDecision(app.db, { repo: "o/r", issue: 1, status: "escalated", labels: ["bug"], processKey: "PI-1" });
    await recordTriageDecision(app.db, { repo: "o/r", issue: 2, status: "escalated", labels: ["deleted-since"], processKey: "PI-1" });
    await recordTriageDecision(app.db, { repo: "o/r", issue: 3, status: "escalated", labels: ["bug"], processKey: "PI-OTHER" });
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

async function statuses(data: DataLayer): Promise<Record<string, string>> {
  return Object.fromEntries((await issueTriageDecisions(data).all()).map((r) => [r.triage_key, r.status]));
}

test("apply writes this instance's parked labels that still exist; a since-deleted label is rejected", async () => {
  const gh: Gh = { labels: ["bug", "queued"], posts: [] };
  await withApp(gh, async (run, data) => {
    await run({ decision: "apply", note: "ok" });
    assertEquals(gh.posts, [{ issue: 1, labels: ["bug"] }]);
    assertEquals(await statuses(data), { "o/r#1": "applied", "o/r#2": "rejected", "o/r#3": "escalated" });
  });
});

test("skip (or no decision) writes nothing and marks this instance's proposals skipped", async () => {
  const gh: Gh = { labels: ["bug"], posts: [] };
  await withApp(gh, async (run, data) => {
    await run({});
    assertEquals(gh.posts, []);
    assertEquals(await statuses(data), { "o/r#1": "skipped", "o/r#2": "skipped", "o/r#3": "escalated" });
  });
});
