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
