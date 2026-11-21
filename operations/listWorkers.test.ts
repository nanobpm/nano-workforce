// Integration coverage for GET /app/api/workers → `listWorkers` (issue #989, `d8ctl nwf workers list`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

const APP_ROOT = resolve(import.meta.dirname, "..");
const dirs: string[] = [];
const apps: TestApp[] = [];
after(async () => {
  for (const app of apps) await app.stop?.();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface View {
  items: { jobType: string; queueDepth: number; starved: boolean }[];
  internal: { total: number; summary: string; workers?: { jobType: string }[] };
}

test("lists the external job types nwf issues and a one-line internal health summary", async () => {
  const d = mkdtempSync(join(tmpdir(), "nwf-workers-"));
  dirs.push(d);
  const app = await bootTestApp(APP_ROOT, {
    env: { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "", NANO_APP_DB_URL: `file:${join(d, "app.db")}` },
  });
  apps.push(app);
  assert.ok(app.api);
  const res = await app.api.call<View>("listWorkers", {});
  assert.equal(res.status, 200);
  assert.ok(res.body.items.some((i) => i.jobType === "senior:feature"));
  assert.ok(res.body.items.every((i) => i.jobType.includes(":")));
  assert.ok(res.body.internal.total > 0);
  assert.equal(res.body.internal.workers, undefined);
  const expanded = await app.api.call<View>("listWorkers", { query: { internal: "true" } });
  assert.equal(expanded.status, 200);
  assert.ok(expanded.body.internal.workers?.some((w) => w.jobType.startsWith("pr.")));
});
