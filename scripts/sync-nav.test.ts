// Drift guard for the single-source-of-truth nav (issue #306).
//
// `pages/_nav.json` is the ONE place the top-nav item list (and the Tasks
// open-tasks count badge) is defined; `scripts/sync-nav.ts` materialises it into
// every `pages/*.page.json`. This test fails if any page's nav node diverges from
// the canonical source, so the eight copies can never silently drift apart again
// (AGENTS.md: "Derivation over duplication: no drift surfaces"). Run `npm run
// sync:nav` to reconcile.
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assert } from "#test-assert";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);

type Json = any;

// Deterministic, key-sorted serialization: compare nav nodes by value, not by
// authored key order or whitespace.
function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function navNodeOf(page: Json): Json {
  const nav = (page.nodes ?? []).find((n: Json) => n?.type === "nav");
  assert(nav, "page has no nav node");
  return nav;
}

function pageFiles(): string[] {
  return readdirSync(`${ROOT}pages`)
    .filter((n) => n.endsWith(".page.json"))
    .sort();
}

test("issue #306: every page's nav node matches the canonical pages/_nav.json", () => {
  const canon = JSON.parse(readFileSync(`${ROOT}pages/_nav.json`, "utf8"));
  const want = stable(canon);
  const files = pageFiles();
  assert(files.length > 0, "no page files found");
  for (const name of files) {
    const page = JSON.parse(readFileSync(`${ROOT}pages/${name}`, "utf8"));
    const nav = navNodeOf(page);
    assert(
      stable(nav) === want,
      `${name}: nav node has drifted from pages/_nav.json — run \`npm run sync:nav\``,
    );
  }
});

test("issue #306: the Tasks nav item carries the live open-tasks count badge", () => {
  const canon = JSON.parse(readFileSync(`${ROOT}pages/_nav.json`, "utf8"));
  const items = canon?.props?.items ?? [];
  const tasks = items.find((i: Json) => i?.page === "tasks");
  assert(tasks, "canonical nav has no Tasks item");
  const badge = tasks.badge;
  assert(badge, "Tasks nav item must declare a live count badge");
  // The badge counts the single open-escalation projection (user_tasks) with no
  // filter, so count(user_tasks) is exactly "decisions awaiting a human"; danger
  // tone, 5s refresh, hidden at zero to keep a quiet nav clean.
  assert(badge.source === "app", "badge.source must be \"app\"");
  assert(badge.table === "user_tasks", "badge.table must be \"user_tasks\"");
  assert(Array.isArray(badge.filter) && badge.filter.length === 0, "badge.filter must be []");
  assert(badge.tone === "danger", "badge.tone must be \"danger\"");
  assert(badge.refreshMs === 5000, "badge.refreshMs must be 5000");
  assert(badge.hideWhenZero === true, "badge.hideWhenZero must be true");
});

test("issue #306: the badge's user_tasks table is defined by the migrations", () => {
  // The runtime whitelists the badge's datasource table against the live schema; a
  // table the migrations never created would 400 the count fetch. Guard it here so
  // a rename fails CI, mirroring scripts/pages-contract.test.ts.
  let sql = "";
  for (const e of readdirSync(`${ROOT}db/migrations`, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".sql")) {
      sql += readFileSync(`${ROOT}db/migrations/${e.name}`, "utf8");
    }
  }
  assert(
    /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?user_tasks["`]?/i.test(sql),
    "badge table \"user_tasks\" must be created (TABLE or VIEW) by db/migrations/*.sql",
  );
});
