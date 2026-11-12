// Tests for GET /app/api/status → operation `listActivePrs` (ADR 0058 OpenAPI surface).
// Covers the happy path (count/prs projection) and the optional shared-secret guard. A minimal
// in-memory DataLayer backs `activePrs` (it reads the `pull_requests` table via `.all()`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import handler from "./listActivePrs.ts";

function memApp(rows: any[], userTaskRows: any[] = [], deliveryRows: any[] = []): AppApi {
  const table = (name: string) => {
    if (name === "user_tasks") {
      return {
        async all() {
          return userTaskRows;
        },
        async find(where: Record<string, unknown>) {
          return userTaskRows.filter((t) => Object.entries(where).every(([k, v]) => t[k] === v));
        },
      };
    }
    if (name === "delivery_graph_runs") {
      return {
        async all() {
          return deliveryRows;
        },
      };
    }
    return {
      async all() {
        return rows;
      },
    };
  };
  return { data: { table: withTrackingViews(table) }, log: noopLog() } as any as AppApi;
}

function input(headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/status",
      query: new URLSearchParams(),
      headers: new Headers(headers),
      text: async () => "",
    } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

test("returns 200 with a count + projected active PRs", async () => {
  const app = memApp([
    { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u1", title: "t", status: "converging", current_round: 2, process_key: "9", updated_at: "2026-01-02" },
    { pr_key: "o/r#2", repo: "o/r", number: 2, url: "u2", title: null, status: "converged", current_round: 1, process_key: null, updated_at: "2026-01-01" },
  ]);
  const res = await handler(input(), app);
  const r = res as any;
  assertEquals(r.status, 200);
  // `converged` is terminal → filtered out, leaving one active PR.
  assertEquals(r.body.count, 1);
  assertEquals(r.body.prs.length, 1);
  assertEquals(r.body.prs[0].prKey, "o/r#1");
  assertEquals(r.body.prs[0].processKey, "9");
});

test("surfaces hasCustomInstructions from the durable row projection (issue #956)", async () => {
  // The operator can see that a loop is being steered without opening the engine: `submitPr` stamps
  // the `custom_instructions` column (1/0) at submit/reopen, and `/status` serves it as a boolean.
  // A legacy row (NULL — written before the projection existed) reads false, never an engine read.
  const app = memApp([
    { pr_key: "o/r#30", repo: "o/r", number: 30, url: "u30", title: "steered", status: "converging", current_round: 1, process_key: "PI-30", updated_at: "2026-01-03", custom_instructions: 1 },
    { pr_key: "o/r#31", repo: "o/r", number: 31, url: "u31", title: "plain", status: "converging", current_round: 1, process_key: "PI-31", updated_at: "2026-01-02", custom_instructions: 0 },
    { pr_key: "o/r#32", repo: "o/r", number: 32, url: "u32", title: "legacy", status: "converging", current_round: 1, process_key: "PI-32", updated_at: "2026-01-01" },
  ]);
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  const byKey = (k: string) => res.body.prs.find((p: any) => p.prKey === k);
  assertEquals(byKey("o/r#30").hasCustomInstructions, true, "a steered loop is visible");
  assertEquals(byKey("o/r#31").hasCustomInstructions, false, "an unsteered loop reads false");
  assertEquals(byKey("o/r#32").hasCustomInstructions, false, "a legacy (NULL) row reads false");
});

test("carries the running app's identity as a top-level version object (issue #925)", async () => {
  // `/status` is the endpoint everyone polls, so it must answer "is the fix live?" on its own:
  // version.version + version.gitSha, derived from the SAME app/version.ts getter /version uses.
  const app = memApp([]);
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assert("version" in res.body, "the status payload carries a top-level version object");
  assert("version" in res.body.version, "version.version is present (string|null)");
  assert("gitSha" in res.body.version, "version.gitSha is present (string|null)");
  const { buildVersionInfo } = await import("../app/version.ts");
  const identity = buildVersionInfo();
  assertEquals(res.body.version.version, identity.version, "derived from the app/version.ts getter, not re-read");
  assertEquals(res.body.version.gitSha, identity.gitSha, "derived from the app/version.ts getter, not re-read");
});

test("surfaces the structured openEscalation from the user_tasks read model (both loops)", async () => {
  // Issue #666: openEscalation is derived from the ONE `user_tasks` read model (the same surface
  // `listEscalations` and the Convergence page consume), so `/status` carries the completable
  // userTaskKey. A `user_tasks` row for a PR subject exists iff its review/merge-loop escalation task
  // is currently open; a PR with no such row derives null. Cover a review-loop and a merge-loop PR.
  const app = memApp(
    [
      { pr_key: "o/r#10", repo: "o/r", number: 10, url: "u10", title: "merge blocked", status: "escalated", current_round: 3, process_key: "m1", updated_at: "2026-02-02" },
      { pr_key: "o/r#11", repo: "o/r", number: 11, url: "u11", title: "no open task", status: "escalated", current_round: 4, process_key: "m2", updated_at: "2026-02-01" },
    ],
    [
      {
        user_task_key: "ut-10",
        element_id: "wait-merge-answer",
        kind_label: "PR merge",
        subject_type: "pr",
        subject_key: "o/r#10",
        subject_title: "merge blocked",
        subject_url: null,
        question: "Resolve the conflict on the branch, then retry?",
        process_key: "m1",
        form_key: null,
        created_at: "2026-02-02",
        updated_at: "2026-02-02",
      },
    ],
  );
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  const p10 = res.body.prs.find((p: any) => p.prKey === "o/r#10");
  const p11 = res.body.prs.find((p: any) => p.prKey === "o/r#11");
  assertEquals(p10.openEscalation, {
    userTaskKey: "ut-10",
    kind: "wait-merge-answer",
    summary: "Resolve the conflict on the branch, then retry?",
  });
  assertEquals(p11.openEscalation, null);
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./listActivePrs.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const app = memApp([]);
    const bad = (await guarded(input(), app)) as any;
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({ "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
    assert("count" in ok.body);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});

test("surfaces each in-flight delivery run with its durable escalation-steward opt-in (issue #889 §1)", async () => {
  // `/status` must show the opt-in for each PR AND each delivery. A terminal (`done`) run drops out;
  // a live run carries its durable `auto_resolve_escalations` flag (never a clobbered process var) and
  // its open escalation pointer (derived from the SAME `user_tasks` read model, subject_type
  // "delivery", keyed by run_key).
  const app = memApp(
    [],
    [
      {
        user_task_key: "ut-d1",
        element_id: "delivery-human-taskish",
        kind_label: "Delivery approval",
        subject_type: "delivery",
        subject_key: "run-live",
        subject_title: "Ship it",
        subject_url: null,
        question: "approve the release?",
        process_key: "pk-live",
        form_key: null,
        created_at: "2026-03-02",
        updated_at: "2026-03-02",
      },
    ],
    [
      { run_key: "run-live", process_key: "pk-live", status: "running", phase: "Running", title: "Ship it", auto_resolve_escalations: 1, updated_at: "2026-03-02" },
      { run_key: "run-done", process_key: "pk-done", status: "done", phase: "Done", title: "Old", auto_resolve_escalations: 0, updated_at: "2026-03-01" },
    ],
  );
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.deliveries.length, 1, "a terminal (done) run drops out of the active list");
  const d = res.body.deliveries[0];
  assertEquals(d.runKey, "run-live");
  assertEquals(d.autoResolveEscalations, true, "the durable opt-in flag is surfaced for the delivery");
  assertEquals(d.processKey, "pk-live");
  assertEquals(d.openEscalation, { userTaskKey: "ut-d1", kind: "delivery-human-taskish", summary: "approve the release?" });
});

test("a delivery run with no opt-in row flag surfaces autoResolveEscalations false and a null escalation", async () => {
  const app = memApp(
    [],
    [],
    [{ run_key: "run-plain", process_key: null, status: "running", phase: null, title: null, auto_resolve_escalations: 0, updated_at: "2026-03-03" }],
  );
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.deliveries.length, 1);
  assertEquals(res.body.deliveries[0].autoResolveEscalations, false);
  assertEquals(res.body.deliveries[0].openEscalation, null);
  assertEquals(res.body.deliveries[0].processKey, null, "a launch-in-flight run has no stamped process_key yet");
});

// ── Issue #936: /status latency + concurrency regression guard ────────────────────────────────
// The defect: `activePrs` fanned the merge-policy read out per row — 3 `searchVariables` engine
// round-trips PER active PR — so 4 rows cost 12 sequential-ish upstream calls (~13 s) and K
// concurrent callers stacked (~50 s → the console proxy 502'd). The fix batches the engine read:
// ONE name-less `searchVariables({})` per /status serve, bucketed in memory. These tests pin the
// contract against a fake engine with a REALISTIC per-call delay: the engine-call count must stay
// at one per serve regardless of row count, and K concurrent serves must overlap (wall time ≈ one
// upstream round-trip, not K ×).

/** A fake engine that serves the batched variable read after a realistic upstream delay, counting
 *  calls and tracking peak in-flight concurrency. */
function slowEngine(varsByInstance: Record<string, Record<string, unknown>>, delayMs: number) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls: () => calls,
    maxInFlight: () => maxInFlight,
    searchVariables: async (q: { processInstanceKey?: string; scopeKey?: string; name?: string }) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      const rows: { name: string; value: string; processInstanceKey: string; scopeKey: string }[] = [];
      for (const [piKey, vars] of Object.entries(varsByInstance)) {
        if (q.processInstanceKey != null && piKey !== String(q.processInstanceKey)) continue;
        if (q.scopeKey != null && piKey !== String(q.scopeKey)) continue;
        for (const [name, v] of Object.entries(vars)) {
          if (q.name != null && name !== q.name) continue;
          rows.push({ name, value: JSON.stringify(v), processInstanceKey: piKey, scopeKey: piKey });
        }
      }
      return rows;
    },
  } as any;
}

