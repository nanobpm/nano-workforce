// #856 — ONE PR-shape grammar. `app/prParse.ts` `parsePr` is the single source of truth for "is this a
// PR reference" (`owner/repo#N` or a GitHub PR URL). A second, stricter PR regex in the readiness probe
// made a delivery-graph `wait[pr merged]` incident on a PR URL the agent contract explicitly allows,
// while the converge-merge connector (canonical parser) accepted it. Guard the class: no other
// production module may carry its own copy of EITHER `parsePr` branch — the `/pull/<digits>` URL
// spelling OR the `owner/repo#<digits>` shorthand (the original #856 duplicate was the shorthand, so
// guarding only the URL spelling would let the exact failure mode regrow).
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

// The two spellings of a duplicate PR-shape grammar, matched against a module's SOURCE TEXT:
//  1. the URL branch — a literal `/pull/<digits>` regex (`github\.com/…/pull/(\d+)`);
//  2. the shorthand branch — a literal `#<digits>` capture regex (`^([^/]+/[^#]+)#(\d+)$`), the exact
//     duplicate that caused #856. Written per-branch below so this guard's own pattern stays
//     self-consistent with the ban it enforces (a combined `#(\d+)` scan would flag the pattern text).
const PULL_URL_REGEX = /\\\/pull\\\/\(\\d\+\)/;
const HASH_NUMBER_REGEX = /#\(\\d\+\)\$/;

test("#856: only app/prParse.ts defines a PR-URL regex (`/pull/<digits>`) — everyone else calls parsePr", () => {
  const files: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), files);
  const offenders = files
    .map((f) => relative(ROOT, f))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => PULL_URL_REGEX.test(readFileSync(join(ROOT, rel), "utf8")));
  assert.deepEqual(offenders, [], "use parsePr from app/prParse.ts instead of a local PR-URL regex");
});

test("#856/#857: only app/prParse.ts defines the `owner/repo#<digits>` shorthand regex — everyone else calls parsePr", () => {
  // The original #856 duplicate grammar was the SHORTHAND branch (`/^(.+?)#(\d+)$/`), with no
  // `/pull/` fragment — a URL-only guard stays green while the exact failure mode regrows. Ban the
  // shorthand capture regex everywhere outside the canonical module too (a `#<digits>` fragment-SHAPE
  // test with no capture group, e.g. the deliveryGraph redaction exemption, is not a PR parser and
  // is not matched).
  const files: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), files);
  const offenders = files
    .map((f) => relative(ROOT, f))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => HASH_NUMBER_REGEX.test(readFileSync(join(ROOT, rel), "utf8")));
  assert.deepEqual(offenders, [], "use parsePr from app/prParse.ts instead of a local owner/repo#N regex");
});
