// End-to-end pilot for @nanobpm/urban-testkit (nano-ide issue #157, slice S3).
//
// Boots this whole Urban app in-process against the WASM engine and a virtual clock via
// `bootTestApp`, then drives its real ADR-0059 OpenAPI operations by `operationId` — the same
// spec-driven `/app/api/*` surface a browser, a CI relay, or Swagger hit in production. No socket
// is opened, no wall-clock is waited on, and no GitHub network is touched.
//
// Network isolation: the app's GitHub transport (app/github.ts) is forced to `token` mode with no
// token, so every best-effort GitHub read short-circuits to `null`/idle instead of reaching out.
// That keeps the pilot hermetic and deterministic in CI.
//
// Run with `npm run e2e` (a dedicated node:test invocation, kept out of the fast unit `npm test`).

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, describe, test } from "node:test";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

// The app root is this repo's root (one level up from `e2e/`) — where nano.app.json + openapi.yaml
// + db/migrations + resources/processes live.
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Provision the app's SQLite in a throwaway temp dir so the pilot never touches (or leaks into) the
// repo's real ./app.db, and every run starts from a freshly-migrated, empty schema.
const DB_DIR = mkdtempSync(join(tmpdir(), "nwf-e2e-"));

// Derive the reconciler's poll interval from the app manifest (its single source of truth) rather
// than hard-coding it, so this test tracks nano.app.json instead of duplicating the value: a change
// to `pollMs` there stays correct here. Read the `pull_requests` instanceTracking entry's pollMs.
interface InstanceTrackingEntry {
  table: string;
  pollMs: number;
}
interface AppManifest {
  instanceTracking?: InstanceTrackingEntry[];
}
const APP_MANIFEST: AppManifest = JSON.parse(
  readFileSync(join(APP_ROOT, "nano.app.json"), "utf8"),
);
const PR_TRACKING = APP_MANIFEST.instanceTracking?.find((e) => e.table === "pull_requests");
assert.ok(PR_TRACKING, "nano.app.json declares a pull_requests instanceTracking entry");
const PR_POLL_MS = PR_TRACKING.pollMs;

// Force the app fully offline. github.ts reads `process.env` directly (not the harness env overlay),
// so seal the GitHub transport on process.env: `token` mode with no GITHUB_TOKEN means every
// best-effort GitHub read in submitPr short-circuits to null instead of shelling out to `gh`/fetch.
const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};
const savedEnv = new Map<string, string | undefined>();

// The harness `env` overlay drives the runtime's `${NANO_APP_DB_URL}` resolution — provision the
// app's SQLite in a throwaway temp dir so the pilot never touches (or leaks into) the repo's real
// ./app.db, and every run starts from a freshly-migrated, empty schema.
const HARNESS_ENV = {
  NANO_APP_DB_URL: `file:${join(DB_DIR, "app.db")}`,
} as const;

describe("nano-workforce e2e (urban-testkit pilot)", () => {
  let app: TestApp;

  before(async () => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    app = await bootTestApp(APP_ROOT, { env: HARNESS_ENV });
    // This app declares an `api` binding, so the spec-driven driver must be present.
    assert.ok(app.api, "app.api driver should be defined (nano.app.json declares an `api` binding)");
  });

  after(async () => {
    await app?.stop();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(DB_DIR, { recursive: true, force: true });
  });

  test("drives the blackboard operations round-trip through the OpenAPI driver", async () => {
    const api = app.api;
    assert.ok(api);

    // Seed a plan with a capability token — the credential the blackboard operations authorize on.
    const token = "pilot-blackboard-token";
    const planKey = "acme/widgets#7";
    const nowIso = new Date(app.now()).toISOString();
    await app.db.table("plans", "plan_key").insert({
      plan_key: planKey,
      repo: "acme/widgets",
      issue_number: 7,
      issue_url: "https://github.com/acme/widgets/issues/7",
      title: "Pilot plan",
      status: "planning",
      task_count: 0,
      blackboard_token: token,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // POST an entry via the `appendBlackboard` operation (operationId → /app/api/hooks/blackboard).
    const appended = await api.call<{ id: number; inserted: boolean }>("appendBlackboard", {
      query: { token },
      body: { author_task: "t1", kind: "note", body: "hello from the pilot" },
    });
    assert.equal(appended.status, 201, "append returns 201 Created");
    assert.equal(appended.body.inserted, true, "entry was inserted");
    assert.ok(Number.isFinite(appended.body.id), "append returns a numeric entry id");

    // GET it back via `readBlackboard` — the entry the POST just wrote must be visible.
    const read = await api.call<{ planKey: string; entries: Array<{ id: number; body: string }> }>(
      "readBlackboard",
      { query: { token } },
    );
    assert.equal(read.status, 200, "read returns 200 OK");
    assert.equal(read.body.planKey, planKey, "read is scoped to the seeded plan");
    assert.equal(read.body.entries.length, 1, "exactly the one appended entry is returned");
    assert.equal(read.body.entries[0].body, "hello from the pilot", "round-tripped body matches");
    assert.equal(read.body.entries[0].id, appended.body.id, "read id matches the appended id");

    // An unknown token is a 404 (never leaks which plans exist).
    const unknown = await api.call("readBlackboard", { query: { token: "nope" } });
    assert.equal(unknown.status, 404, "an unknown token is a 404, not a leak");
  });

  test("starts the convergence loop and reconciles its tracking row when terminated", async () => {
    const api = app.api;
    assert.ok(api);

    const prKey = "acme/widgets#42";
    // POST the real production door for starting a review: `startConvergenceLoop`. `convergeOnly`
    // keeps the run off the merge-loop; the offline env keeps `submitPr`'s best-effort GitHub
    // enrichment from touching the network.
    const started = await api.call<{ prKey: string }>("startConvergenceLoop", {
      body: { pr: prKey, convergeOnly: true },
    });
    assert.equal(started.status, 202, "start returns 202 Accepted");
    assert.equal(started.body.prKey, prKey, "the response echoes the parsed PR key");

    // The operation registered the PR aggregate (instanceTracking table) and started a real engine
    // instance — synchronously, before any worker ran (we never settled).
    const prs = app.db.table<{ pr_key: string; status: string; process_key: string | null }>(
      "pull_requests",
      "pr_key",
    );
    const row = await prs.findOne({ pr_key: prKey });
    assert.ok(row, "a pull_requests row was registered");
    assert.equal(row?.status, "converging", "the PR is tracked as actively converging");
    assert.ok(row?.process_key, "the row carries the engine process-instance key");

    const processInstanceKey = row!.process_key!;
    const before = await app.engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(before.length, 1, "the engine has exactly one instance for this PR");

    // Terminate the instance out-of-band (the class of event the reconciler exists to catch — a
    // PR merged or cancelled independently of the loop). The row is still `converging` until a poll.
    await app.engine.cancelInstance({ processInstanceKey });
    const stillActive = await prs.findOne({ pr_key: prKey });
    assert.equal(stillActive?.status, "converging", "row not yet reconciled before any poll fires");

    // Advance past the instanceTracking pollMs (derived from nano.app.json above, plus a margin):
    // the reconciler observes TERMINATED and applies the manifest `onTerminated.set` → status
    // `abandoned`, escalation pointers cleared.
    await app.advanceTime(PR_POLL_MS + 1000);
    const reconciled = await prs.findOne({ pr_key: prKey });
    assert.equal(reconciled?.status, "abandoned", "reconciler abandoned the terminated PR's row");
  });
});