function prRow936(n: number) {
  return {
    pr_key: `o/r#${n}`,
    repo: "o/r",
    number: n,
    url: `https://github.com/o/r/pull/${n}`,
    title: `PR ${n}`,
    status: "converging",
    current_round: 1,
    process_key: `PI-${n}`,
    updated_at: `2026-01-${String(n).padStart(2, "0")}`,
  };
}

test("issue #936: N active rows cost a constant 3 engine variable reads, not 3N (the 13 s fan-out)", async () => {
  const N = 8;
  const rows = Array.from({ length: N }, (_, i) => prRow936(i + 1));
  const vars: Record<string, Record<string, unknown>> = {};
  for (let i = 1; i <= N; i++) vars[`PI-${i}`] = { autoMerge: true, convergeOnly: false, humanApproval: false };
  const engine = slowEngine(vars, 25);
  const app = { ...memApp(rows), engine } as AppApi;
  const started = Date.now();
  const res = (await handler(input(), app)) as any;
  const elapsed = Date.now() - started;
  assertEquals(res.status, 200);
  assertEquals(res.body.count, N);
  assertEquals(
    engine.calls(),
    3,
    "the merge-policy projection batches to ONE read per policy name (3) per serve — a per-row fan-out would show 3N calls",
  );
  assert(
    elapsed < 25 * N,
    `one batched ~25 ms upstream read serves ${N} rows (took ${elapsed} ms); the per-row fan-out this regresses to would take ≥ ${25 * N} ms`,
  );
  // The batch still projects the per-row policy correctly.
  for (const pr of res.body.prs) {
    assertEquals(pr.merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: false });
  }
});

