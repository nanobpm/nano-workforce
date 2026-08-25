// Red/green regression for retrying a wave when `select-wave` deliberately left pending work
// behind a non-fatal wait (D7 / issue #63). Advancing past that wave would make `record-results`
// finish the plan with a still-pending task.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";
import type { PlanTaskStatus } from "../../app/plan.ts";
import { _clearMergeProtocolCache } from "../../app/mergeProtocol.ts";

interface Row {
  id: number;
  plan_key: string;
  task_id: string;
  status: PlanTaskStatus;
  wave?: number | null;
}

function fakeApp(rows: Row[]) {
  const planUpdates: Record<string, unknown>[] = [];
  const stores: Record<string, Record<string, unknown>[]> = {
    plan_tasks: rows as unknown as Record<string, unknown>[],
    plan_task_deps: [],
    pull_requests: [],
    pr_dependencies: [],
    escalations: [],
    plans: [],
    plan_task_deltas: [],
    plan_merge_exclusions: [],
  };
  return {
    app: {
      data: {
        table(name: string, key: string) {
          const store = stores[name] ??= [];
          return {
            get: (k: any) =>
              Promise.resolve(store.find((r) => ((r as unknown) as Record<string, unknown>)[key] === k)),
            find: (q: any) =>
              Promise.resolve(
                store.filter((r) =>
                  Object.entries(q).every(([f, v]) =>
                    ((r as unknown) as Record<string, unknown>)[f] === v
                  )
                ),
              ),
            insert: (row: any) => {
              store.push(row);
              return Promise.resolve(store.length);
            },
            update: (k: any, patch: any) => {
              if (name === "plans") {
                planUpdates.push({ key: k, patch });
                return Promise.resolve(undefined);
              }
              const row = store.find((r) =>
                ((r as unknown) as Record<string, unknown>)[key] === k
              );
              if (row) Object.assign(row, patch);
              return Promise.resolve(row);
            },
          };
        },
      },
      log: noopLog(),
      engine: {
        createInstance: () => Promise.resolve({ processInstanceKey: "pi" }),
      },
    } as any,
    planUpdates,
  };
}

