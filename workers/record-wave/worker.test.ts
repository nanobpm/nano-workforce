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
  // Retry keeps the projection on the same (still-pending) wave.
  assertEquals((planUpdates[0].patch as Record<string, unknown>).current_wave, 1);
  // Domain-phase projection (#261): more waves remain, so the epic stays Implementing (wave n/t).
  assertEquals((planUpdates[0].patch as Record<string, unknown>).epic_phase, "Implementing (wave 2/2)");
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

  // Final wave (2 of 3): no successor wave — gate cleared, projection pinned to N-1 so the
  // epics-index reads 3/3 rather than the one-past-the-end nextWave (3).
  assertEquals((planUpdates[0].patch as Record<string, unknown>).gate_wave, null);
  assertEquals((planUpdates[0].patch as Record<string, unknown>).current_wave, 2);
  assertEquals((planUpdates[0].patch as Record<string, unknown>).wave_label, "3/3");
  // Domain-phase projection (#261): the final wave landed with no successor and no trial merge, so
  // the epic enters Finalizing (record-results then advances to the Dispatched terminal).
  assertEquals((planUpdates[0].patch as Record<string, unknown>).epic_phase, "Finalizing");
});

test("record-wave keeps all wave-progress fields NULL for a taskless plan (waveCount 0)", async () => {
  // A taskless plan runs record-wave with waveCount 0 (the MI `implement` step completed
  // immediately). All three progress fields must stay NULL together — never current_wave=0 against
  // a NULL wave_label, which would clobber record-plan/select-wave's NULL projection.
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
  assertEquals(patch.current_wave, null);
  assertEquals(patch.wave_label, null);
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
// agent demonstrably opened so the work is recoverable from the UI, and (3) synthesise a reason so the
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
  // … but the PR the agent opened is retained on the row (recoverable from the UI) …
  assertEquals(row.pr_key, "owner/repo#84");
  // … and the reason is no longer blank.
  assertEquals(typeof row.summary, "string");
  assertEquals((row.summary as string).length > 0, true);
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
