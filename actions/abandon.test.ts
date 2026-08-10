// Tests for the GET /hooks/abandon endpoint (issue #76).
import { assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import handler from "./abandon.ts";

// deno-lint-ignore no-explicit-any
function memApp(): { app: AppApi } {
  // deno-lint-ignore no-explicit-any
  const stores: Record<string, any[]> = {};
  function tbl(name: string) {
    // deno-lint-ignore no-explicit-any
    const rows = (stores[name] ??= [] as any[]);
    return {
      // deno-lint-ignore no-explicit-any require-await
      async insert(row: any) {
        rows.push({ ...row });
        return row.pr_key;
      },
      // deno-lint-ignore no-explicit-any require-await
      async findOne(where: any = {}) {
        return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
    };
  }
  // deno-lint-ignore no-explicit-any
  const app = { data: { table: (n: string) => tbl(n) } } as any as AppApi;
  return { app };
}

function req(method: string, query: Record<string, string>) {
  return {
    method,
    path: "/hooks/abandon",
    query: new URLSearchParams(query),
    headers: new Headers(),
    text: async () => "",
  };
}

async function call(app: AppApi, method: string, query: Record<string, string>) {
  // deno-lint-ignore no-explicit-any
  const res = await handler({ req: req(method, query) as any, body: undefined }, app);
  // deno-lint-ignore no-explicit-any
  return res as any;
}

async function seedPr(app: AppApi, prKey: string, token: string, status: string) {
  await app.data.table("pull_requests", "pr_key").insert({ pr_key: prKey, abandon_token: token, status });
}

Deno.test("missing token → 400", async () => {
  const { app } = memApp();
  assertEquals((await call(app, "GET", {})).status, 400);
});

Deno.test("unknown token → 404 (does not reveal PRs)", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "good", "converging");
  assertEquals((await call(app, "GET", { token: "bad" })).status, 404);
});

Deno.test("a running PR → { abandoned: false }", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "tok", "converging");
  const res = await call(app, "GET", { token: "tok" });
  assertEquals(res.status, 200);
  assertEquals(res.body, { prKey: "o/r#1", status: "converging", abandoned: false });
});

Deno.test("a cancelled PR → { abandoned: true }", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "tok", "abandoned");
  const res = await call(app, "GET", { token: "tok" });
  assertEquals(res.status, 200);
  assertEquals(res.body.abandoned, true);
});

Deno.test("token via header is accepted", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "tok", "abandoned");
  const r = req("GET", {});
  r.headers.set("x-abandon-token", "tok");
  // deno-lint-ignore no-explicit-any
  const res = await handler({ req: r as any, body: undefined }, app) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.abandoned, true);
});

Deno.test("non-GET → 405", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "tok", "converging");
  assertEquals((await call(app, "POST", { token: "tok" })).status, 405);
});