test("issue #936: K concurrent /status callers overlap instead of queueing behind each other", async () => {
  const K = 4;
  const rows = [prRow936(1), prRow936(2)];
  const vars = {
    "PI-1": { autoMerge: true, convergeOnly: false, humanApproval: false },
    "PI-2": { autoMerge: false, convergeOnly: true, humanApproval: false },
  };
  // A realistic slow upstream: each engine read takes 100 ms. Serialized callers would stack to
  // K × 100 ms (the measured 35–50 s at production scale); overlapped callers finish in ~100 ms.
  const engine = slowEngine(vars, 100);
  const app = { ...memApp(rows), engine } as AppApi;
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: K }, () => handler(input(), app)));
  const elapsed = Date.now() - started;
  for (const res of results) {
    assertEquals((res as any).status, 200);
    assertEquals((res as any).body.count, 2);
  }
  assertEquals(engine.calls(), 3 * K, "each serve issues its own batched reads (no cross-request cache serving stale policy)");
  assertEquals(
    engine.maxInFlight(),
    3 * K,
    "all K engine reads were in flight at once — the serves overlap rather than serialise",
  );
  assert(
    elapsed < K * 100,
    `${K} concurrent serves over a 100 ms upstream finished in ${elapsed} ms (< ${K * 100} ms) — no caller queued behind another`,
  );
  // Mixed intents still project per row under the batched read.
  const body = (results[0] as any).body;
  assertEquals(body.prs.find((p: any) => p.prKey === "o/r#1").merge.requested, true);
  assertEquals(body.prs.find((p: any) => p.prKey === "o/r#2").merge.requested, false);
});