function installGithubStub(method: "gh-merge" | "mergify-queue") {
  _clearMergeProtocolCache();
  const oldTransport = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const oldToken = process.env["GITHUB_TOKEN"];
  const oldFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "test-token";
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/contents/AGENTS.md")) {
      if (method === "mergify-queue") {
        return Promise.resolve(new Response('```merge-protocol\n{ "land": { "method": "mergify-queue" } }\n```'));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (url.includes("/contents/.github/merge-protocol.json")) {
      return Promise.resolve(new Response(JSON.stringify({ land: { method } })));
    }
    const pr = url.match(/\/pulls\/(\d+)/)?.[1] ?? "0";
    if (url.includes("/files")) return Promise.resolve(new Response("[]"));
    if (url.includes("/pulls/")) {
      return Promise.resolve(new Response(JSON.stringify({
        title: `PR ${pr}`,
        body: "",
        head: { ref: `feature-${pr}`, sha: `sha-${pr}` },
      })));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return () => {
    if (oldTransport == null) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = oldTransport;
    if (oldToken == null) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = oldToken;
    globalThis.fetch = oldFetch;
    _clearMergeProtocolCache();
  };
}

test("record-wave retries the same wave when a task is still pending", async () => {
  const rows: Row[] = [{
    id: 2,
    plan_key: "owner/repo#63",
    task_id: "b",
    status: "pending",
    wave: 1,
  }];
  const { app, planUpdates } = fakeApp(rows);

  const out = await handler(
    {
      variables: {
        planKey: "owner/repo#63",
        currentWave: 1,
        waveCount: 2,
        waveTasks: [],
        waveResults: [],
      },
    } as any,
    app,
  ) as Record<string, unknown>;

  assertEquals(out, {
    currentWave: 1,
    hasMoreWaves: true,
    waveOpenHeads: [],
    runTrialMerge: false,
    trialMergeWave: 1,
    trialMergeSkipReason: "wave-still-pending",
  });
  assertEquals((planUpdates[0].patch as Record<string, unknown>).gate_wave, 1);
  // Wave progress (current_wave/wave_label) was retired as a stored projection (epic #412) — derived
  // from `plan_tasks` by the plan_wave_label VIEW — so record-wave no longer writes it.
  assertEquals("current_wave" in (planUpdates[0].patch as Record<string, unknown>), false);
  // Domain-phase projection is no longer stamped by this worker (S8, #542) — the epic phase is a pure
  // read-model derivation off the live element-instance model (`pollEpicPhase`, app/service.ts).
  assertEquals("epic_phase" in (planUpdates[0].patch as Record<string, unknown>), false);
});

test("record-wave pins current_wave to the last index and clears gate_wave on the final wave", async () => {
  const rows: Row[] = [{
    id: 9,
    plan_key: "owner/repo#63",
    task_id: "z",
    status: "opened",
    wave: 2,
  }];
  const { app, planUpdates } = fakeApp(rows);

  await handler(
    {
      variables: {
        planKey: "owner/repo#63",
        currentWave: 2,
        waveCount: 3,
        waveTasks: [],
        waveResults: [],
      },
    } as any,
    app,
  );

  // Final wave (2 of 3): no successor wave — gate cleared. Wave progress (current_wave/wave_label)
  // is no longer a stored column (epic #412; derived from `plan_tasks` by the plan_wave_label VIEW),
  // so record-wave writes neither.
  assertEquals((planUpdates[0].patch as Record<string, unknown>).gate_wave, null);
  assertEquals("current_wave" in (planUpdates[0].patch as Record<string, unknown>), false);
  assertEquals("wave_label" in (planUpdates[0].patch as Record<string, unknown>), false);
  // Domain-phase projection is no longer stamped by this worker (S8, #542) — the epic phase is a pure
  // read-model derivation off the live element-instance model (`pollEpicPhase`, app/service.ts).
  assertEquals("epic_phase" in (planUpdates[0].patch as Record<string, unknown>), false);
});

test("record-wave writes no wave-progress columns for a taskless plan (waveCount 0)", async () => {
  // A taskless plan runs record-wave with waveCount 0 (the MI `implement` step completed
  // immediately). Wave progress was retired as a stored projection (epic #412), so record-wave never
  // writes current_wave/wave_label regardless.
  const { app, planUpdates } = fakeApp([]);

  await handler(
    {
      variables: {
        planKey: "owner/repo#70",
        currentWave: 0,
        waveCount: 0,
        waveTasks: [],
        waveResults: [],
      },
    } as any,
    app,
  );

  const patch = planUpdates[0].patch as Record<string, unknown>;
  assertEquals("current_wave" in patch, false);
  assertEquals("wave_label" in patch, false);
});

test("record-wave skips trial merge for mergify-queue repos with 2+ heads", async () => {
  const restore = installGithubStub("mergify-queue");
  try {
    const rows: Row[] = [
      { id: 1, plan_key: "owner/repo#69", task_id: "a", status: "pending", wave: 0 },
      { id: 2, plan_key: "owner/repo#69", task_id: "b", status: "pending", wave: 0 },
    ];
    const { app } = fakeApp(rows);
    const out = await handler(
      {
        variables: {
          planKey: "owner/repo#69",
          currentWave: 0,
          waveCount: 1,
          waveTasks: [{ id: "a" }, { id: "b" }],
          waveResults: [
            { status: "opened", pr: "owner/repo#1" },
            { status: "opened", pr: "owner/repo#2" },
          ],
        },
      } as any,
      app,
    ) as Record<string, unknown>;

    assertEquals(out.runTrialMerge, false);
    assertEquals(out.trialMergeSkipReason, "mergify-queue");
    assertEquals(out.waveOpenHeads, [
      { repo: "owner/repo", prNumber: 1, headRef: "feature-1", headSha: "sha-1" },
      { repo: "owner/repo", prNumber: 2, headRef: "feature-2", headSha: "sha-2" },
    ]);
  } finally {
    restore();
  }
});

test("record-wave runs trial merge for non-queue repos with populated heads", async () => {
  const restore = installGithubStub("gh-merge");
  try {
    const rows: Row[] = [
      { id: 1, plan_key: "owner/repo#69", task_id: "a", status: "pending", wave: 0 },
      { id: 2, plan_key: "owner/repo#69", task_id: "b", status: "pending", wave: 0 },
    ];
    const { app } = fakeApp(rows);
    const out = await handler(
      {
        variables: {
          planKey: "owner/repo#69",
          currentWave: 0,
          waveCount: 1,
          waveTasks: [{ id: "a" }, { id: "b" }],
          waveResults: [
            { status: "opened", pr: "owner/repo#1" },
            { status: "opened", pr: "owner/repo#2" },
          ],
        },
      } as any,
      app,
    ) as Record<string, unknown>;

    assertEquals(out.runTrialMerge, true);
    assertEquals(out.trialMergeSkipReason, undefined);
    assertEquals(out.waveOpenHeads, [
      { repo: "owner/repo", prNumber: 1, headRef: "feature-1", headSha: "sha-1" },
      { repo: "owner/repo", prNumber: 2, headRef: "feature-2", headSha: "sha-2" },
    ]);
  } finally {
    restore();
  }
});

// ── Fail-closed forensics (issue #360) ─────────────────────────────────────────────────────────────
// A slice that returns no machine-readable result is still coerced to terminal `blocked` here (the
// escalation/answer decision already happened in the `implement` subprocess, before this aggregator).
// But the aggregator must no longer LOSE information when it fails closed: it must (2) retain any PR the
// agent demonstrably opened so the work is recoverable from the UI (on `draft_pr_key`, NOT `pr_key` —
// a non-handed-off key on `pr_key` would wedge the delivery rollup), and (3) synthesise a reason so the
// epic-detail Summary is never blank. Before #360 both were dropped (`pr_key = NULL`, `summary = NULL`).
test("record-wave retains the PR and synthesises a summary for a no-result slice (issue #360)", async () => {
  const rows: Row[] = [{ id: 1, plan_key: "owner/repo#64", task_id: "scaffold", status: "pending", wave: 0 }];
  const { app } = fakeApp(rows);

  await handler(
    {
      variables: {
        planKey: "owner/repo#64",
        currentWave: 0,
        waveCount: 1,
        waveTasks: [{ id: "scaffold" }],
        // No `status` — the agent finished without a machine-readable result — but it DID open a PR.
        waveResults: [{ pr: "owner/repo#84" }],
      },
    } as any,
    app,
  );

  const row = rows[0] as unknown as Record<string, unknown>;
  // Still fail-closed to `blocked` (we never assume the un-reported PR is mergeable) …
  assertEquals(row.status, "blocked");
  // … the PR the agent opened is retained on the DRAFT ref (recoverable from the UI as "Draft PR") …
  assertEquals(row.draft_pr_key, "owner/repo#84");
  // … but NOT on `pr_key`: a non-handed-off key there would read as a handed-off slice PR in
  // `pollDelivery`/promotion rollups (MISSING → in-flight), wedging the epic "converging" forever.
  assertEquals(row.pr_key ?? null, null);
  // … and the reason is no longer blank.
  assertEquals(typeof row.summary, "string");
  assertEquals((row.summary as string).length > 0, true);
});

// A slice that DID return a machine-readable status which simply isn't a clean terminal (e.g. an
// `escalated` slice the operator abandoned, or an SLA auto-abandon — the `implement` subprocess ends
// without rewriting `status`) must not be misreported as "returned no machine-readable result": it did.
test("record-wave synthesises an accurate reason for an escalated-then-abandoned slice, not the no-result reason (Copilot advisory, #360)", async () => {
  const rows: Row[] = [{ id: 1, plan_key: "owner/repo#64", task_id: "scaffold", status: "pending", wave: 0 }];
  const { app } = fakeApp(rows);

  await handler(
    {
      variables: {
        planKey: "owner/repo#64",
        currentWave: 0,
        waveCount: 1,
        waveTasks: [{ id: "scaffold" }],
        // The slice escalated; the operator abandoned it, so the subprocess ended with status "escalated".
        waveResults: [{ status: "escalated" }],
      },
    } as any,
    app,
  );

  const row = rows[0] as unknown as Record<string, unknown>;
  assertEquals(row.status, "blocked");
  const summary = row.summary as string;
  assertEquals(typeof summary, "string");
  // Must NOT claim a slice that returned a machine-readable status returned none …
  assertEquals(summary.includes("no machine-readable result"), false);
  // … and must name the status it actually reported.
  assertEquals(summary.includes("escalated"), true);
});

// The twin invariant of the retention fix: a genuinely HANDED-OFF (`opened` with a usable key) slice
// must still persist its PR on `pr_key` (the delivery-bearing column `pollDelivery`/promotion join on)
// and NOT on the draft ref — otherwise a landed slice would never count toward epic delivery.
test("record-wave persists a handed-off opened slice's PR on pr_key, not draft_pr_key (issue #360)", async () => {
  const restore = installGithubStub("gh-merge");
  try {
    const rows: Row[] = [{ id: 1, plan_key: "owner/repo#64", task_id: "scaffold", status: "pending", wave: 0 }];
    const { app } = fakeApp(rows);

    await handler(
      {
        variables: {
          planKey: "owner/repo#64",
          currentWave: 0,
          waveCount: 1,
          waveTasks: [{ id: "scaffold" }],
          waveResults: [{ status: "opened", pr: "owner/repo#84" }],
        },
      } as any,
      app,
    );

    const row = rows[0] as unknown as Record<string, unknown>;
    assertEquals(row.status, "opened");
    assertEquals(row.pr_key, "owner/repo#84");
    assertEquals(row.draft_pr_key ?? null, null);
  } finally {
    restore();
  }
});

test("record-wave preserves the agent's own summary rather than overwriting it (issue #360)", async () => {
  const rows: Row[] = [{ id: 1, plan_key: "owner/repo#64", task_id: "scaffold", status: "pending", wave: 0 }];
  const { app } = fakeApp(rows);

  await handler(
    {
      variables: {
        planKey: "owner/repo#64",
        currentWave: 0,
        waveCount: 1,
        waveTasks: [{ id: "scaffold" }],
        waveResults: [{ status: "blocked", summary: "upstream API not ready" }],
      },
    } as any,
    app,
  );

  const row = rows[0] as unknown as Record<string, unknown>;
  assertEquals(row.status, "blocked");
  // A genuine, machine-readable `blocked` with its own summary is left untouched — no synthesis.
  assertEquals(row.summary, "upstream API not ready");
});

// The D2 conflict-scan (issue #58) is a deliberate over-approximation of the merge-exclusion graph:
// a slice whose PR is retained (as a work-preserving DRAFT, NOT handed off) can still touch files a
// sibling's PR touches, so omitting it would silently under-approximate the exclusions. The no-result
// path (#360) newly retains such a draft PR (`retainedPr` → `draft_pr_key`), so it MUST be scanned too —
// exactly like an `escalated` draft already is. This locks the scan set to every retained draft, not
// only `opened`/`escalated` ones (Copilot advisory, record-wave/worker.ts:126).
test("record-wave includes a no-result slice's retained draft PR in the D2 conflict scan (Copilot advisory, #360)", async () => {
  const oldToken = process.env["GITHUB_TOKEN"];
  const oldTransport = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const oldFetch = globalThis.fetch;
  process.env["GITHUB_TOKEN"] = "test-token";
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    // Both the handed-off `opened` PR and the retained no-result draft touch the SAME file, so the
    // scan must derive exactly one exclusion edge between them — but only if BOTH are scanned.
    if (url.includes("/files")) {
      return Promise.resolve(new Response(JSON.stringify([{ filename: "src/shared.ts" }])));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  try {
    const rows: Row[] = [
      { id: 1, plan_key: "owner/repo#64", task_id: "a", status: "pending", wave: 0 },
      { id: 2, plan_key: "owner/repo#64", task_id: "b", status: "pending", wave: 0 },
    ];
    const { app } = fakeApp(rows);
    const stores = (app.data as any).table("plan_merge_exclusions", "id");

    await handler(
      {
        variables: {
          planKey: "owner/repo#64",
          currentWave: 0,
          waveCount: 1,
          waveTasks: [{ id: "a" }, { id: "b" }],
          // `a` handed off an opened PR; `b` returned NO machine-readable status but DID open a PR
          // (retained as a draft). Both touch src/shared.ts, so they merge-exclude each other.
          waveResults: [
            { status: "opened", pr: "owner/repo#101" },
            { pr: "owner/repo#102" },
          ],
        },
      } as any,
      app,
    );

    const edges = await stores.find({});
    assertEquals(edges.length, 1, "the no-result draft PR must be scanned, yielding one exclusion edge");
  } finally {
    if (oldToken == null) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = oldToken;
    if (oldTransport == null) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = oldTransport;
    globalThis.fetch = oldFetch;
  }
});
