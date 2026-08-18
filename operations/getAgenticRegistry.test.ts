// Tests for GET /app/api/agentic/registry → operation `getAgenticRegistry` (epic #152 / N1 #145).
//
// The report's computation is exercised exhaustively over injected demand/supply in
// `app/agentic/vocab/demand-report.test.ts`. Here we assert the operation returns a 200 with a
// well-formed report shape. The demand read degrades gracefully (no engine → supply-only), so the
// assertions tolerate `demandUnavailable` being either true or false — no live-engine dependency.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./getAgenticRegistry.ts";

const app = { log: noopLog() } as unknown as AppApi;

function input(headers: Record<string, string> = {}) {
  return {
    req: { method: "GET", path: "/app/api/agentic/registry", query: new URLSearchParams(), headers: new Headers(headers), text: async () => "" } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

test("returns 200 with a well-formed demand×supply report", async () => {
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assert(typeof res.body.version === "number");
  assert(["green", "amber", "red"].includes(res.body.status));
  assert(Array.isArray(res.body.networks));
  assert(Array.isArray(res.body.missing));
  assert(Array.isArray(res.body.nonAgentic));
  assert(typeof res.body.demandUnavailable === "boolean");
  assert(["green", "amber", "red"].includes(res.body.diversity.status));
});