// ── PR #937 review: completeness, root scope, idle skip ──────────────────────────────────────

/** A fake engine with explicit rows (incl. child scopes) whose engine-wide reads are cut to one
 *  `pageSize` page — the production seam returns a single page with no cursor. */
function pagedEngine(
  rows: { name: string; value: string; processInstanceKey: string; scopeKey: string }[],
  pageSize: number,
) {
  const queries: { processInstanceKey?: string; scopeKey?: string; name?: string }[] = [];
  return {
    queries,
    searchVariables: async (q: { processInstanceKey?: string; scopeKey?: string; name?: string }) => {
      queries.push(q);
      return rows
        .filter(
          (r) =>
            (q.processInstanceKey == null || r.processInstanceKey === q.processInstanceKey) &&
            (q.scopeKey == null || r.scopeKey === q.scopeKey) &&
            (q.name == null || r.name === q.name),
        )
        .slice(0, pageSize);
    },
  } as any;
}

function v(pk: string, name: string, value: unknown, scopeKey = pk) {
  return { name, value: JSON.stringify(value), processInstanceKey: pk, scopeKey };
}

test("PR #937: an active PR's policy cut off the first engine page is still read (targeted fallback)", async () => {
  const rows = [];
  // 50 unrelated (completed/other) instances fill the single page ahead of the active PR.
  for (let i = 0; i < 50; i++) {
    for (const n of ["autoMerge", "convergeOnly", "humanApproval"]) rows.push(v(`OTHER-${i}`, n, true));
  }
  rows.push(v("PI-1", "autoMerge", false), v("PI-1", "convergeOnly", true), v("PI-1", "humanApproval", true));
  const engine = pagedEngine(rows, 10);
  const res = (await handler(input(), { ...memApp([prRow936(1)]), engine } as AppApi)) as any;
  assertEquals(res.body.prs[0].merge.requested, false, "autoMerge:false beyond page 1 must not degrade to requested");
  const withApproval = pagedEngine(
    [...rows.filter((r) => r.processInstanceKey !== "PI-1"), v("PI-1", "autoMerge", true), v("PI-1", "humanApproval", true)],
    10,
  );
  const res2 = (await handler(input(), { ...memApp([prRow936(1)]), engine: withApproval } as AppApi)) as any;
  assertEquals(res2.body.prs[0].merge.blockedBy != null, true, "the human-approval blocker beyond page 1 is not dropped");
});

for (const order of ["root-first", "child-first"] as const) {
  test(`PR #937: child-scoped policy vars never override the root policy (${order})`, async () => {
    const root = [v("PI-1", "autoMerge", false), v("PI-1", "humanApproval", true)];
    const child = [v("PI-1", "autoMerge", true, "EI-9"), v("PI-1", "humanApproval", false, "EI-9")];
    const engine = pagedEngine(order === "root-first" ? [...root, ...child] : [...child, ...root], 100);
    const res = (await handler(input(), { ...memApp([prRow936(1)]), engine } as AppApi)) as any;
    assertEquals(res.body.prs[0].merge.requested, false);
    const engine2 = pagedEngine(
      order === "root-first"
        ? [v("PI-1", "autoMerge", true), v("PI-1", "humanApproval", true), ...child]
        : [...child, v("PI-1", "autoMerge", true), v("PI-1", "humanApproval", true)],
      100,
    );
    const res2 = (await handler(input(), { ...memApp([prRow936(1)]), engine: engine2 } as AppApi)) as any;
    assertEquals(res2.body.prs[0].merge.blockedBy != null, true, "a child humanApproval:false cannot hide the root gate");
  });
}

