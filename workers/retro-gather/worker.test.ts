import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import { appendEntry } from "../../app/blackboard.ts";
import handler from "./worker.ts";

// deno-lint-ignore no-explicit-any
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  // deno-lint-ignore no-explicit-any
  const stores: Record<string, any[]> = {};
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
      async update() {},
    };
  }
  // deno-lint-ignore no-explicit-any
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

Deno.test("retro-gather: emits a digest brief + learning count for the plan", async () => {
  const { data, stores } = memData();
  stores["plans"] = [{ plan_key: "o/r#3", repo: "o/r", issue_url: "https://x/3", title: "Epic" }];
  await appendEntry(data, "o/r#3", { author_task: "t1", kind: "learning", body: "regen before build" });
  await appendEntry(data, "o/r#3", { author_task: "t2", kind: "learning", body: "use nextest" });

  const app = { data, log: () => undefined };
  const out = await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#3" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.retroLearnings, 2);
  assertStringIncludes(String(out.retroDigest), "regen before build");
  assertStringIncludes(String(out.retroDigest), "use nextest");
  assertStringIncludes(String(out.retroDigest), "o/r#3");
});

Deno.test("retro-gather: an epic with no learnings still renders a valid brief", async () => {
  const { data, stores } = memData();
  stores["plans"] = [{ plan_key: "o/r#4", repo: "o/r", issue_url: "", title: null }];
  const app = { data, log: () => undefined };
  const out = await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "o/r#4" } } as any,
    // deno-lint-ignore no-explicit-any
    app as any,
  ) as Record<string, unknown>;

  assertEquals(out.retroLearnings, 0);
  assert(typeof out.retroDigest === "string");
  assertStringIncludes(String(out.retroDigest), "none");
});
