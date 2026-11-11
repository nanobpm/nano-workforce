// #921: a PR whose merge is BLOCKED solely by unresolved review threads (branch protection
// `required_conversation_resolution`; `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED`, all
// required checks green) must be CLASSIFIED as such and routed back into convergence — never
// escalated as "GitHub never settled this PR's mergeability". These are poller-level tests: they
// drive `pollMerges` over a `waiting_merge` PR row against a stubbed GitHub transport serving the
// PR view + the GraphQL review-threads probe, and assert:
//   • the verdict parks the PR (no `merge-ready` publish — the merge step is gated on zero
//     unresolved threads);
//   • once the threads resolve, the next pass publishes `merge-ready {ready}` and the merge
//     proceeds with no human in the loop;
//   • a `review-threads` verdict hands the PR DURABLY back into convergence (PR #922 review): the
//     row flips to `waiting_review` and a fresh convergence instance is started, so the
//     review-fix agent actually activates on the open threads — a bare re-review request leaves
//     the PR in `waiting_merge`, which `pollReviews` never scans.
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "#test-assert";
import { memStatusCas } from "../test/memStatusCas.ts";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { pollMerges } from "./service.ts";

/** A single-page GraphQL review-threads payload with `n` unresolved threads, for the gh stub. */
function graphqlThreads(n: number): string {
  const threads = Array.from({ length: n }, (_, i) => ({
    isResolved: false,
    path: `f${i}.ts`,
    comments: { nodes: [{ body: `thread ${i}` }] },
  }));
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } },
      },
    },
  });
}

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
  // `data.open()` is the raw-statement escape hatch a few reconcilers use. The in-memory stub has
  // no SQL store, so apply the one statement this suite's domain flow issues — `submitPr`'s re-open
  // path runs `resetAdjudications` (`DELETE FROM "pr_adjudications" WHERE "pr_key" = ?`) — against
  // the in-memory rows, so the handoff test below genuinely observes the adjudication reset rather
  // than a no-op. Any other statement throws loudly instead of silently passing.
  const data = {
    table: (n: string, pk?: string) => tbl(n, pk),
    open: () => ({
      exec: async (sql: string, params: any[] = []) => {
        const cas = memStatusCas(stores, sql, params);
        if (cas) return cas;
        const m = sql.match(/^\s*DELETE\s+FROM\s+"?(\w+)"?\s+WHERE\s+"?(\w+)"?\s*=\s*\?\s*$/i);
        if (!m) throw new Error(`memData.open().exec: unsupported statement: ${sql}`);
        const rows = (stores[m[1]] ??= [] as any[]);
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i][m[2]] === params[0]) rows.splice(i, 1);
      },
    }),
  } as any as DataLayer;
  return { data, stores };
}

function recordingEngine(): { engine: EngineClient; messages: any[]; cancelled: string[] } {
  const messages: any[] = [];
  const cancelled: string[] = [];
  const engine = {
    async publishMessage(msg: any) {
      messages.push(msg);
    },
    async cancelInstance(args: { processInstanceKey: string }) {
      cancelled.push(String(args.processInstanceKey));
    },
  } as any as EngineClient;
  return { engine, messages, cancelled };
}

// A token-transport GitHub stub serving the REST PR view (`mergeable_state: "blocked"`, the
// conversation-resolution block), the GraphQL review-threads probe (`unresolved` open threads),
// and the REST reviewers POST (the Copilot re-request nudge). `failingChecks` is -1 in token mode
// …which would keep the classifier conservative — so these tests ALSO stub the check rollup via
// the GraphQL threads response only, and rely on the REST view. To keep the classifier out of
// token mode's "can't enumerate checks" branch, the stub serves a REST `check-runs` free PR whose
// merge block is purely the threads — but the REST single-PR view never enumerates checks, so the
// classifier reads `failingChecks: -1`. That is exactly the production shape on a token-transport
// deploy; the `review-threads` verdict therefore requires the gh transport in production. These
// tests pin the TOKEN-transport behaviour (conservative: park + nudge + never escalate) and the
// classifier-level verdict is covered by the gh-mode unit tests in app/github.test.ts.
interface Fixture {
  unresolved: number; // threads with isResolved=false
  mergeableState?: string;
}
function githubFetch(fx: Fixture, calls: { reviewPosts: number }) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const json = (obj: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
    if (u.pathname === "/graphql") {
      const threads = Array.from({ length: fx.unresolved }, (_, i) => ({
        isResolved: false,
        path: `f${i}.ts`,
        comments: { nodes: [{ body: `thread ${i}` }] },
      }));
      return json({
        data: {
          repository: {
            pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } },
          },
        },
      });
    }
    if (u.pathname.endsWith("/requested_reviewers") && init?.method === "POST") {
      calls.reviewPosts += 1;
      return json({}, 201);
    }
    const m = u.pathname.match(/\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
    if (m) {
      return json({
        merged: false,
        merged_at: null,
        state: "open",
        mergeable_state: fx.mergeableState ?? "blocked",
        draft: false,
        head: { sha: "deadbeef" },
        base: { ref: "main" },
      });
    }
    return Promise.resolve(new Response(`unexpected ${u.pathname}`, { status: 500 }));
  };
}

