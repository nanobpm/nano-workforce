// Structure guard for the collapsed Tasks page (issue #461). The Tasks page is ONE `user_tasks`
// dataGrid (`filter: []`, `orderBy updated_at desc`) with `kind_label` as a "Type" column, completing
// each row via its ENGINE-declared form (nano-ide#457's `detail.engineForm`) — not seven
// `element_id`-allowlisted grids each with a hand-authored `detail.form` that duplicates a deployed
// `.form` resource AND leaves dynamic-id delivery-graph tasks (counted by the `filter: []` badge)
// rendered by no grid. This test pins that end-state so the anti-pattern can't creep back:
//   • exactly one `dataGrid`, over `user_tasks`, unfiltered, recency-ordered → badge ≡ list;
//   • a "Type" column bound to `kind_label`;
//   • an engine-form detail (`form_key` / `user_task_key`), and NO page-local `detail.form`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";

// biome-ignore lint/suspicious/noExplicitAny: reading an untyped page manifest for structural assertions
const page: any = JSON.parse(readFileSync(fileURLToPath(new URL("../pages/tasks.page.json", import.meta.url)), "utf8"));
// biome-ignore lint/suspicious/noExplicitAny: see above
const nodes: any[] = page.nodes ?? [];
// biome-ignore lint/suspicious/noExplicitAny: see above
const grids: any[] = nodes.filter((n) => n.type === "dataGrid");

test("Tasks page is exactly ONE dataGrid over user_tasks (filter [], orderBy updated_at desc)", () => {
  assertEquals(grids.length, 1);
  const [grid] = grids;
  assertEquals(grid.props.data.table, "user_tasks");
  assertEquals(grid.props.data.filter, []);
  assertEquals(grid.props.data.orderBy, { field: "updated_at", dir: "desc" });
});

test("Tasks grid surfaces kind_label as a 'Type' column", () => {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const typeCol = grids[0].props.columns.find((c: any) => c.field === "kind_label");
  assert(typeCol, "a kind_label column must exist");
  assertEquals(typeCol.header, "Type");
});

test("Tasks grid completes each row via its engine-declared form (nano-ide#457), not a page-local detail.form", () => {
  const { detail } = grids[0].props;
  assert(detail?.engineForm, "the grid detail must opt into engineForm rendering");
  assertEquals(detail.engineForm.formKeyField, "form_key");
  assertEquals(detail.engineForm.userTaskKeyField, "user_task_key");
  // The seven bespoke per-type detail.form blocks (each a copy of a deployed `.form`) are gone.
  for (const g of grids) assert(!g.props.detail?.form, "no grid may carry a page-local detail.form");
});
