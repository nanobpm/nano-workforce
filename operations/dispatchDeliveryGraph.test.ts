// Integration coverage for the POST /app/api/actions/delivery-graph/dispatch operation
// `dispatchDeliveryGraph` (ADR 0005 Decision 7, issue #460) — the OPERATOR-ONLY dispatch door. The
// cockpit's staged-proposals grid posts the `digest` of the proposal the operator picked; this door
// loads that live `staged` proposal, launches the retained S4 runner for its graph, and marks the
// proposal `dispatched`. There is no replayable token — the operator clicking Dispatch IS the
// approval, and the door is reachable only from the cockpit (the agent compile door returns no
// dispatch handle). These tests drive the REAL door through `bootTestApp`'s api driver against the
// WASM engine: compile-to-stage, then dispatch by digest, asserting the digest is resolved, an
// unknown/consumed digest is refused, and the run launches engine-natively.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphProposals } from "../app/deliveryGraphProposals.ts";
import { deliveryGraphRuns } from "../app/deliveryGraphRun.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

const HUMAN_ONLY = {
  name: "manual gate",
  nodes: [{ id: "ack", kind: "human", human: { prompt: "click done when the release is out" } }],
};
const SIDE_EFFECTING = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:demo", prompt: "un-draft + merge #B" } },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" } },
  ],
  edges: [{ from: "open-b", to: "publish" }],
};

