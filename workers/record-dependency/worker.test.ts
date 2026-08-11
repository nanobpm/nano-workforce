// pr.record-dependency: a merge-stage agent that discovers "this PR must wait for another PR to
// merge first" turns that into a durable dependency wait (parking the PR back in `waiting_deps`)
// instead of a human escalation — the wait, not the escalation, is the correct outcome.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "./worker.ts";

interface DepRow {
  pr_key: string;
  depends_on_key: string;
  created_at: string;
}

function fakeApp(seedDeps: DepRow[] = []) {
  const logs: { level: string; msg: string }[] = [];
  const stores: Record<string, Record<string, unknown>[]> = {
    pr_dependencies: seedDeps as unknown as Record<string, unknown>[],
    pull_requests: [{ pr_key: "o/r#1", status: "waiting_merge" }],
  };
  return {
    app: {
      data: {
        table(name: string, key: string) {
          const store = (stores[name] ??= []);
          return {
            get: (k: unknown) => Promise.resolve(store.find((r) => r[key] === k)),
            find: (q: Record<string, unknown>) =>
              Promise.resolve(
                store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)),
              ),
            insert: (row: Record<string, unknown>) => {
              store.push(row);
              return Promise.resolve(store.length);
            },
            update: (k: unknown, patch: Record<string, unknown>) => {
              const row = store.find((r) => r[key] === k);
              if (row) Object.assign(row, patch);
              return Promise.resolve(row);
            },
            delete: (k: unknown) => {
              for (let i = store.length - 1; i >= 0; i--) if (store[i][key] === k) store.splice(i, 1);
              return Promise.resolve(undefined);
            },
          };
        },
      },
      log: (level: string, msg: string) => logs.push({ level, msg }),
      engine: {},
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double for AppContext
    } as any,
    stores,
    logs,
  };
}

const job = (variables: Record<string, unknown>) => ({ variables }) as never;

test("records a discovered dependency from a string ref and parks the PR in waiting_deps", async () => {
  const { app, stores } = fakeApp();
  await handler(job({ prKey: "o/r#1", dependsOn: "o/r#2" }), app);

  assertEquals(stores.pr_dependencies.length, 1);
  assertEquals(stores.pr_dependencies[0].pr_key, "o/r#1");
  assertEquals(stores.pr_dependencies[0].depends_on_key, "o/r#2");
  assertEquals(stores.pull_requests[0].status, "waiting_deps");
});

test("parses several refs (commas/spaces/URLs), dedupes, and never waits on itself", async () => {
  const { app, stores } = fakeApp();
  await handler(
    job({
      prKey: "o/r#1",
      dependsOn: "o/r#2, o/r#2 https://github.com/o/r/pull/3 o/r#1",
    }),
    app,
  );

  const keys = stores.pr_dependencies.map((d) => d.depends_on_key).sort();
  assertEquals(keys, ["o/r#2", "o/r#3"]); // #2 deduped, self #1 dropped
  assertEquals(stores.pull_requests[0].status, "waiting_deps");
});

test("appends to existing edges without wiping them and skips already-recorded ones", async () => {
  const { app, stores } = fakeApp([
    { pr_key: "o/r#1", depends_on_key: "o/r#9", created_at: "t0" },
  ]);
  await handler(job({ prKey: "o/r#1", dependsOn: ["o/r#9", "o/r#2"] }), app);

  const keys = stores.pr_dependencies.map((d) => d.depends_on_key).sort();
  assertEquals(keys, ["o/r#2", "o/r#9"]); // pre-existing #9 preserved, only #2 added
});

test("no parseable ref still parks in waiting_deps and logs the miswiring loudly", async () => {
  const { app, stores, logs } = fakeApp();
  await handler(job({ prKey: "o/r#1", dependsOn: "not-a-pr" }), app);

  assertEquals(stores.pr_dependencies.length, 0);
  assertEquals(stores.pull_requests[0].status, "waiting_deps");
  assertEquals(logs.some((l) => l.level === "error"), true);
});
