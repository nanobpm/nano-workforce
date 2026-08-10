// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// biome-ignore-all assist/source/organizeImports: tests keep imports grouped by fixture role.
import { assertEquals } from "jsr:@std/assert@1";
import handler from "./worker.ts";

function fakeApp() {
  // deno-lint-ignore no-explicit-any
  const stores: Record<string, any[]> = { plan_retros: [] };
  const seq: Record<string, number> = {};
  function tbl(name: string, pk = "id") {
    // deno-lint-ignore no-explicit-any
    const rows = (stores[name] ??= [] as any[]);
    // deno-lint-ignore no-explicit-any
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      // deno-lint-ignore no-explicit-any require-await
      async insert(row: any) {
        const id = (seq[name] = (seq[name] ?? 0) + 1);
        rows.push(pk === "id" ? { id, ...row } : { ...row });
        return pk === "id" ? id : row[pk];
      },
      // deno-lint-ignore no-explicit-any require-await
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      // deno-lint-ignore no-explicit-any require-await
      async findOne(where: any = {}) {
        return rows.find((r) => match(r, where));
      },
      // deno-lint-ignore no-explicit-any require-await
      async get(id: any) {
        return rows.find((row) => row[pk] === id);
      },
      // deno-lint-ignore no-explicit-any require-await
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  const app = { data: { table: (n: string, pk?: string) => tbl(n, pk) }, log: () => undefined };
  return { app, stores };
}

Deno.test("retro-record: persists a filed retro from hoisted result vars", async () => {
  const { app, stores } = fakeApp();
  await handler(
    // deno-lint-ignore no-explicit-any
    {
      variables: {
        planKey: "o/r#5",
        retroLearnings: 4,
        status: "filed",
        pr: "o/r#42",
        summary: "promoted 2 lessons",
        "io.nanobpm.agentResult": { output: "the full report" },
      },
    } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  );

  assertEquals(stores.plan_retros.length, 1);
  const row = stores.plan_retros[0];
  assertEquals(row.status, "filed");
  assertEquals(row.pr_key, "o/r#42");
  assertEquals(row.learnings, 4);
  assertEquals(row.summary, "promoted 2 lessons");
  assertEquals(row.report, "the full report");
});

Deno.test("retro-record: defaults to skipped when the agent filed no PR", async () => {
  const { app, stores } = fakeApp();
  await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#6", summary: "nothing durable" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  );
  assertEquals(stores.plan_retros[0].status, "skipped");
  assertEquals(stores.plan_retros[0].pr_key, null);
});

Deno.test("retro-record: honours an explicit blocked status", async () => {
  const { app, stores } = fakeApp();
  await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#7", status: "blocked", summary: "no write access" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  );
  assertEquals(stores.plan_retros[0].status, "blocked");
});

Deno.test("retro-record: ignores a PR unless the status is filed", async () => {
  const { app, stores } = fakeApp();
  await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#8", status: "skipped", pr: "o/r#43", summary: "not durable" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  );
  assertEquals(stores.plan_retros[0].status, "skipped");
  assertEquals(stores.plan_retros[0].pr_key, null);
});

Deno.test("retro-record: defaults invalid status from PR presence", async () => {
  const { app, stores } = fakeApp();
  await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#9", status: "done", pr: "o/r#44" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  );
  assertEquals(stores.plan_retros[0].status, "filed");
  assertEquals(stores.plan_retros[0].pr_key, "o/r#44");
});

Deno.test("retro-record: coerces filed without a PR to skipped", async () => {
  const { app, stores } = fakeApp();
  await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#10", status: "filed", summary: "forgot the PR" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  );
  assertEquals(stores.plan_retros[0].status, "skipped");
  assertEquals(stores.plan_retros[0].pr_key, null);
});
