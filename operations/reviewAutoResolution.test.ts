// Integration coverage for the POST /app/api/auto-resolutions/review operation `reviewAutoResolution`
// (issue #889) — the Auto-resolutions view's Dismiss/Intervene affordance. These tests drive the REAL
// door through `bootTestApp`'s api driver and assert the OPERATOR-PAGE authorization pattern (issue
// #889 review): like every other UI-driven operator door (`acknowledgePr`/`acknowledgeDone`/
// `dismissProposal`), it carries NO `x-hook-secret` guard — declarative page actions structurally
// cannot attach that header, so guarding on it would 401 the very UI it exists to serve on a secured
// deployment. The guard is the read-model's derived `pending_review` flag, enforced host-side by
// `reviewResolution` (only a FINAL, still-`pending` record transitions).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { claimEscalations, escalationAutoResolutions, recordResolution } from "../app/escalationSteward.ts";
import type { UserTaskRow } from "../app/userTasks.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

function taskRow(over: Partial<UserTaskRow>): UserTaskRow {
  return {
    user_task_key: "UT-1",
    element_id: "wait-answer",
    kind_label: "PR review",
    subject_type: "pr",
    subject_key: "o/r#1",
    subject_title: "o/r#1",
    subject_url: "https://github.com/o/r/pull/1",
    question: "Which approach?",
    process_key: "PI-1",
    form_key: "pr-escalation",
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

describe("reviewAutoResolution — operator-page authorization (no x-hook-secret)", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  // Boot with the webhook secret SET — the deployment the finding cited. A declarative page action
  // cannot attach `x-hook-secret`, so the door must NOT require it (the operator-page pattern).
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-review-auto-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(d, "app.db")}`, NANO_PR_WEBHOOK_SECRET: "s3cr3t" },
    });
    apps.push(app);
    return app;
  };

  const seedPending = async (app: TestApp): Promise<number> => {
    await claimEscalations(app.db, [taskRow({})], "steward-A");
    await recordResolution(app.db, "UT-1", { outcome: "resolved", submittedVariables: { answer: "x" }, rationale: "ok" });
    return (await escalationAutoResolutions(app.db).find({ user_task_key: "UT-1" }))[0].id;
  };

  test("a secured deployment still serves the UI: dismiss succeeds WITHOUT an x-hook-secret header", async () => {
    const app = await boot();
    assert.ok(app.api);
    const id = await seedPending(app);
    // No `x-hook-secret` header — exactly what a declarative page action sends. Must NOT 401.
    const res = await app.api.call<{ ok: boolean; reviewState?: string }>("reviewAutoResolution", { body: { id, action: "dismiss" } });
    assert.equal(res.status, 200, "the operator-page door is reachable from the UI on a secured deployment");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.reviewState, "dismissed");
    const row = (await escalationAutoResolutions(app.db).find({ user_task_key: "UT-1" }))[0];
    assert.equal(row.review_state, "dismissed");
    assert.equal(row.reviewed_by, "operator");
  });

  test("intervene records the operator note; a re-review is an idempotent 404 no-op", async () => {
    const app = await boot();
    assert.ok(app.api);
    const id = await seedPending(app);
    const res = await app.api.call<{ ok: boolean; reviewState?: string }>("reviewAutoResolution", {
      body: { id, action: "intervene", operator: "alice", note: "stepping in" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.reviewState, "intervened");
    let row = (await escalationAutoResolutions(app.db).find({ user_task_key: "UT-1" }))[0];
    assert.equal(row.review_state, "intervened");
    assert.equal(row.reviewed_by, "alice");
    assert.equal(row.review_note, "stepping in");
    // Already off `pending` → the guard folds it to a clean 404 no-op (not a double-stamp).
    const again = await app.api.call<{ ok: boolean; error?: string }>("reviewAutoResolution", { body: { id, action: "dismiss" } });
    assert.equal(again.status, 404);
    assert.equal(again.body.ok, false);
    row = (await escalationAutoResolutions(app.db).find({ user_task_key: "UT-1" }))[0];
    assert.equal(row.review_state, "intervened", "the first review is preserved");
  });

  test("a missing/invalid id or action → 400 (schema + handler validation)", async () => {
    const app = await boot();
    assert.ok(app.api);
    // Missing id → the handler's own 400.
    const noId = await app.api.call<{ ok: boolean; error?: string }>("reviewAutoResolution", { body: { action: "dismiss" } });
    assert.equal(noId.status, 400);
    // An out-of-enum action → the OpenAPI schema rejects it before the handler runs.
    const badAction = await app.api.call<{ error?: string }>("reviewAutoResolution", { body: { id: 1, action: "nuke" } });
    assert.equal(badAction.status, 400);
    assert.ok(typeof badAction.body.error === "string" && badAction.body.error.length > 0, "a human-readable error is returned");
  });

  // Red-first regression for the removed secret guard (issue #889 review): even with
  // NANO_PR_WEBHOOK_SECRET set, the operator door must NOT 401 a request carrying no/wrong
  // `x-hook-secret` — declarative page actions cannot attach one. Drive the handler DIRECTLY with a
  // cache-busted import so the module reads the secret env (the full-app boot imports it once, before
  // the per-test env applies — the same module-load timing `cancelInstance.test.ts` works around).
  test("the handler never 401s a secret-less request, even with NANO_PR_WEBHOOK_SECRET set", async () => {
    const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
    process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
    try {
      const mod = await import(`./reviewAutoResolution.ts?guard=${Date.now()}`);
      const handler = mod.default as (input: unknown, app: unknown) => Promise<{ status: number; body: { ok: boolean } }>;
      const d = mkdtempSync(join(tmpdir(), "nwf-review-direct-"));
      dirs.push(d);
      const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
      apps.push(app);
      await claimEscalations(app.db, [taskRow({})], "steward-A");
      await recordResolution(app.db, "UT-1", { outcome: "resolved", submittedVariables: { answer: "x" }, rationale: "ok" });
      const id = (await escalationAutoResolutions(app.db).find({ user_task_key: "UT-1" }))[0].id;
      const mkReq = (headers: Record<string, string>) => ({ req: { headers: new Headers(headers) }, params: {}, query: {}, body: { id, action: "dismiss" } });
      const noSecret = await handler(mkReq({}), { data: app.db, log: { info() {}, warn() {}, error() {} } });
      assert.notEqual(noSecret.status, 401, "no secret header is NOT a 401 — the UI cannot attach one");
      assert.equal(noSecret.status, 200);
    } finally {
      if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
      else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
    }
  });
});
