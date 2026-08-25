// Static contract guard between the declarative pages (`pages/*.page.json`) and the app schema
// (`db/migrations/*.sql`).
//
// The Urban page runtime whitelists every datasource `table` and `column` against the LIVE schema
// (`PRAGMA table_info`): a grid that binds to a table or column the migrations never created 400s
// at request time — an invisible, runtime-only failure with no compile or `urban check` signal.
// This test closes that drift surface: every table and column referenced by any page must be
// derivable from the migrations, so a rename/typo/removed column fails CI instead of a live page.
//
// It also pins the issue #87 surfaces: the plan-review audit log (`plan_reviews`) — which is
// persisted but was surfaced on no page — must appear on the epic page (flat grid) and inside the
// home page's plan detail (child grid). Feature coverage so the trace can't silently regress out.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readdirSync, readFileSync } from "node:fs";

// Percent-decode the pathname: `new URL(..).pathname` can contain encoded characters (e.g. a space
// as `%20`), which `Deno.readDir`/`readTextFile` would fail to resolve. Matches the repo convention
// (see scripts/check-agent-prompts.test.ts).
const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);

// ---- migrations -> { table -> Set<column> } -----------------------------------------------------

function parseSchema(sql: string, schema: Map<string, Set<string>>): void {
  // Strip SQL comments first: an inline `-- ...` trailing one column line would otherwise become
  // the leading token of the NEXT comma-split fragment, hiding the real column name.
  sql = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // CREATE TABLE [IF NOT EXISTS] <name> ( <body> )
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const table = m[1];
    const body = balancedBody(sql, createRe.lastIndex - 1); // start at the "("
    if (body === null) continue;
    const cols = schema.get(table) ?? new Set<string>();
    for (const frag of splitTopLevel(body)) {
      const first = frag.trim().split(/[\s(]/)[0];
      if (!first) continue;
      const upper = first.toUpperCase();
      if (["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"].includes(upper)) continue;
      cols.add(first.replace(/["`]/g, ""));
    }
    schema.set(table, cols);
  }
  // ALTER TABLE <name> ADD [COLUMN] <col>
  const alterRe = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?/gi;
  while ((m = alterRe.exec(sql)) !== null) {
    const cols = schema.get(m[1]) ?? new Set<string>();
    cols.add(m[2]);
    schema.set(m[1], cols);
  }
  // CREATE VIEW [IF NOT EXISTS] <name> AS SELECT <select-list> FROM …
  //
  // A page datasource can bind a VIEW as well as a base table (nano-ide#424), so a view's OUTPUT
  // columns must join the whitelist exactly like a table's. A view has no `PRAGMA`-visible column
  // list in this static parse, so we read them off its SELECT projection: take the select-list up
  // to the first top-level `FROM`, split it on top-level commas, and record each item's output name
  // (its `AS <alias>`, or the trailing identifier of a bare `t.col` / `col`). This is why the
  // repo's views (see 059_plan_wave_summary.sql) alias every projected column and avoid select-list
  // subqueries — it keeps this purely-textual contract guard able to see their columns.
  const viewRe = /CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s+AS\s+SELECT\s+/gi;
  while ((m = viewRe.exec(sql)) !== null) {
    const selectList = topLevelSelectList(sql, viewRe.lastIndex);
    if (selectList === null) continue;
    const cols = schema.get(m[1]) ?? new Set<string>();
    for (const frag of splitTopLevel(selectList)) {
      const col = viewColumnName(frag);
      if (col) cols.add(col);
    }
    schema.set(m[1], cols);
  }
}

// The select-list of a view: the text between `SELECT` (its end at `start`) and the first top-level
// `FROM` keyword (one at paren depth 0 — a `FROM` inside a function/subquery doesn't end the list).
function topLevelSelectList(s: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (c === "F" || c === "f")) {
      // whole-word FROM with a non-identifier char (or string start) on each side
      if (/from/i.test(s.slice(i, i + 4)) && !/\w/.test(s[i - 1] ?? " ") && !/\w/.test(s[i + 4] ?? " ")) {
        return s.slice(start, i);
      }
    }
  }
  return null;
}

// The output name of one select-list item: its `AS <alias>` if present, else the trailing
// identifier of a bare `table.column` / `column` reference.
function viewColumnName(frag: string): string | null {
  const trimmed = frag.trim();
  const asMatch = trimmed.match(/\bAS\s+["`]?(\w+)["`]?\s*$/i);
  if (asMatch) return asMatch[1];
  const bare = trimmed.match(/(\w+)\s*$/);
  return bare ? bare[1] : null;
}

// Return the text inside the parentheses whose opener is at `openIdx`, honouring nesting.
function balancedBody(s: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return s.slice(openIdx + 1, i);
    }
  }
  return null;
}

// Split a CREATE TABLE body on top-level commas (commas inside nested parens stay attached).
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

function loadSchema(): Map<string, Set<string>> {
  const schema = new Map<string, Set<string>>();
  const files: string[] = [];
  for (const e of readdirSync(`${ROOT}db/migrations`, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".sql")) files.push(e.name);
  }
  files.sort(); // migration order doesn't matter for the union, but keep it deterministic
  for (const f of files) {
    parseSchema(readFileSync(`${ROOT}db/migrations/${f}`, "utf8"), schema);
  }
  return schema;
}

// ---- pages -> datasource references -------------------------------------------------------------

type Json = any;

interface Ref {
  page: string;
  table: string;
  source: string;
  fields: string[]; // every column that must exist on `table` (displayed columns + binding fields)
  columns: string[]; // only the visibly displayed grid columns (`columns[].field`)
}

// Pull `field` names out of a `filter` array ([{ field, in/eq/... }, ...]).
function filterFields(filter: Json): string[] {
  if (!Array.isArray(filter)) return [];
  return filter.map((f: Json) => f?.field).filter(Boolean);
}

// Pull `{{field}}` interpolation names out of a prose renderer's header template (nano-ide#274).
function templateFields(tpl: Json): string[] {
  if (typeof tpl !== "string") return [];
  return [...tpl.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1].trim()).filter(Boolean);
}

function collectRefs(page: string, node: Json, out: Ref[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(page, v, out);
    return;
  }
  if (!node || typeof node !== "object") return;

  // Top-level datasource grid: the datasource lives at `node.data`, while `columns`, `rowKey`,
  // `filter`/`tabs`, and `detail` are siblings on the same `node` (the grid props). A `prose`
  // renderer (nano-ide#274) binds the same `node.data` but has no `columns`: its displayed content
  // is the header template's `{{field}}` refs plus the single `body` field, so fold those in as
  // "columns" so the field-existence + surface guards below apply to prose sections too.
  const data = node.data;
  if (data && data.kind === "datasource" && typeof data.table === "string") {
    const columns: string[] = [
      ...(node.columns ?? []).map((c: Json) => c.field),
      ...templateFields(node.header),
      ...(typeof node.body === "string" ? [node.body] : []),
    ].filter(Boolean);
    // Every reference that resolves to a column on this table — the runtime 400s on any of them if
    // it names a column the migrations never created, so all must be guarded, not just displayed
    // columns. `detail.fields`/`detail.linkField` render columns of the same top-level row.
    const detail = node.detail ?? {};
    const fields: string[] = [
      ...columns,
      ...(node.columns ?? []).map((c: Json) => c.linkField),
      node.rowKey,
      data.orderBy?.field,
      ...filterFields(data.filter),
      ...(node.tabs ?? []).flatMap((t: Json) => filterFields(t.filter)),
      detail.linkField,
      ...(detail.fields ?? []).flatMap((f: Json) => [f.field, f.linkField]),
      // `detail.children[].parentField` joins each child grid back to a column on THIS (parent)
      // table, so a rename/typo there 400s at request time — guard it against the parent schema.
      ...(detail.children ?? []).map((c: Json) => c.parentField),
    ].filter(Boolean);
    out.push({ page, table: data.table, source: data.source ?? "app", fields, columns });
  }

  // Child grid inside a detail: { table, childField, parentField, orderBy, columns }
  if (typeof node.table === "string" && typeof node.childField === "string") {
    const columns: string[] = (node.columns ?? []).map((c: Json) => c.field).filter(Boolean);
    out.push({
      page,
      table: node.table,
      source: node.source ?? "app",
      fields: [
        ...columns,
        ...(node.columns ?? []).map((c: Json) => c.linkField),
        node.childField,
        node.orderBy?.field,
        node.lazyField?.field,
      ].filter(Boolean),
      columns,
    });
  }

  for (const v of Object.values(node)) collectRefs(page, v, out);
}

function loadRefs(): Ref[] {
  const refs: Ref[] = [];
  for (const e of readdirSync(`${ROOT}pages`, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".page.json")) continue;
    const page = JSON.parse(readFileSync(`${ROOT}pages/${e.name}`, "utf8"));
    collectRefs(e.name, page, refs);
  }
  return refs;
}

// ---- guards -------------------------------------------------------------------------------------

test("every page datasource table exists in the migrations", async () => {
  const schema = await loadSchema();
  const refs = await loadRefs();
  assert(refs.length > 0, "no datasource references found — collector or pages are broken");
  for (const r of refs) {
    // Only the default app SQLite source is schema-backed; other sources aren't migration-defined.
    if (r.source !== "app") continue;
    assert(
      schema.has(r.table),
      `${r.page}: datasource table "${r.table}" has no CREATE TABLE in db/migrations/*.sql`,
    );
  }
});

test("every page datasource column exists on its table", async () => {
  const schema = await loadSchema();
  const refs = await loadRefs();
  for (const r of refs) {
    if (r.source !== "app") continue;
    const cols = schema.get(r.table);
    if (!cols) continue; // table-existence is asserted by the sibling test
    for (const f of r.fields) {
      assert(
        cols.has(f),
        `${r.page}: column "${f}" referenced on table "${r.table}" is not defined by any migration`,
      );
    }
  }
});

test("issue #87: plan_reviews is surfaced on the per-epic detail page", async () => {
  const refs = await loadRefs();
  // The operator-visibility redesign (issue #137) moved per-plan detail grids off the flat
  // epic index onto the param-scoped per-epic page (#/epic-detail/<plan_key>), where the
  // plan-review trace is filtered to a single epic. Assert the trace lives there.
  const onEpicDetail = refs.some(
    (r) => r.page === "epic-detail.page.json" && r.table === "plan_reviews",
  );
  assert(onEpicDetail, "epic-detail.page.json must bind the plan-review trace to plan_reviews");

  // The trace is only useful with the verdict + critique surfaced, so pin them. Assert against the
  // visibly displayed `columns` (not `fields`, which also holds binding refs like orderBy.field) —
  // for the `prose` renderer (nano-ide#274) these are the header template's `{{round}}`/`{{approved}}`
  // refs plus the `findings` body — so a field silently dropped from the UI can't pass by being
  // referenced elsewhere.
  const required = ["round", "approved", "findings"];
  for (const r of refs.filter((x) => x.table === "plan_reviews")) {
    for (const col of required) {
      assert(
        r.columns.includes(col),
        `${r.page}: plan_reviews trace must surface the "${col}" field`,
      );
    }
  }
});

test("issue #205: overview is the landing page and first nav item", async () => {
  const overview = JSON.parse(readFileSync(`${ROOT}pages/overview.page.json`, "utf8"));

  // The overview must be the pages-surface home so it's the default destination.
  const app = JSON.parse(readFileSync(`${ROOT}nano.app.json`, "utf8"));
  assert(
    app?.surfaces?.pages?.homePage === "overview",
    "nano.app.json surfaces.pages.homePage must be \"overview\" (the landing page)",
  );

  // Every page's nav must lead with Overview so it's the first tab everywhere.
  for (const e of readdirSync(`${ROOT}pages`, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".page.json")) continue;
    const page = JSON.parse(readFileSync(`${ROOT}pages/${e.name}`, "utf8"));
    const nav = (page.nodes ?? []).find((n: Json) => n.type === "nav");
    if (!nav) continue;
    const first = nav.props?.items?.[0];
    assert(
      first?.page === "overview" && first?.label === "Overview",
      `${e.name}: nav must lead with the Overview tab (first item page "overview")`,
    );
  }

  // Three collapsible active-work sections, one per dispatch surface, each with a
  // live count in its header (showCount) and a persisted collapse toggle (collapsible). Each filters
  // its Active list on a `{field, in:[...]}` predicate: the PR / feature surfaces on `status`, but the
  // EPIC surface buckets on the DERIVED `list_bucket` (issue #298) — NOT raw `status` — so a `done`
  // epic still converging, or landed-but-unpromoted, does not vanish from the in-flight Epics section
  // the instant `status=done`. Guarding the field here is the regression guard for that defect class.
  // The epic surface binds the derived `plan_read_model` VIEW (epic #412 — the single source of truth
  // for the wave/delivery projections it also renders), not the raw `plans` table.
  const expected: Record<string, { field: string; in: string[] }> = {
    pull_requests: {
      field: "status",
      in: ["converging", "waiting_review", "escalated", "waiting_deps", "waiting_merge", "queued", "merging"],
    },
    plan_read_model: { field: "list_bucket", in: ["active"] },
    feature_runs: { field: "status", in: ["running", "escalated", "awaiting_operator"] },
    // The 4th dispatch surface (issue #386) — active delivery graphs. Both in-flight statuses
    // (`awaiting-approval` parked at the gate, `running` dispatched) show here. Binds the derived
    // `delivery_graph_read_model` VIEW (S7 / #541 — the single source of truth for the pipeline
    // projection it also renders), which re-exports every run column plus the effective `status`.
    delivery_graph_read_model: { field: "status", in: ["awaiting-approval", "running"] },
  };
  const grids = (overview.nodes ?? []).filter((n: Json) => n.type === "dataGrid");
  for (const [table, { field, in: values }] of Object.entries(expected)) {
    const grid = grids.find((g: Json) => g.props?.data?.table === table);
    assert(grid, `overview.page.json must have a section bound to "${table}"`);
    assert(grid.props.collapsible === true, `overview "${table}" section must be collapsible`);
    assert(grid.props.showCount === true, `overview "${table}" section must show a live count`);
    const filter = grid.props?.data?.filter?.find((f: Json) => f.field === field);
    assert(filter, `overview "${table}" section must filter on ${field}`);
    assert(
      JSON.stringify([...filter.in].sort()) === JSON.stringify([...values].sort()),
      `overview "${table}" section must filter ${field} to ${JSON.stringify(values)}`,
    );
  }
});


test("issue #386: the human-facing Delivery Graphs surface is wired (nav tab, page, detail, overview)", async () => {
  // 1) A `Delivery Graphs` nav tab in the single-source nav, pointing at the delivery-graphs page.
  const nav = JSON.parse(readFileSync(`${ROOT}pages/_nav.json`, "utf8"));
  const tab = (nav.props?.items ?? []).find(
    (i: Json) => i.page === "delivery-graphs" && i.label === "Delivery Graphs",
  );
  assert(tab, "pages/_nav.json must carry a `Delivery Graphs` nav tab → the delivery-graphs page");

  // 2) The page carries the compose → preview → dispatch App View (issue #441 — the rendered preview
  //    that consumes the compile output), plus an in-flight grid over the delivery-graph run data (the
  //    derived `delivery_graph_read_model` VIEW, S7 / #541 — which re-exports every `delivery_graph_runs`
  //    column plus the pipeline projection) that links to the per-graph detail page. The rich preview
  //    (mermaid diagram + humanNodes[] + sideEffects[] + inline errors) can't render in a bare
  //    `actionForm` (its response is discarded), so the surface is an `appView` embed over the SAME
  //    compile/dispatch doors.
  const page = JSON.parse(readFileSync(`${ROOT}pages/delivery-graphs.page.json`, "utf8"));
  const compose = (page.nodes ?? []).find(
    (n: Json) => n.type === "appView" && typeof n.props?.embed === "string" && n.props.embed.includes("delivery-graphs/embed.html"),
  );
  assert(compose, "delivery-graphs page must have an appView embedding ./delivery-graphs/embed.html (the compose → preview → dispatch view, #441)");
  const grid = (page.nodes ?? []).find(
    (n: Json) => n.type === "dataGrid" && n.props?.data?.table === "delivery_graph_read_model",
  );
  assert(grid, "delivery-graphs page must have an in-flight grid over the derived delivery_graph_read_model VIEW");
  const linkCol = (grid.props?.columns ?? []).find((c: Json) => c.link?.page === "delivery-graph-detail");
  assert(
    linkCol && linkCol.link?.keyField === "run_key",
    "the in-flight grid must link a column to delivery-graph-detail by run_key",
  );

  // 3) The per-graph detail page reads the run aggregate scoped to the route param (run_key).
  const detail = JSON.parse(readFileSync(`${ROOT}pages/delivery-graph-detail.page.json`, "utf8"));
  const runGrid = (detail.nodes ?? []).find(
    (n: Json) => n.type === "dataGrid" && n.props?.data?.table === "delivery_graph_read_model",
  );
  assert(runGrid, "delivery-graph-detail must bind a grid to the derived delivery_graph_read_model VIEW");
  assert(
    (runGrid.props?.data?.filter ?? []).some((fl: Json) => fl.field === "run_key" && fl.eqParam === true),
    "delivery-graph-detail must scope its run grid to the route param (run_key eqParam)",
  );

  // 4) The Overview no longer claims only three surfaces, and its 4th section links to the detail page.
  const overview = JSON.parse(readFileSync(`${ROOT}pages/overview.page.json`, "utf8"));
  const subtitle = (overview.nodes ?? []).find((n: Json) => n.id === "subtitle");
  assert(
    typeof subtitle?.props?.text === "string" && !subtitle.props.text.includes("three dispatch surfaces"),
    "overview subtitle must no longer say 'three dispatch surfaces' (a delivery graph is a 4th)",
  );
  const ovGrid = (overview.nodes ?? []).find(
    (n: Json) => n.type === "dataGrid" && n.props?.data?.table === "delivery_graph_read_model",
  );
  const ovLink = (ovGrid?.props?.columns ?? []).find((c: Json) => c.link?.page === "delivery-graph-detail");
  assert(
    ovLink && ovLink.link?.keyField === "run_key",
    "overview delivery-graphs section must link its item to delivery-graph-detail by run_key",
  );
});

test("issue #521: the Delivery Graphs History tab surfaces dispatch time + the instance key", async () => {
  // The in-flight grid's History tab (`delivery-graphs-inflight`) is where a completed/failed run is
  // reviewed after the fact. It must surface WHEN the run was dispatched (`created_at`, stamped at
  // dispatch) and its engine instance key (`process_key`) as a first-class, Explorer-linked cell —
  // not just the `updated_at` last-touch. Grid columns are shared across the In-flight/History/All
  // tabs (the renderer has no per-tab column override — tabs carry only `label`+`filter`), so pinning
  // the columns on the grid that owns the History tab is what surfaces them on History.
  const page = JSON.parse(readFileSync(`${ROOT}pages/delivery-graphs.page.json`, "utf8"));
  const grid = (page.nodes ?? []).find(
    (n: Json) => n.type === "dataGrid" && n.id === "delivery-graphs-inflight",
  );
  assert(grid, "delivery-graphs page must have the `delivery-graphs-inflight` grid");

  // The History tab must exist (this is the tab whose columns we are pinning).
  const history = (grid.props?.tabs ?? []).find((t: Json) => t.label === "History");
  assert(history, "the delivery-graphs-inflight grid must have a History tab");

  const columns: Json[] = grid.props?.columns ?? [];

  // Dispatched: the dispatch time, formatted as a datetime, distinct from the `updated_at` "Updated".
  const dispatched = columns.find((c: Json) => c.field === "created_at");
  assert(dispatched, "History tab must expose a `created_at` column (dispatch time)");
  assert(
    dispatched.header === "Dispatched",
    "the `created_at` column must be headed \"Dispatched\"",
  );
  assert(
    dispatched.format === "datetime",
    "the `created_at` (Dispatched) column must be formatted as a datetime",
  );

  // Instance: an explicit cell carrying `process_key`, deep-linked to the Explorer via the same
  // `processExplorer` link kind used by the Status column, keyed on `process_key`.
  const instance = columns.find(
    (c: Json) => c.field === "process_key" && c.link?.kind === "processExplorer",
  );
  assert(
    instance,
    "History tab must expose an explicit Instance cell on `process_key` with a processExplorer link",
  );
  assert(
    instance.header === "Instance",
    "the `process_key` cell must be headed \"Instance\"",
  );
  assert(
    instance.link?.keyField === "process_key",
    "the Instance cell's processExplorer link must key on `process_key`",
  );
});