test("PR #937: no engine read when no active row has a process key", async () => {
  const engine = pagedEngine([], 100);
  await handler(input(), { ...memApp([]), engine } as AppApi);
  await handler(input(), { ...memApp([{ ...prRow936(1), process_key: null }]), engine } as AppApi);
  assertEquals(engine.queries.length, 0);
});

// ── PR #937 round-3 review: bounded fallback fan-out, per-instance failure isolation ─────────

test("PR #937 r4: populated merge-loop roots cost a constant 3 reads (startMerge seeds the policy)", async () => {
  // Round-3 defect: merge-loop roots carry non-policy vars, so the name-less fallback was non-empty
  // and each merging PR paid 1 + 3 probes (19 calls at N=4). startMerge now seeds the policy triple,
  // so populated merge-loop roots are fully represented in the batch and need no probes.
  const N = 4;
  const rows = Array.from({ length: N }, (_, i) => prRow936(i + 1));
  const vars = [];
  for (let i = 1; i <= N; i++) {
    const pk = `PI-${i}`;
    vars.push(v(pk, "repo", "o/r"), v(pk, "prNumber", i), v(pk, "ciFixRound", 0));
    vars.push(v(pk, "autoMerge", true), v(pk, "convergeOnly", false), v(pk, "humanApproval", false));
  }
  const engine = pagedEngine(vars, 100);
  const res = (await handler(input(), { ...memApp(rows), engine } as AppApi)) as any;
  assertEquals(res.body.count, N);
  assertEquals(engine.queries.length, 3, "populated merge-loop roots need no per-instance probes");
});

test("PR #937 r4: a name cut from ONE page is re-probed even when the instance appears in another", async () => {
  // Round-3 defect: an instance present in the autoMerge page was treated as complete, so a
  // humanApproval:true cut from its own page was dropped and /status reported an unblocked merge.
  const rows = [v("PI-1", "autoMerge", true), v("PI-1", "convergeOnly", false)];
  for (let i = 0; i < 20; i++) rows.push(v(`OTHER-${i}`, "humanApproval", false));
  rows.push(v("PI-1", "humanApproval", true));
  const engine = pagedEngine(rows, 10);
  const res = (await handler(input(), { ...memApp([prRow936(1)]), engine } as AppApi)) as any;
  assertEquals(res.body.prs[0].merge.blockedBy, "human-approval", "the cut humanApproval gate is recovered");
  const targeted = engine.queries.filter((q: any) => q.processInstanceKey === "PI-1");
  assertEquals(targeted.length, 1, "only the missing name is probed");
  assertEquals(targeted[0].name, "humanApproval");
  assertEquals(targeted[0].scopeKey, "PI-1", "the probe is confined to the process-root scope");
});

test("PR #937 r4: a failed probe after a partial batch drops the partial entry (default, not half-read)", async () => {
  const failing = {
    searchVariables: async (q: { processInstanceKey?: string; name?: string }) => {
      if (q.processInstanceKey === "PI-1") throw new Error("engine read timed out");
      if (q.name === "humanApproval") return [v("PI-1", "humanApproval", true)];
      return [];
    },
  } as any;
  const res = (await handler(input(), { ...memApp([prRow936(1)]), engine: failing } as AppApi)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.prs[0].merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: true });
});

test("PR #937 r4: a cut-off instance is recovered with name-filtered (untruncatable) root probes", async () => {
  const rows = [];
  for (let i = 0; i < 50; i++) {
    for (const n of ["autoMerge", "convergeOnly", "humanApproval"]) rows.push(v(`OTHER-${i}`, n, true));
  }
  rows.push(v("PI-1", "autoMerge", true), v("PI-1", "convergeOnly", false));
  rows.push(v("PI-2", "autoMerge", true), v("PI-2", "convergeOnly", false), v("PI-2", "humanApproval", true));
  const engine = pagedEngine(rows, 10);
  const res = (await handler(input(), { ...memApp([prRow936(1), prRow936(2)]), engine } as AppApi)) as any;
  const pr2 = res.body.prs.find((p: any) => p.prKey === "o/r#2");
  assertEquals(pr2.merge.requested, true);
  assertEquals(pr2.merge.blockedBy, "human-approval");
  for (const q of engine.queries.filter((q: any) => q.processInstanceKey != null)) {
    assert(q.name != null, "every fallback read is name-filtered (<=1 row, cannot be truncated)");
    assertEquals(q.scopeKey, q.processInstanceKey);
  }
});

