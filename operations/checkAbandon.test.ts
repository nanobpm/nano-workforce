// Tests for the GET /app/api/hooks/abandon operation `checkAbandon` (ADR 0059; issue #76).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import handler from "./checkAbandon.ts";

function memApp(): { app: AppApi } {
  const stores: Record<string, any[]> = {};
  function tbl(name: string) {
    const rows = (stores[name] ??= [] as any[]);
    return {
      async insert(row: any) {
        rows.push({ ...row });
        return row.pr_key;
      },
      async findOne(where: any = {}) {
        return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
    };
  }
  const app = { data: { table: (n: string) => tbl(n) } } as any as AppApi;
  return { app };
}

function req(method: string, query: Record<string, string>) {
  return {
    method,
    path: "/app/api/hooks/abandon",
    query: new URLSearchParams(query),
    headers: new Headers(),
    text: async () => "",
  };
}

async function call(app: AppApi, method: string, query: Record<string, string>) {
  const res = await handler({ req: req(method, query) as any, params: {}, query: {}, body: undefined }, app);
  return res as any;
}

async function seedPr(app: AppApi, prKey: string, token: string, status: string) {
  await app.data.table("pull_requests", "pr_key").insert({ pr_key: prKey, abandon_token: token, status });
}

test("missing token → 400", async () => {
  const { app } = memApp();
  assertEquals((await call(app, "GET", {})).status, 400);
});

test("unknown token → 404 (does not reveal PRs)", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "good", "converging");
  assertEquals((await call(app, "GET", { token: "bad" })).status, 404);
});

test("a running PR → { abandoned: false }", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "tok", "converging");
  const res = await call(app, "GET", { token: "tok" });
  assertEquals(res.status, 200);
  assertEquals(res.body, { prKey: "o/r#1", status: "converging", abandoned: false });
});

test("a cancelled PR → { abandoned: true }", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "tok", "abandoned");
  const res = await call(app, "GET", { token: "tok" });
  assertEquals(res.status, 200);
  assertEquals(res.body.abandoned, true);
});

test("token via header is accepted", async () => {
  const { app } = memApp();
  await seedPr(app, "o/r#1", "tok", "abandoned");
  const r = req("GET", {});
  r.headers.set("x-abandon-token", "tok");
  const res = await handler({ req: r as any, params: {}, query: {}, body: undefined }, app) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.abandoned, true);
});