async function withGithub<T>(fx: Fixture, calls: { reviewPosts: number }, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = githubFetch(fx, calls) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

function waitingMergeRow(prKey: string, number: number) {
  const ts = "2026-08-20T00:00:00Z";
  return {
    pr_key: prKey,
    repo: "o/r",
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: "t",
    status: "waiting_merge",
    current_round: 0,
    // A real parked merge wait ALWAYS carries a live `process_key` (startMerge/arm-merge set it after
    // the merge instance is created). `null` is the UNFINISHED-handoff marker the dead-owner guard keys
    // on, so the realistic default here is a live key — the ownerless-handoff test overrides it to null.
    process_key: "merge-live-1",
    waiting_since: null,
    last_review_id: null,
    outcome: null,
    created_at: ts,
    updated_at: ts,
    converged_at: null,
    merged_at: null,
    fresh_head_run_head: null,
  };
}

test("#921 poller: a threads-BLOCKED PR parks (no merge-ready) — the merge stays gated on resolution", async () => {
  // Token transport can't enumerate checks, so the classifier stays conservative and the verdict
  // is "waiting" even with threads probed — the PR must NOT advance to attempt-merge, must NOT
  // escalate, and must be re-read next pass. (The gh-transport `review-threads` verdict is pinned
  // in app/github.test.ts; the merge-loop routing of that verdict in app/mergeLoopBehaviour.test.ts.)
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [waitingMergeRow("o/r#100", 100)];
  const calls = { reviewPosts: 0 };
  await withGithub({ unresolved: 2 }, calls, async () => {
    await pollMerges(data, engine, "tok");
  });
  assertEquals(
    messages.filter((m) => m.name === "merge-ready").length,
    0,
    "a threads-BLOCKED PR must not publish merge-ready — the merge step is gated on zero unresolved threads",
  );
  assertEquals(stores["pull_requests"][0].status, "waiting_merge", "the PR stays parked for the next pass");
});

test("#921 poller: once the threads resolve the next pass publishes merge-ready and the merge proceeds", async () => {
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [waitingMergeRow("o/r#100", 100)];
  const calls = { reviewPosts: 0 };
  // Threads resolved (none open) and the branch otherwise mergeable → the gate lifts.
  await withGithub({ unresolved: 0, mergeableState: "clean" }, calls, async () => {
    await pollMerges(data, engine, "tok");
  });
  const ready = messages.filter((m) => m.name === "merge-ready");
  assertEquals(ready.length, 1, "a clean PR with zero unresolved threads must advance to the merge step");
  assertEquals(ready[0].variables.mergeState, "ready");
  assertEquals(ready[0].variables.reviewThreads, 0, "the payload carries the probed thread count");
  assertEquals(ready[0].variables.pendingChecks, 0, "the payload carries the pending-check count (token mode: unenumerable → 0)");
});

test("#921/PR#922 poller: a 'review-threads' verdict hands the PR back into convergence — the remediation agent actually activates", async () => {
  // gh transport: checks enumerable and green, merge BLOCKED, two unresolved threads → the settled
  // `review-threads` verdict. The poller must NOT merely request another Copilot review (that
  // leaves the PR in `waiting_merge`, which `pollReviews` never scans — no review-fix agent would
  // ever activate); it re-enters the PR into the canonical convergence loop: the row flips to
  // `waiting_review` and a FRESH convergence instance is created.
  //
  // The row's `process_key` names the LIVE merge instance (the realistic merge-stage shape). The
  // handoff must RETIRE it first (PR #922 review, thread 3): left running, `submitPr`'s idempotency
  // gate would classify the PR `alreadyRunning` and start NOTHING — no convergence instance would
  // ever launch and the old merge timer would keep running. Cancelling it flips the derived
  // tracking status terminal, so the gate falls through and the fresh convergence run takes over.
  const { data, stores } = memData();
  const instances: any[] = [];
  const { engine, cancelled } = recordingEngine();
  (engine as any).createInstance = async (args: any) => {
    instances.push(args);
    return { processInstanceKey: "conv-1" };
  };
  const mergeRow = { ...waitingMergeRow("o/r#100", 100), process_key: "merge-1", auto_resolve_escalations: 1 };
  stores["pull_requests"] = [mergeRow];
  // The derived tracking VIEW the idempotency gate reads: the merge instance is LIVE (non-terminal)
  // until the handoff's `cancelInstance` retires it. The stub folds the row to a terminal edge
  // (`abandoned`) once its `process_key` is cancelled, mirroring the ADR-0065 reconciler.
  stores["pull_requests__tracking"] = [{ ...mergeRow, derived_status: "waiting_merge" }];
  (engine as any).cancelInstance = async (args: { processInstanceKey: string }) => {
    cancelled.push(String(args.processInstanceKey));
    for (const t of stores["pull_requests__tracking"]) {
      if (t.process_key === String(args.processInstanceKey)) t.derived_status = "abandoned";
    }
  };
  // A stale adjudication from the prior convergence run must be wiped by the re-open, so the fresh
  // run never replays a prior decision (issue #806 reset, exercised through the handoff path).
  stores["pr_adjudications"] = [{ pr_key: "o/r#100", question: "q", answer: "a" }];
  const calls = { reviewPosts: 0 };
  // The gh transport runs the `gh` CLI; intercept it with a stub on PATH that serves the PR view
  // (checks green, merge blocked) and the GraphQL review-threads probe from the fixture.
  const bin = await mkdtemp(join(tmpdir(), "gh-stub-"));
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pr view"* ]]; then
  echo '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],"isDraft":false,"headRefOid":"deadbeef","baseRefName":"main"}'
elif [[ "$*" == *"graphql"* ]]; then
  echo '${graphqlThreads(2)}'
elif [[ "$*" == *"requested_reviewers"* ]]; then
  exit 0
else
  echo "unexpected gh args: $*" >&2
  exit 1
fi
`;
  await writeFile(join(bin, "gh"), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  // Pin the gh transport: `auto` would work too (the PATH stub answers the availability probe),
  // but the explicit mode is immune to the memoized probe result leaking in from another test file.
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "gh";
  globalThis.fetch = (() => Promise.resolve(new Response("no fetch in gh mode", { status: 500 }))) as typeof fetch;
  try {
    await pollMerges(data, engine, "tok");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    await rm(bin, { recursive: true, force: true });
  }
  const row = stores["pull_requests"][0];
  assertEquals(cancelled, ["merge-1"], "the live merge instance is retired before the re-open");
  assertEquals(row.status, "converging", "the re-opened PR row presents the fresh convergence run");
  assertEquals(row.process_key, "conv-1", "the row is re-pointed at the fresh convergence instance");
  assertEquals(instances.length, 1, "exactly one fresh convergence instance is started");
  assertEquals(instances[0].processDefinitionId, "convergence-loop", "the canonical convergence loop is re-entered");
  assertEquals(instances[0].variables.prKey, "o/r#100");
  assertEquals(instances[0].variables.round, 1, "the fresh run restarts at round 1");
  assertEquals(calls.reviewPosts, 0, "no bare re-review request — the handoff, not a nudge, drives remediation");
  assertEquals(stores["pr_adjudications"].length, 0, "the re-open wipes the prior run's adjudication memory (#806)");
  // PR #922 review (the "previously missed" advisory): the handoff is an INTERNAL resubmission, so it
  // must carry the row's existing escalation-steward opt-in through — a PR enrolled with automated
  // escalation resolution must not silently lose that behaviour merely because late review threads
  // appeared. `submitPr` defaults `autoResolveEscalations` to false and would overwrite the row to 0;
  // the handoff passes the row's existing opt-in (as the feature/plan enrollment paths already do).
  assertEquals(row.auto_resolve_escalations, 1, "the handoff preserves the escalation-steward opt-in on the row");
  assertEquals(
    instances[0].variables.autoResolveEscalations,
    true,
    "the fresh convergence instance carries the escalation-steward opt-in",
  );
});

test("#921/PR#922 poller: a FAILED convergence handoff stays retryable — the row returns to waiting_merge, not a stranded waiting_review (PR #922 review, thread 3)", async () => {
  // If the merge-instance cancel SUCCEEDS but `submitPr` then fails to create the replacement
  // convergence instance, the row must NOT be left in `waiting_review` carrying the cancelled merge
  // key: `pollMerges` no longer scans a `waiting_review` row, and `pollReviews` can only RESUME a
  // live instance (its `readiness-ready` message correlates to nothing once the merge instance is
  // cancelled and no fresh one exists), so the row would wedge with no handoff retry and no live
  // review-timeout timer. The handoff must instead leave the row RETRYABLE — back in `waiting_merge`
  // — so the next pass re-attempts the handoff against the already-retired (terminal) merge key.
  const { data, stores } = memData();
  const { engine, cancelled } = recordingEngine();
  const instances: any[] = [];
  // `submitPr` fails on the FIRST pass: the convergence instance cannot be created. A second pass
  // (below) succeeds once the engine recovers.
  let failCreate = true;
  (engine as any).createInstance = async (args: any) => {
    if (failCreate) throw new Error("engine unavailable");
    instances.push(args);
    return { processInstanceKey: "conv-retry-1" };
  };
  const mergeRow = { ...waitingMergeRow("o/r#100", 100), process_key: "merge-1" };
  stores["pull_requests"] = [mergeRow];
  // The derived tracking VIEW: the merge instance folds to a terminal edge once cancelled.
  stores["pull_requests__tracking"] = [{ ...mergeRow, derived_status: "waiting_merge" }];
  (engine as any).cancelInstance = async (args: { processInstanceKey: string }) => {
    cancelled.push(String(args.processInstanceKey));
    for (const t of stores["pull_requests__tracking"]) {
      if (t.process_key === String(args.processInstanceKey)) t.derived_status = "abandoned";
    }
  };
  const calls = { reviewPosts: 0 };
  const bin = await mkdtemp(join(tmpdir(), "gh-stub-"));
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pr view"* ]]; then
  echo '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],"isDraft":false,"headRefOid":"deadbeef","baseRefName":"main"}'
elif [[ "$*" == *"graphql"* ]]; then
  echo '${graphqlThreads(2)}'
elif [[ "$*" == *"requested_reviewers"* ]]; then
  exit 0
else
  echo "unexpected gh args: $*" >&2
  exit 1
fi
`;
  await writeFile(join(bin, "gh"), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "gh";
  globalThis.fetch = (() => Promise.resolve(new Response("no fetch in gh mode", { status: 500 }))) as typeof fetch;
  try {
    // Pass 1: the handoff fails (createInstance throws). Issue #943: the successor is started BEFORE
    // the merge instance is retired, so a failed start leaves the merge instance LIVE (never retired
    // into nothing).
    await pollMerges(data, engine, "tok");
    const rowAfterFail = stores["pull_requests"][0];
    assertEquals(cancelled, [], "no successor -> the live merge instance is NOT retired");
    assertEquals(rowAfterFail.process_key, "merge-1", "the live merge instance still owns the row");
    assertEquals(
      rowAfterFail.status,
      "waiting_merge",
      "a failed handoff leaves the row retryable in waiting_merge (re-scanned next pass), not stranded in waiting_review",
    );
    assertEquals(instances.length, 0, "no convergence instance was created on the failed pass");

    // Pass 2: the engine recovers. The retry re-derives the `review-threads` verdict and re-attempts
    // the handoff; the merge key is already terminal, so the idempotency gate falls through and the
    // fresh convergence instance starts — the PR is NOT wedged.
    failCreate = false;
    await pollMerges(data, engine, "tok");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    await rm(bin, { recursive: true, force: true });
  }
  const row = stores["pull_requests"][0];
  assertEquals(instances.length, 1, "the retry starts the fresh convergence instance");
  assertEquals(instances[0].processDefinitionId, "convergence-loop", "the canonical convergence loop is re-entered on retry");
  assertEquals(row.status, "converging", "the retried handoff completes — the row presents the fresh convergence run");
  assertEquals(row.process_key, "conv-retry-1", "the row is re-pointed at the fresh convergence instance");
  assertEquals(cancelled, ["merge-1"], "the merge instance is retired only once the successor exists");
});

test("#943 poller: the convergence handoff never retires the merge loop into NOTHING — the derived tracking edge folds the cancel ASYNCHRONOUSLY (nanobpm/nano-bpm#1452)", async () => {
  // Production shape: `pull_requests__tracking.derived_status` folds an engine cancel in LATER (the
  // reconciler edge), not synchronously inside `cancelInstance`. The old cancel-then-submit order
  // therefore had `submitPr` read the just-cancelled merge key as a LIVE owner, return
  // `alreadyRunning`, and start nothing — merge loop terminated, no successor, no escalation.
  const { data, stores } = memData();
  const { engine, cancelled } = recordingEngine();
  const instances: any[] = [];
  (engine as any).createInstance = async (args: any) => {
    instances.push(args);
    return { processInstanceKey: "conv-943" };
  };
  const mergeRow = { ...waitingMergeRow("o/r#1452", 1452), process_key: "merge-607414" };
  stores["pull_requests"] = [mergeRow];
  // The tracking view stays `waiting_merge` across the cancel (async fold), exactly as on merlin.
  stores["pull_requests__tracking"] = [{ ...mergeRow, derived_status: "waiting_merge" }];
  const bin = await mkdtemp(join(tmpdir(), "gh-stub-"));
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pr view"* ]]; then
  echo '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],"isDraft":false,"headRefOid":"deadbeef","baseRefName":"main"}'
elif [[ "$*" == *"graphql"* ]]; then
  echo '${graphqlThreads(1)}'
elif [[ "$*" == *"requested_reviewers"* ]]; then
  exit 0
else
  echo "unexpected gh args: $*" >&2
  exit 1
fi
`;
  await writeFile(join(bin, "gh"), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "gh";
  globalThis.fetch = (() => Promise.resolve(new Response("no fetch in gh mode", { status: 500 }))) as typeof fetch;
  try {
    await pollMerges(data, engine, "tok");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    await rm(bin, { recursive: true, force: true });
  }
  const row = stores["pull_requests"][0];
  assertEquals(instances.length, 1, "a successor convergence instance is started");
  assertEquals(row.process_key, "conv-943", "the row is owned by the successor");
  assertEquals(cancelled, ["merge-607414"], "the merge loop is retired only after the successor exists");
  // PR #944 review: the predecessor's cancel reason is bound to the predecessor, never stamped onto
  // the successor-owned row (it would mask a later orphaning of the successor).
  assert(row.termination_reason == null, `the successor's row carries no predecessor provenance, got ${row.termination_reason}`);
});

test("#921/PR#922 poller: an UNFINISHED handoff (dead merge instance) never publishes merge-ready to the cancelled owner — it re-establishes a live convergence owner first (PR #922 review, round 5)", async () => {
  // The round-4 retry-restore leaves a failed handoff's row back in `waiting_merge` — but its
  // `process_key` still names the CANCELLED merge instance (derived_status `abandoned`). If the next
  // pass's GitHub verdict has moved off `review-threads` (the threads were resolved out-of-band, so the
  // PR now reads `ready`), the verdict switch would fall through to `flipToMergingThenPublish` and
  // publish `merge-ready {ready}` correlated to the DEAD merge instance — the message is dropped and the
  // row wedges at `merging` with no live owner. The handoff must instead be persisted INDEPENDENTLY of
  // the current verdict: a `waiting_merge` row whose merge instance is already terminal has no live
  // merge-loop to signal, so the poller must re-establish a live convergence owner (re-open via
  // `submitPr`) BEFORE any merge message is contemplated.
  const { data, stores } = memData();
  const { engine, messages, cancelled } = recordingEngine();
  const instances: any[] = [];
  (engine as any).createInstance = async (args: any) => {
    instances.push(args);
    return { processInstanceKey: "conv-fresh-1" };
  };
  // The unfinished-handoff shape: a prior pass's handoff retired the merge instance and its `submitPr`
  // failed, so the restore left the row in `waiting_merge` with `process_key` NULL — no live owner.
  const mergeRow = { ...waitingMergeRow("o/r#100", 100), process_key: null };
  stores["pull_requests"] = [mergeRow];
  stores["pull_requests__tracking"] = [{ ...mergeRow, derived_status: "waiting_merge" }];
  const calls = { reviewPosts: 0 };
  const bin = await mkdtemp(join(tmpdir(), "gh-stub-"));
  // A clean READY verdict: MERGEABLE, all checks green, ZERO unresolved threads — the threads that
  // triggered the original handoff were resolved out-of-band. This is the verdict that would send the
  // PR through the normal `ready` branch and publish to the dead owner.
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pr view"* ]]; then
  echo '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],"isDraft":false,"headRefOid":"deadbeef","baseRefName":"main"}'
elif [[ "$*" == *"graphql"* ]]; then
  echo '${graphqlThreads(0)}'
elif [[ "$*" == *"requested_reviewers"* ]]; then
  exit 0
else
  echo "unexpected gh args: $*" >&2
  exit 1
fi
`;
  await writeFile(join(bin, "gh"), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "gh";
  globalThis.fetch = (() => Promise.resolve(new Response("no fetch in gh mode", { status: 500 }))) as typeof fetch;
  try {
    await pollMerges(data, engine, "tok");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    await rm(bin, { recursive: true, force: true });
  }
  const row = stores["pull_requests"][0];
  assertEquals(
    messages.filter((m) => m.name === "merge-ready").length,
    0,
    "an unfinished handoff must NOT publish merge-ready to the cancelled merge instance — the message would be dropped and the row wedged at merging",
  );
  assertEquals(
    instances.length,
    1,
    "the poller re-establishes a live convergence owner before any merge message, independently of the ready verdict",
  );
  assertEquals(instances[0].processDefinitionId, "convergence-loop", "the canonical convergence loop is re-entered");
  assertEquals(row.process_key, "conv-fresh-1", "the row is re-pointed at the fresh live convergence instance");
  assertEquals(row.status, "converging", "the row presents the fresh convergence run, not a wedged merging");
});

test("#921/PR#922 poller: a HUMAN-CANCELLED merge-stage PR is NOT resurrected — the dead-owner guard keys on the NULL process_key, not the terminal derived_status", async () => {
  // Anti-regression for the round-5 guard: a human cancel of a parked merge wait terminates the merge
  // instance, so the row keeps base `status: "waiting_merge"` (the reconciler no longer writes the
  // terminal edge onto the base row) and `process_key` STILL naming the terminated instance, while the
  // derived VIEW folds to `abandoned`. That shape must NOT be re-opened into convergence — a cancelled
  // run stays cancelled (the abandon protocol exists precisely to stop orphaned side effects). The guard
  // therefore keys on `process_key === null` (the unfinished-handoff marker the restore writes), NOT on
  // the terminal `derived_status` — which a human cancel shares. This row keeps `process_key` set, so the
  // guard must not fire and no convergence instance may be created.
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  const instances: any[] = [];
  (engine as any).createInstance = async (args: any) => {
    instances.push(args);
    return { processInstanceKey: "conv-should-not-start" };
  };
  // Human-cancelled shape: base waiting_merge, process_key STILL set (names the terminated instance),
  // derived_status folded terminal. Distinct from the unfinished handoff (which NULLs process_key).
  const mergeRow = { ...waitingMergeRow("o/r#100", 100), process_key: "merge-cancelled-by-human" };
  stores["pull_requests"] = [mergeRow];
  stores["pull_requests__tracking"] = [{ ...mergeRow, derived_status: "abandoned" }];
  const calls = { reviewPosts: 0 };
  const bin = await mkdtemp(join(tmpdir(), "gh-stub-"));
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pr view"* ]]; then
  echo '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],"isDraft":false,"headRefOid":"deadbeef","baseRefName":"main"}'
elif [[ "$*" == *"graphql"* ]]; then
  echo '${graphqlThreads(0)}'
elif [[ "$*" == *"requested_reviewers"* ]]; then
  exit 0
else
  echo "unexpected gh args: $*" >&2
  exit 1
fi
`;
  await writeFile(join(bin, "gh"), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "gh";
  globalThis.fetch = (() => Promise.resolve(new Response("no fetch in gh mode", { status: 500 }))) as typeof fetch;
  try {
    await pollMerges(data, engine, "tok");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    await rm(bin, { recursive: true, force: true });
  }
  assertEquals(
    instances.length,
    0,
    "a human-cancelled merge-stage PR must NOT be resurrected into convergence — its process_key still names the terminated instance, so the dead-owner guard does not fire",
  );
  assertEquals(
    messages.filter((m) => m.name === "merge-ready").length,
    0,
    "no merge-ready is published to the cancelled (dead) merge instance — publishing it would be dropped and wedge the row at merging",
  );
  assertEquals(
    stores["pull_requests"][0].process_key,
    "merge-cancelled-by-human",
    "the cancelled row's process_key is left untouched (not nulled, not re-pointed)",
  );
  assertEquals(
    stores["pull_requests"][0].status,
    "waiting_merge",
    "the cancelled row is left in place (not flipped to the transient merging) — the abandon terminal edge is derived, not poller-written",
  );
});
