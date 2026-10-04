// #856 — ONE PR-shape grammar. `app/prParse.ts` `parsePr` is the single source of truth for "is this a
// PR reference" (`owner/repo#N` or a GitHub PR URL). A second, stricter PR regex in the readiness probe
// made a delivery-graph `wait[pr merged]` incident on a PR URL the agent contract explicitly allows,
// while the converge-merge connector (canonical parser) accepted it. Guard the class: no other
// production module may carry its own PR-URL regex.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const DIRS = ["app", "workers", "operations", "actions"];
const ALLOWED = new Set(["app/prParse.ts"]);

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
}

test("#856: only app/prParse.ts defines a PR-URL regex (`/pull/<digits>`) — everyone else calls parsePr", () => {
  const files: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), files);
  const offenders = files
    .map((f) => relative(ROOT, f))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => /\\\/pull\\\/\(\\d\+\)/.test(readFileSync(join(ROOT, rel), "utf8")));
  assert.deepEqual(offenders, [], "use parsePr from app/prParse.ts instead of a local PR-URL regex");
});
