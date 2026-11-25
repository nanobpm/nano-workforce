// End-to-end proof for the friction sweep (issue #1073): boots the whole Urban app in-process against
// the WASM engine and drives `resources/processes/friction-sweep.bpmn` from its none start (the poller's start, issue #1100):
//
//   sweep starts → pr.friction-collect (REAL handler: reads the window, redacts, persists, advances the
//   watermark) → senior:friction-analyst (stubbed agent) → pr.friction-file (REAL handler against a
//   stubbed GitHub REST transport) → the `friction-summary` user task, whose summary links every issue
//   opened/updated. Singleton lease (operator scope): a sweep that overlaps a running sweep ends
//   "skipped"; the lease is released before the summary task, so an unacknowledged summary never blocks
//   the next sweep, which (with no new runs) is a no-op sweep: no analyst, no GitHub write, no summary.
//   A failed filing releases the lease too. (Opt-in switch + interval pacing: app/frictionSweepPoll.test.ts.)
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

// The analyst's SLA boundary reads `agentSlaTimeout`, resolved from env when the app modules load —
// widen it BEFORE importing them so the overlap below (an analyst still running when the next 12h
// sweep lands) is not cut short by the 2h default.
process.env.NANO_PR_AGENT_SLA_TIMEOUT = "PT48H";
const { FRICTION_PROCESS_ID, FRICTION_SUMMARY_ELEMENT, frictionSweeps, leaseHolder, normaliseMessage, parseFingerprintMarker } = await import("../app/friction.ts");
const { pollUserTasks } = await import("../app/service.ts");
const { userTasks } = await import("../app/userTasks.ts");

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERVAL_MS = 12 * 60 * 60 * 1000;
const DB_DIR = mkdtempSync(join(tmpdir(), "nwf-friction-e2e-"));

const ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "test-token",
  NANO_FRICTION_REPO: "acme/friction",
  NANO_FRICTION_MIN_OCCURRENCES: "2",
  NANO_FRICTION_MIN_RUNS: "1",
};
const savedEnv = new Map<string, string | undefined>();

interface GhCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** Insert escalation rows (a friction source the collector reads) timestamped just now. */
function seedEscalations(app: TestApp, tag: string, questions: string[]): void {
  const db = app.db.source().db;
  const at = new Date(Date.now() - 1000).toISOString();
  questions.forEach((q, i) => {
    db.run("INSERT INTO feature_escalations (feature_key, question, created_at, job_key) VALUES (?, ?, ?, ?)", [`acme/app#${tag}${i}`, q, at, `${tag}-${i}`]);
  });
}

/** Start one sweep exactly as the poller's tick does (`pollFrictionSweep`, app/service.ts), after
 *  letting an interval's worth of engine time pass so each sweep reads a fresh window. */
async function startSweep(app: TestApp): Promise<void> {
  await app.advanceTime(INTERVAL_MS);
  await app.engine.createInstance({ processDefinitionId: FRICTION_PROCESS_ID, variables: {} });
}

async function sweepInstances(app: TestApp) {
  return app.engine.searchProcessInstances({ processDefinitionId: FRICTION_PROCESS_ID });
}

