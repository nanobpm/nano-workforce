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
import { assert } from "jsr:@std/assert@1";
import { testBoundary } from "../app/test-support.ts";

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
  while (true) {
    m = createRe.exec(sql);
    if (m === null) break;
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
  while (true) {
    m = alterRe.exec(sql);
    if (m === null) break;
    const cols = schema.get(m[1]) ?? new Set<string>();
    cols.add(m[2]);
    schema.set(m[1], cols);
  }
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

async function loadSchema(): Promise<Map<string, Set<string>>> {
  const schema = new Map<string, Set<string>>();
  const files: string[] = [];
  for await (const e of Deno.readDir(`${ROOT}db/migrations`)) {
    if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  }
  files.sort(); // migration order doesn't matter for the union, but keep it deterministic
  for (const f of files) {
    parseSchema(await Deno.readTextFile(`${ROOT}db/migrations/${f}`), schema);
  }
  return schema;
}

// ---- pages -> datasource references -------------------------------------------------------------

interface Json {
  [key: string]: unknown;
  field?: string;
  linkField?: string;
  parentField?: string;
  childField?: string;
  table?: string;
  source?: string;
  kind?: string;
  data?: Json;
  columns?: Json[];
  detail?: Json;
  fields?: Json[];
  children?: Json[];
  tabs?: Json[];
  filter?: Json[];
  rowKey?: string;
  orderBy?: Json;
  lazyField?: Json;
}

const isString = (value: unknown): value is string => typeof value === "string";

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
  return filter.map((f: Json) => f?.field).filter(isString);
}

function collectRefs(page: string, node: Json, out: Ref[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(page, v, out);
    return;
  }
  if (!node || typeof node !== "object") return;

  // Top-level datasource grid: the datasource lives at `node.data`, while `columns`, `rowKey`,
  // `filter`/`tabs`, and `detail` are siblings on the same `node` (the grid props).
  const data = node.data;
  if (data && data.kind === "datasource" && typeof data.table === "string") {
    const columns: string[] = (node.columns ?? []).map((c: Json) => c.field).filter(isString);
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
    ].filter(isString);
    out.push({ page, table: data.table, source: data.source ?? "app", fields, columns });
  }

  // Child grid inside a detail: { table, childField, parentField, orderBy, columns }
  if (typeof node.table === "string" && typeof node.childField === "string") {
    const columns: string[] = (node.columns ?? []).map((c: Json) => c.field).filter(isString);
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
      ].filter(isString),
      columns,
    });
  }

  for (const v of Object.values(node)) collectRefs(page, v, out);
}

async function loadRefs(): Promise<Ref[]> {
  const refs: Ref[] = [];
  for await (const e of Deno.readDir(`${ROOT}pages`)) {
    if (!e.isFile || !e.name.endsWith(".page.json")) continue;
    const page = JSON.parse(await Deno.readTextFile(`${ROOT}pages/${e.name}`));
    collectRefs(e.name, testBoundary<Json>(page), refs);
  }
  return refs;
}

// ---- guards -------------------------------------------------------------------------------------

Deno.test("every page datasource table exists in the migrations", async () => {
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

Deno.test("every page datasource column exists on its table", async () => {
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

Deno.test("issue #87: plan_reviews is surfaced on the epic and home pages", async () => {
  const refs = await loadRefs();
  const onEpic = refs.some((r) => r.page === "epic.page.json" && r.table === "plan_reviews");
  const onHome = refs.some((r) => r.page === "home.page.json" && r.table === "plan_reviews");
  assert(onEpic, "epic.page.json must bind a grid to plan_reviews (plan-review trace)");
  assert(onHome, "home.page.json plan detail must include a plan_reviews child grid");

  // The trace is only useful with the verdict + critique columns, so pin them. Assert against the
  // visibly displayed `columns` (not `fields`, which also holds binding refs like orderBy.field) so
  // a column silently dropped from the grid UI can't pass by being referenced elsewhere.
  const required = ["round", "approved", "findings"];
  for (const r of refs.filter((x) => x.table === "plan_reviews")) {
    for (const col of required) {
      assert(
        r.columns.includes(col),
        `${r.page}: plan_reviews grid must expose the "${col}" column`,
      );
    }
  }
});