describe("dispatchDeliveryGraph — operator dispatch by staged-proposal digest", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-dispatch-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("a missing/blank digest → 400 with a human error, nothing launched", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call<{ ok: boolean; error?: string }>("dispatchDeliveryGraph", { body: { digest: "  " } });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(typeof res.body.error === "string" && res.body.error.length > 0);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
  });

  test("an unknown / never-staged digest → 400, nothing launched", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call<{ ok: boolean; error?: string }>("dispatchDeliveryGraph", { body: { digest: "deadbeef0000", repoless: true } });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(/no staged proposal/.test(res.body.error ?? ""));
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
  });

  test("a human-only graph: stage via compile, then dispatch by digest → 202 running; proposal marked dispatched", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;

    // Stage through the agent compile door — it returns only a preview + digest (no dispatch handle).
    const staged = await api.call<{ status: string; digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    assert.equal(staged.status, 200);
    assert.equal(staged.body.status, "ready");
    const digest = staged.body.digest;
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "staged");

    // The operator dispatches that digest.
    const res = await api.call<{ ok: boolean; status: string; runKey: string; alreadyRunning?: boolean }>(
      "dispatchDeliveryGraph",
      { body: { digest, repoless: true } },
    );
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "running");
    await app.settle();
    const runs = await deliveryGraphRuns(app.db).all();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "running");
    // The proposal drops out of the staged list — it is now dispatched.
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "dispatched");
  });

  test("a side-effecting graph dispatches the agent side effect once the operator picks its digest", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    let agentFired = 0;
    await app.engine.registerWorker("senior:demo", async () => {
      agentFired++;
      return {};
    });

    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: SIDE_EFFECTING });
    const res = await api.call<{ ok: boolean; status: string; sideEffecting: boolean }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repoless: true },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sideEffecting, true);
    await app.settle();
    assert.equal(agentFired, 1, "the side effect fired exactly once");
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "dispatched");
  });

  test("re-dispatching an ALREADY-dispatched digest → 400 (the proposal is consumed; the run shows in the in-flight grid)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    await api.call("dispatchDeliveryGraph", { body: { digest: staged.body.digest, repoless: true } });
    await app.settle();
    const again = await api.call<{ ok: boolean }>("dispatchDeliveryGraph", { body: { digest: staged.body.digest, repoless: true } });
    assert.equal(again.status, 400);
    assert.equal(again.body.ok, false);
    // Still exactly one run — the consumed proposal cannot re-launch.
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 1);
  });

  test("an idempotencyKey already bound to a DIFFERENT running graph → 409; the proposal is NOT consumed and nothing new launches", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;

    // Stage two distinct graphs (different digests, different logical keys → neither supersedes).
    const a = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const b = await api.call<{ digest: string }>("compileDeliveryGraph", { body: SIDE_EFFECTING });
    assert.notEqual(a.body.digest, b.body.digest);

    // Dispatch graph A under a shared idempotencyKey — it launches and stays running (parks on a human).
    const first = await api.call<{ ok: boolean; status: string }>("dispatchDeliveryGraph", {
      body: { digest: a.body.digest, idempotencyKey: "shared-key", repoless: true },
    });
    assert.equal(first.status, 202);
    await app.settle();

    // Dispatch graph B under the SAME idempotencyKey — it short-circuits onto A's run. B's graph was
    // never launched, so B must NOT be consumed: refuse with 409 and leave B staged.
    const second = await api.call<{ ok: boolean; error?: string }>("dispatchDeliveryGraph", {
      body: { digest: b.body.digest, idempotencyKey: "shared-key", repoless: true },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.ok, false);
    await app.settle();
    // Proposal B is still staged (dispatchable) — it was never launched.
    assert.equal((await deliveryGraphProposals(app.db).get(b.body.digest))?.status, "staged");
    // Only A's single run exists — B did not launch anything.
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 1);
  });

  test("a proposal whose stored graph is corrupt JSON → 400 AND the proposal is retired (expired), never lingering staged", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;

    // Stage a valid graph, then corrupt its stored `graph` payload directly (simulating on-disk
    // corruption/tampering that passed stage-time validation).
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const digest = staged.body.digest;
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "staged");
    await deliveryGraphProposals(app.db).update(digest, { graph: "{not-json" });

    const res = await api.call<{ ok: boolean; error?: string }>("dispatchDeliveryGraph", { body: { digest, repoless: true } });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(/corrupt/.test(res.body.error ?? ""));
    // Fail closed: the corrupt proposal is retired, not left as an undismissable `staged` row.
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "expired");
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
  });

  test("an invalid run-level nodeTimeout duration is rejected at submit → 400, nothing launched (#505)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok?: boolean; error?: string; issues?: Array<{ path: string }> }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, nodeTimeout: "2 hours" },
    });
    // Rejected at submit — either by the edge shape-validator (openapi `pattern`) or the door's own
    // ISO-8601 guard; both surface a 400. Nothing launches and the proposal stays staged (dispatchable).
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("an oversized invalid duration never bloats the 400 response — rejected with a bounded error, nothing launched (#505)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const huge = `PT${"9".repeat(5000)}X`;
    const res = await api.call<{ ok?: boolean; error?: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, nodeTimeout: huge },
    });
    assert.equal(res.status, 400);
    // The 5000-char blob is never echoed back verbatim — the edge pattern rejects it, and the door's
    // own guard (`truncateForEcho`) caps the echo when the edge is bypassed. Either way the response
    // stays bounded, so a malformed input can't bloat logs/response bodies.
    assert.ok((res.body.error ?? "").length < 300, `error body should be bounded, got ${(res.body.error ?? "").length} chars`);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
  });

  test("a syntactically-valid but oversized duration is rejected at the door → 400, nothing launched (#505)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    // Matches the ISO-8601 grammar but exceeds the door's MAX_DURATION_LEN (64) — the door re-enforces the
    // openapi `maxLength: 64` so an oversized value is refused even if the edge validator is bypassed.
    const longValid = `PT${"9".repeat(70)}H`;
    const res = await api.call<{ ok?: boolean; error?: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, nodeTimeout: longValid },
    });
    assert.equal(res.status, 400);
    assert.ok((res.body.error ?? "").length < 300, `error body should be bounded, got ${(res.body.error ?? "").length} chars`);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("a valid run-level nodeTimeout override dispatches the run → 202 running (#505)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok: boolean; status: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, nodeTimeout: "PT2H", repoless: true },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "running");
    await app.settle();
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 1);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "dispatched");
  });

  test("a malformed `repository` is rejected at submit → 400, nothing launched (#684/#686)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    // Not an `owner/repo` reference — refused at submit (by the edge `pattern` or the door's own guard),
    // rather than silently dropped into a bogus clone URL. Nothing launches; the proposal stays staged.
    const res = await api.call<{ ok?: boolean; error?: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repository: "not a repo!", baseBranch: "main" },
    });
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("a malformed `baseBranch` is rejected at submit → 400, nothing launched (#684/#686)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    // Not a plausible git branch name (a leading dash reads as a CLI flag / shell metacharacters) — the
    // door's conservative allowlist refuses it at submit rather than seeding an invalid-ref envelope.
    const res = await api.call<{ ok?: boolean; error?: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repository: "owner/repo", baseBranch: "-rf; rm main" },
    });
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("a `.lock`-suffixed `baseBranch` segment is rejected at submit → 400, nothing launched (#684/#686)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    // A path segment ending in `.lock` (or one starting with `.`) is a valid-looking ref the loose
    // charset would admit but `isPlausibleBranchName` rejects — the door must refuse it, matching the
    // (now tightened) OpenAPI `baseBranch` pattern rather than seeding an invalid-ref envelope.
    const res = await api.call<{ ok?: boolean; error?: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repository: "owner/repo", baseBranch: "feat/x.lock" },
    });
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("a valid repository + baseBranch dispatches the run for isolated provisioning → 202 running (#684/#686)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok: boolean; status: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repository: "owner/repo", baseBranch: "main" },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "running");
    await app.settle();
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 1);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "dispatched");
  });

  // Issue #729: the fan-out dispatch door must REQUIRE repository provisioning — either a resolvable
  // `repository` + `baseBranch`, or an EXPLICIT `repoless: true` opt-out — so it can never silently
  // dispatch envelope-less and let concurrent fan-out agents share (and clobber) the worker's launch
  // dir (issue #684's field failure re-opened as a silent fallback).
  test("a dispatch with NEITHER repository/baseBranch NOR repoless is rejected at submit → 400, nothing launched (#729)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok?: boolean; error?: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    // Loud, not silent: nothing launched and the proposal stays staged (re-dispatchable once a repo /
    // repoless choice is supplied).
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("a dispatch with ONLY repository (no baseBranch) is rejected → 400, nothing launched (#729)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok?: boolean }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repository: "owner/repo" },
    });
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("a dispatch with ONLY baseBranch (no repository) is rejected → 400, nothing launched (#729)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok?: boolean }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, baseBranch: "main" },
    });
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("an EXPLICIT repoless: true dispatches a checkout-less graph → 202 running (#729)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok: boolean; status: string }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repoless: true },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "running");
    await app.settle();
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 1);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "dispatched");
  });

  test("repoless: true is mutually exclusive with repository/baseBranch → 400, nothing launched (#729)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok?: boolean }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repoless: true, repository: "owner/repo", baseBranch: "main" },
    });
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });

  test("a non-boolean repoless is rejected at submit → 400, nothing launched (#729)", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const res = await api.call<{ ok?: boolean }>("dispatchDeliveryGraph", {
      body: { digest: staged.body.digest, repoless: "yes" },
    });
    assert.equal(res.status, 400);
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
    assert.equal((await deliveryGraphProposals(app.db).get(staged.body.digest))?.status, "staged");
  });
});