describe("friction sweep (engine-level)", () => {
  let app: TestApp;
  const ghCalls: GhCall[] = [];
  const realFetch = globalThis.fetch;
  let failCreates = false;
  let analystCalls = 0;
  let analystDigest = "";

  before(async () => {
    for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // Stub GitHub REST: an existing open finding (fingerprint `existing-root-cause`), create → #42.
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      ghCalls.push({ method, url, body });
      if (method === "GET" && url.includes("/repos/acme/friction/issues?")) {
        return Response.json([
          { number: 7, html_url: "https://github.com/acme/friction/issues/7", title: "Existing", body: "<!-- nano-friction-fingerprint: existing-root-cause -->" },
        ]);
      }
      if (method === "POST" && url.endsWith("/repos/acme/friction/issues")) {
        if (failCreates) return new Response("boom", { status: 500 });
        return Response.json({ number: 42, html_url: "https://github.com/acme/friction/issues/42", title: body?.title, body: body?.body });
      }
      if (method === "POST" && url.endsWith("/repos/acme/friction/issues/7/comments")) {
        if (failCreates) return new Response("boom", { status: 500 });
        return Response.json({ html_url: "https://github.com/acme/friction/issues/7#issuecomment-1" });
      }
      return new Response("not found", { status: 404 });
    };
    app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(DB_DIR, "app.db")}` } });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await app?.stop();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(DB_DIR, { recursive: true, force: true });
  });

  test("start → lease → collect → analyse → file → release → summary; overlap skipped; unread summary doesn't block; failure releases", async () => {
    seedEscalations(app, "a", ["Which migration prefix should I use? token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "Which migration prefix should I use?"]);

    // ── Sweep 1: the sweep takes the lease, collects, and parks on the analyst (no worker yet).
    await startSweep(app);
    await app.settle();
    let sweeps = await frictionSweeps(app.db).all();
    assert.equal(sweeps.length, 1, "the first start ran one sweep");
    const first = sweeps[0];
    assert.ok(first);
    assert.equal(first.status, "collected");
    assert.equal(first.escalation_count, 2);
    assert.equal(leaseHolder(app.db), first.sweep_key, "the running sweep holds the singleton lease");

    // ── Sweep 2 overlaps the still-running sweep: it must end "skipped" without sweeping.
    await startSweep(app);
    await app.settle();
    sweeps = await frictionSweeps(app.db).all();
    assert.equal(sweeps.length, 2);
    const skipped = sweeps.find((s) => s.sweep_key !== first.sweep_key);
    assert.equal(skipped?.status, "skipped", "an overlapping sweep is recorded as skipped");
    assert.equal(skipped?.signal_count, 0);
    assert.equal(leaseHolder(app.db), first.sweep_key, "the skipped sweep did not take the lease");
    const skippedInstance = (await sweepInstances(app)).find((i) => i.processInstanceKey === skipped?.sweep_key);
    assert.equal(skippedInstance?.state, "COMPLETED", "the skipped instance ended at once");
    assert.equal(ghCalls.filter((c) => c.method === "POST").length, 0);

    // ── The analyst finishes: file → release → summary task.
    await app.engine.registerWorker("senior:friction-analyst", (job) => {
      analystCalls += 1;
      const v = job.variables as Record<string, unknown>;
      analystDigest = typeof v.frictionDigest === "string" ? v.frictionDigest : "";
      return {
        status: "analysed",
        findings: [
          {
            fingerprint: "agents-ask-about-migrations",
            title: "Agents escalate about migration numbering AGENTS.md already answers",
            occurrences: 2,
            runs: 2,
            fixSurface: "AGENTS.md",
            targetRepo: "nanobpm/nano-workforce",
            evidence: "- escalation: which migration prefix?",
            proposedFix: "Point to the migration section.",
            // The filer recounts these host-side; cite the persisted escalation groups (both the
            // redacted-token variant and the plain question) via the canonical normaliser.
            signalFingerprints: [
              normaliseMessage("Which migration prefix should I use? token ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
              normaliseMessage("Which migration prefix should I use?"),
            ],
          },
          { fingerprint: "existing-root-cause", title: "Recurring", occurrences: 1, runs: 1, fixSurface: "permission-rule", targetRepo: "nanobpm/nano-coder", evidence: "- again", proposedFix: "Allow it.", signalFingerprints: [normaliseMessage("Which migration prefix should I use?")] },
        ],
      };
    });
    await app.settle();
    const filed = await frictionSweeps(app.db).get(first.sweep_key);
    assert.equal(filed?.status, "filed");
    assert.equal(analystCalls, 1);
    assert.match(analystDigest, /migration prefix/);
    assert.doesNotMatch(analystDigest, /ghp_abcdefghijklmnop/, "the digest handed to the agent is redacted");
    const creates = ghCalls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));
    assert.equal(creates.length, 1, "one new finding opened");
    assert.equal(parseFingerprintMarker(String(creates[0]?.body?.body)), "agents-ask-about-migrations");
    assert.deepEqual(creates[0]?.body?.labels, ["friction"]);
    assert.equal(ghCalls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments")).length, 1, "the recurring finding commented, not re-filed");
    assert.equal(leaseHolder(app.db), null, "the lease is released BEFORE the summary task");

    await pollUserTasks(app.db, app.engine);
    const rows = (await userTasks(app.db).all()).filter((r) => r.element_id === FRICTION_SUMMARY_ELEMENT);
    assert.equal(rows.length, 1, "one friction summary task");
    assert.equal(rows[0]?.kind_label, "Friction summary");
    assert.match(rows[0]?.question ?? "", /https:\/\/github\.com\/acme\/friction\/issues\/42/);
    assert.match(rows[0]?.question ?? "", /https:\/\/github\.com\/acme\/friction\/issues\/7/);

    // ── Sweep 3: the summary is still unacknowledged, yet the sweep runs — a no-op (no new runs).
    const ghBefore = ghCalls.length;
    await startSweep(app);
    await app.settle();
    sweeps = await frictionSweeps(app.db).all();
    assert.equal(sweeps.length, 3, "the unread summary did not block the next sweep");
    const noop = sweeps.find((s) => s.sweep_key !== first.sweep_key && s.sweep_key !== skipped?.sweep_key);
    assert.equal(noop?.status, "noop");
    assert.equal(analystCalls, 1, "no analyst run on a no-op sweep");
    assert.equal(ghCalls.length, ghBefore, "no GitHub call on a no-op sweep");
    assert.equal(leaseHolder(app.db), null, "a no-op sweep releases the lease");
    await pollUserTasks(app.db, app.engine);
    assert.equal((await userTasks(app.db).all()).filter((r) => r.element_id === FRICTION_SUMMARY_ELEMENT).length, 1, "no new summary task on a no-op sweep");

    // ── Sweep 4: new friction, but filing fails — the failed sweep still releases the lease.
    failCreates = true;
    await app.advanceTime(INTERVAL_MS); // the new friction lands after sweep 3's watermark
    seedEscalations(app, "b", ["Which migration prefix should I use?", "Which migration prefix should I use?"]);
    await startSweep(app);
    await app.settle();
    sweeps = await frictionSweeps(app.db).all();
    assert.equal(sweeps.length, 4);
    assert.equal(sweeps.filter((s) => s.status === "failed").length, 1, "the failed filing is recorded");
    assert.equal(leaseHolder(app.db), null, "a failed sweep releases the lease");
    assert.equal((await app.engine.searchIncidents({ state: "ACTIVE" })).length, 0, "a failure ends the sweep, not an incident");
  });
});