test("PR #937 r3: one failed targeted read degrades only its own instance, not every other PR's policy", async () => {
  // Round-2 defect: a rejected targeted read propagated to the OUTER catch, so the whole batch
  // read was discarded and PI-1's already-fetched policy silently degraded to "merge requested,
  // no approval blocker". Each instance's fallback must fail independently. PI-1 requests the
  // merge AND carries an outstanding approval gate; PI-2's fallback rejects.
  const failing = {
    searchVariables: async (q: { processInstanceKey?: string; scopeKey?: string; name?: string }) => {
      if (q.processInstanceKey === "PI-2") throw new Error("engine read timed out");
      if (q.name === "autoMerge") return [v("PI-1", "autoMerge", true)];
      if (q.name === "humanApproval") return [v("PI-1", "humanApproval", true)];
      return [];
    },
  } as any;
  const res = (await handler(input(), { ...memApp([prRow936(1), prRow936(2)]), engine: failing } as AppApi)) as any;
  assertEquals(res.status, 200);
  const pr1 = res.body.prs.find((p: any) => p.prKey === "o/r#1");
  assertEquals(pr1.merge.requested, true, "PI-1's fetched merge intent survives PI-2's failed fallback");
  assertEquals(pr1.merge.blockedBy, "human-approval", "PI-1's fetched approval blocker survives PI-2's failed fallback");
  const pr2 = res.body.prs.find((p: any) => p.prKey === "o/r#2");
  assertEquals(pr2.merge.requested, true, "the failed instance degrades to the historical default (merge requested)");
  assertEquals(pr2.merge.blockedBy, null, "the failed instance shows no approval blocker it could not verify");
});

test("PR #937 r3: a failed BATCH read still degrades every row to the default (no partial page)", async () => {
  // The batched name reads are the completeness backbone — if one rejects, its page is partial
  // and absence can no longer be distinguished from a page cut, so the whole projection degrades.
  const failing = {
    searchVariables: async (q: { name?: string }) => {
      if (q.name === "humanApproval") throw new Error("engine read timed out");
      if (q.name === "autoMerge") return [v("PI-1", "autoMerge", false)];
      return [];
    },
  } as any;
  const res = (await handler(input(), { ...memApp([prRow936(1)]), engine: failing } as AppApi)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.prs[0].merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: true });
});

// ── Issue #947: /status serves the merge policy from the app's OWN projection — ZERO engine reads ─
// The #936/#937 batching left /status at 3 engine-wide `searchVariables` pages plus a per-(instance,
// name) probe for any name cut from its page. On the loaded merlin host (v0.208.1, 9 PRs) the
// variables search itself takes ~1.4 s and the engine-wide pages silently truncate, so every active
// row paid probes — ~30 s per serve and a 502 behind the console proxy. The fix for the CLASS: the
// merge policy is written onto the `pull_requests` row by the writers that already know it
// (`submitPr` stamps `merge_requested` at submit/reopen and `merge_human_approval` when it gates a
// live loop; `startMerge` stamps the merge-stage policy), so the hot read path serves it from the
// app's own DB and never touches the engine. A NULL `merge_requested` marks a row written before
// this projection existed; only those legacy rows fall back to the #937 batched engine read.

/** A PR row carrying the durable merge-policy projection (issue #947): the shape every writer
 *  stamps from this fix on, so /status never pays an engine round-trip for it. */
function prRow947(n: number, over: Record<string, unknown> = {}) {
  return { ...prRow936(n), merge_requested: 1, merge_human_approval: 0, ...over };
}

/** An engine double that counts calls and fails the test if it is read at all. */
function countingEngine(rows: { name: string; value: string; processInstanceKey: string; scopeKey: string }[] = []) {
  const queries: { processInstanceKey?: string; scopeKey?: string; name?: string }[] = [];
  return {
    queries,
    searchVariables: async (q: { processInstanceKey?: string; scopeKey?: string; name?: string }) => {
      queries.push(q);
      return rows
        .filter(
          (r) =>
            (q.processInstanceKey == null || r.processInstanceKey === q.processInstanceKey) &&
            (q.scopeKey == null || r.scopeKey === q.scopeKey) &&
            (q.name == null || r.name === q.name),
        )
        .slice(0, 10);
    },
  } as any;
}

