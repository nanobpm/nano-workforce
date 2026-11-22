// Red/green for the per-request review-only override (`convergeOnly`). `pr.finalize` decides,
// on convergence, whether to hand the PR to the merge-loop (auto-merge) or rest it at `converged`
// (review-only). The global default is `NANO_PR_AUTO_MERGE` (on), but a single submission can pin
// review-only by carrying `convergeOnly: true` on the instance. These drive the worker against an
// in-memory data layer + a capturing engine and assert the hand-off happens iff auto-merge is on
// AND the request did not force convergence-only.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";
import { MERGE_PROCESS_ID } from "../../app/service.ts";

function fakeApp() {
  const stores: Record<string, Record<string, unknown>[]> = {
    pull_requests: [],
    rounds: [],
  };
  const createdProcesses: string[] = [];
  return {
    createdProcesses,
    stores,
    app: {
      data: {
        table(name: string, key: string) {
          const store = (stores[name] ??= []);
          return {
            // biome-ignore lint/plugin: in-memory test double for the data layer
            get: (k: unknown) => Promise.resolve(store.find((r) => r[key] === k)),
            // biome-ignore lint/plugin: in-memory test double for the data layer
            find: (q: Record<string, unknown>) =>
              Promise.resolve(store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
            // biome-ignore lint/plugin: in-memory test double for the data layer
            insert: (row: Record<string, unknown>) => {
              store.push(row);
              return Promise.resolve(store.length);
            },
            // biome-ignore lint/plugin: in-memory test double for the data layer
            update: (k: unknown, patch: Record<string, unknown>) => {
              const row = store.find((r) => r[key] === k);
              if (row) Object.assign(row, patch);
              return Promise.resolve(row);
            },
          };
        },
      },
      engine: {
        createInstance: (req: { processDefinitionId: string }) => {
          createdProcesses.push(req.processDefinitionId);
          return Promise.resolve({ processInstanceKey: "MERGE-1" });
        },
      },
      log: noopLog(),
    },
  };
}

const BASE_VARS = {
  prKey: "owner/repo#5",
  repo: "owner/repo",
  prNumber: 5,
  prUrl: "https://github.com/owner/repo/pull/5",
  round: 2,
  summary: "looks good",
};

// Auto-retro reads plan tables this fixture doesn't populate; disable it so the terminal
// `converged` path doesn't spuriously probe for a retro. The hand-off decision under test is
// independent of retro. Auto-merge is left at its default (on): `AUTO_MERGE` is computed once at
// `app/service.ts` import time and captured by the imported handler, so toggling
// `NANO_PR_AUTO_MERGE` here would be a no-op — only `NANO_AUTO_RETRO` is read dynamically.
function withRetroOff(run: () => Promise<void>): Promise<void> {
  const prevRetro = process.env["NANO_AUTO_RETRO"];
  process.env["NANO_AUTO_RETRO"] = "0";
  return run().finally(() => {
    if (prevRetro == null) delete process.env["NANO_AUTO_RETRO"];
    else process.env["NANO_AUTO_RETRO"] = prevRetro;
  });
}

test("finalize with convergeOnly=true rests the PR at converged and never starts the merge-loop", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS, convergeOnly: true } } as never, app as never);

    // No merge-loop instance started even though auto-merge is on globally …
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), false);
    // … and the PR rests at the review-only terminal status.
    const pr = stores.pull_requests[0];
    assertEquals(pr.status, "converged");
  });
});

test("finalize with convergeOnly absent hands off to the merge-loop when auto-merge is on", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS } } as never, app as never);

    // The default (env-governed) path starts the merge-loop and parks the PR in the merge stage.
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), true);
    const pr = stores.pull_requests[0];
    assertEquals(pr.status, "waiting_deps");
  });
});

// Issue #916: `autoMerge` is the CANONICAL positive merge-intent variable on the convergence loop.
// `pr.finalize` reads it first and falls back to the legacy inverted `convergeOnly` only when
// `autoMerge` is absent — so an in-flight loop seeded before `autoMerge` existed keeps its behaviour.
test("finalize with autoMerge=false rests at converged even when the legacy convergeOnly mirror is absent", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS, autoMerge: false } } as never, app as never);
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), false);
    assertEquals(stores.pull_requests[0].status, "converged");
  });
});

test("finalize with autoMerge=true hands off to the merge-loop (canonical positive variable)", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS, autoMerge: true } } as never, app as never);
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), true);
    assertEquals(stores.pull_requests[0].status, "waiting_deps");
  });
});

test("finalize prefers autoMerge over the legacy convergeOnly mirror when they disagree", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    // A contradictory pair (autoMerge=true, convergeOnly=true) can only arise from a hand-seeded or
    // half-migrated instance: the positive canonical variable wins.
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS, autoMerge: true, convergeOnly: true } } as never, app as never);
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), true);
    assertEquals(stores.pull_requests[0].status, "waiting_deps");
  });
});

// Issue #1007 review round 3: an adoption narrowing (`submitPr` stamping `merge_requested = 0`)
// that lands while a review/fix agent is live is REVERTED in the process variables when that
// agent's completion restores its guard snapshots (convergence-loop.bpmn's guardAutoMerge /
// guardConvergeOnly outputs) — but the durable projection's compare-and-set survives. `pr.finalize`
// must read the projection as the authoritative opt-out so the restored stale `autoMerge: true`
// can never force a merge the operator explicitly pinned off.
test("finalize honours the durable merge_requested=0 projection over a restored stale autoMerge=true (#1007 round 3)", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    // The PR row already exists (submitPr stamped it), narrowed to review-only by adoption.
    stores.pull_requests.push({ pr_key: BASE_VARS.prKey, merge_requested: 0 });
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS, autoMerge: true, convergeOnly: false } } as never, app as never);
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), false, "no merge-loop — the projection's opt-out wins over the restored variable");
    assertEquals(stores.pull_requests[0].status, "converged");
  });
});

// The projection also pins the POSITIVE intent: a row stamped merge_requested=1 merges even if the
// variables were narrowed after the stamp (the loop's own converge-only retry is not undone by a
// later guard restore either — the projection is the single durable intent).
test("finalize honours the durable merge_requested=1 projection over a restored stale autoMerge=false (#1007 round 3)", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    stores.pull_requests.push({ pr_key: BASE_VARS.prKey, merge_requested: 1 });
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS, autoMerge: false, convergeOnly: true } } as never, app as never);
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), true);
    assertEquals(stores.pull_requests[0].status, "waiting_deps");
  });
});

// A legacy row written before the projection existed (`merge_requested` NULL) keeps the
// variable-derived behaviour — the fallback mirrors `mergePolicyFromRow`'s serve path.
test("finalize falls back to the process variables for a legacy row with merge_requested NULL (#1007 round 3)", async () => {
  await withRetroOff(async () => {
    const { app, stores, createdProcesses } = fakeApp();
    stores.pull_requests.push({ pr_key: BASE_VARS.prKey, merge_requested: null });
    // biome-ignore lint/plugin: constructing the framework's job envelope for the handler under test
    await handler({ variables: { ...BASE_VARS, autoMerge: false } } as never, app as never);
    assertEquals(createdProcesses.includes(MERGE_PROCESS_ID), false);
    assertEquals(stores.pull_requests[0].status, "converged");
  });
});