test("issue #947: N policy-stamped rows cost ZERO engine reads — /status serves its own projection", async () => {
  // Red against the pre-fix shape: `activePrs` consulted the engine for every row, so this fails
  // with 3N+ calls. Green when the merge policy is served from the `pull_requests` projection.
  const N = 9; // the merlin fleet size that took 29.6 s
  const rows = Array.from({ length: N }, (_, i) => prRow947(i + 1));
  const engine = countingEngine();
  const started = Date.now();
  const res = (await handler(input(), { ...memApp(rows), engine } as AppApi)) as any;
  const elapsed = Date.now() - started;
  assertEquals(res.status, 200);
  assertEquals(res.body.count, N);
  assertEquals(
    engine.queries.length,
    0,
    "a row whose merge policy is projected on the pull_requests row never costs an engine round-trip",
  );
  assert(
    elapsed < 1000,
    `the projected read serves ${N} rows in well under the 2 s acceptance budget (took ${elapsed} ms)`,
  );
  for (const pr of res.body.prs) {
    assertEquals(pr.merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: false });
  }
});

test("issue #947: the projected policy drives requested/blockedBy per row (review-only + approval gate)", async () => {
  const rows = [
    prRow947(1, { merge_requested: 0, merge_human_approval: 0 }), // review-only
    prRow947(2, { merge_requested: 1, merge_human_approval: 1 }), // parked at merge-approval
    prRow947(3, { merge_requested: 1, merge_human_approval: null }), // gated, approval outstanding
    prRow947(4, { merge_requested: 1, merge_human_approval: 0 }), // approved / never gated
  ];
  const engine = countingEngine();
  const res = (await handler(input(), { ...memApp(rows), engine } as AppApi)) as any;
  assertEquals(engine.queries.length, 0);
  const byKey = (k: string) => res.body.prs.find((p: any) => p.prKey === k).merge;
  assertEquals(byKey("o/r#1"), { requested: false, enabled: true, effective: false, blockedBy: null, stale: false });
  assertEquals(byKey("o/r#2"), { requested: true, enabled: true, effective: false, blockedBy: "human-approval", stale: false });
  assertEquals(byKey("o/r#3"), { requested: true, enabled: true, effective: false, blockedBy: "human-approval", stale: false });
  assertEquals(byKey("o/r#4"), { requested: true, enabled: true, effective: true, blockedBy: null, stale: false });
});

test("issue #947: ONLY legacy (unstamped) rows fall back to the batched engine read — stamped rows never do", async () => {
  // Expand-and-contract back-compat: a row written before the projection existed carries
  // `merge_requested: NULL`. It keeps the #937 batched engine read (3 constant calls for the whole
  // legacy set, never per-row), while its stamped siblings are served from the projection.
  const rows = [
    prRow947(1, { merge_requested: 1, merge_human_approval: 0 }), // projected
    prRow936(2), // legacy: no projection columns
  ];
  const engine = countingEngine([
    v("PI-2", "autoMerge", false),
    v("PI-2", "convergeOnly", true),
    v("PI-2", "humanApproval", true),
  ]);
  const res = (await handler(input(), { ...memApp(rows), engine } as AppApi)) as any;
  assertEquals(res.status, 200);
  assertEquals(
    engine.queries.length,
    3,
    "the legacy fallback stays the constant 3 name-filtered reads — never a per-row fan-out",
  );
  const byKey = (k: string) => res.body.prs.find((p: any) => p.prKey === k).merge;
  assertEquals(byKey("o/r#1"), { requested: true, enabled: true, effective: true, blockedBy: null, stale: false });
  assertEquals(byKey("o/r#2"), { requested: false, enabled: true, effective: false, blockedBy: null, stale: false });
});

test("issue #947: a legacy row whose engine read fails degrades to the default, flagged stale", async () => {
  // The timing guard's stale marker: when the policy cannot be verified (engine unreachable for a
  // legacy row), the row is served immediately from the historical default and flagged `stale`
  // rather than blocking the serve.
  const failing = {
    searchVariables: async () => {
      throw new Error("engine unreachable");
    },
  } as any;
  const res = (await handler(input(), { ...memApp([prRow936(1)]), engine: failing } as AppApi)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.prs[0].merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: true });
});

// ── PR #950 review: the legacy fallback is BOUNDED and SELF-HEALING ───────────────────────────────
test("PR #950 review: truncated pages bound legacy per-instance probes, regardless of legacy row count", async () => {
  const { MAX_PROBED_LEGACY_INSTANCES } = await import("../app/service.ts");
  const N = 20; // an upgraded install: every row unstamped
  const rows = Array.from({ length: N }, (_, i) => prRow936(i + 1));
  // Every engine-wide page is truncated to nothing, so every legacy instance would need probes.
  const queries: any[] = [];
  const engine = {
    searchVariables: async (q: any) => {
      queries.push(q);
      if (q.processInstanceKey == null) return [];
      return [v(q.processInstanceKey, q.name, q.name === "autoMerge")];
    },
  } as any;
  const res = (await handler(input(), { ...memApp(rows), engine } as AppApi)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.count, N);
  assert(
    queries.length <= 3 + 3 * MAX_PROBED_LEGACY_INSTANCES,
    `engine calls stay bounded (got ${queries.length} for ${N} legacy rows)`,
  );
  const stale = res.body.prs.filter((p: any) => p.merge.stale).length;
  assertEquals(stale, N - MAX_PROBED_LEGACY_INSTANCES, "unprobed rows degrade to the stale default for this serve");
});

test("PR #950 review: a legacy row whose policy the engine proved is hydrated onto the projection", async () => {
  const rows: any[] = [prRow936(1), prRow936(2)];
  const engine = countingEngine([
    v("PI-1", "autoMerge", false),
    v("PI-1", "convergeOnly", true),
    v("PI-1", "humanApproval", false),
    v("PI-2", "autoMerge", true), // humanApproval PROVEN absent by its root probe (pre-humanApproval loop)
    v("PI-2", "convergeOnly", false),
  ]);
  const app: any = memApp(rows);
  const writes: unknown[][] = [];
  app.data.open = () => ({
    exec: async (sql: string, params: unknown[]) => {
      assert(/WHERE "pr_key" = \? AND "process_key" = \? AND "merge_requested" IS NULL$/.test(sql), "guarded write-back");
      writes.push(params);
      return { changed: 1 };
    },
  });
  const res = (await handler(input(), { ...app, engine } as AppApi)) as any;
  assertEquals(res.status, 200);
  assertEquals(
    [...writes].sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
    [
      [0, 0, "o/r#1", "PI-1"],
      [1, 0, "o/r#2", "PI-2"],
    ],
    "complete reads (incl. proven-absent humanApproval) are written back",
  );
});

test("PR #950 review: hydration never overwrites a concurrently stamped approval decision", async () => {
  const rows: any[] = [prRow936(1)];
  const engine = countingEngine([v("PI-1", "autoMerge", true), v("PI-1", "humanApproval", true)]);
  const app: any = memApp(rows);
  const sqls: string[] = [];
  app.data.open = () => ({
    exec: async (sql: string) => {
      sqls.push(sql);
      return { changed: 1 };
    },
  });
  await handler(input(), { ...app, engine } as AppApi);
  assertEquals(sqls.length, 1);
  assert(/"merge_human_approval" = COALESCE\("merge_human_approval", \?\)/.test(sqls[0]), "approval stamp preserved");
});

test("PR #950 review: the bounded probe window rotates so unhydratable leading rows cannot starve later rows", async () => {
  const { MAX_PROBED_LEGACY_INSTANCES } = await import("../app/service.ts");
  const N = MAX_PROBED_LEGACY_INSTANCES * 3;
  const rows = Array.from({ length: N }, (_, i) => prRow936(i + 1));
  const probed = new Set<string>();
  const engine = {
    searchVariables: async (q: any) => {
      if (q.processInstanceKey == null) return [];
      probed.add(q.processInstanceKey);
      return []; // nothing provable -> never hydrated, stays in the queue
    },
  } as any;
  for (let i = 0; i < 3; i++) await handler(input(), { ...memApp(rows), engine } as AppApi);
  assertEquals(probed.size, N, "every legacy row is eventually probed");
});
