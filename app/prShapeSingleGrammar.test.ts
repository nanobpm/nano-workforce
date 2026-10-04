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
// The canonical home of each single-source grammar: the PR-shape parser lives in app/prParse.ts, and
// the issue-shape parser (its `/issues/<n>` URL branch) lives in app/plan.ts `parseIssue`.
const PARSE_PR = "app/prParse.ts";
const PARSE_ISSUE = "app/plan.ts";

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

// The spellings of a duplicate reference-shape grammar, matched against a module's SOURCE TEXT. Each
// is matched DIGIT-CLASS- and ANCHOR-AGNOSTICALLY — pinned to a capture group opening on a digit atom
// (`\d` or `[0-9]`), NOT to one verbatim `#(\d+)$` spelling — so a drifted duplicate (`#(\d+)`,
// `#([0-9]+)$`, `#(\d+)\b`, `issues/([0-9]+)`) cannot stay green (#857):
//  1. the PR-URL branch — a `/pull/(<digits>` capture regex (`github\.com/…/pull/(\d+)`);
//  2. the PR shorthand branch — a `#(<digits>` capture regex (`^([^/]+/[^#]+)#(\d+)$`), the exact
//     duplicate that caused #856 — matched with no trailing `)$` so any drifted spelling is caught;
//  3. the issue-URL branch — an `/issues/(<digits>` capture regex (`parseIssue`'s URL spelling).
// Written per-branch so this guard's own pattern stays self-consistent with the ban it enforces (a
// combined `#(\d+)` scan would flag the pattern text).
const DIGITS = /(?:\\d|\[0-9\])/.source; // `\d` or `[0-9]` as it appears in regex SOURCE text
const PULL_URL_REGEX = new RegExp(`\\\\/pull\\\\/\\(${DIGITS}`);
const HASH_NUMBER_REGEX = new RegExp(`#\\(${DIGITS}`);
const ISSUES_URL_REGEX = new RegExp(`\\\\/issues\\\\/\\(${DIGITS}`);

function offenders(regex: RegExp, allowed: string): string[] {
  const files: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), files);
  return files
    .map((f) => relative(ROOT, f))
    .filter((rel) => rel !== allowed)
    .filter((rel) => regex.test(readFileSync(join(ROOT, rel), "utf8")));
}

test("#856: only app/prParse.ts defines a PR-URL regex (`/pull/<digits>`) — everyone else calls parsePr", () => {
  assert.deepEqual(
    offenders(PULL_URL_REGEX, PARSE_PR),
    [],
    "use parsePr from app/prParse.ts instead of a local PR-URL regex",
  );
});

test("#856/#857: only app/prParse.ts defines the `owner/repo#<digits>` shorthand regex — everyone else calls parsePr", () => {
  // The original #856 duplicate grammar was the SHORTHAND branch (`/^(.+?)#(\d+)$/`), with no
  // `/pull/` fragment — a URL-only guard stays green while the exact failure mode regrows. Ban the
  // shorthand capture regex everywhere outside the canonical module too (a `#<digits>` fragment-SHAPE
  // test with no capture group, e.g. the deliveryGraph redaction exemption, is not a PR parser and
  // is not matched).
  assert.deepEqual(
    offenders(HASH_NUMBER_REGEX, PARSE_PR),
    [],
    "use parsePr from app/prParse.ts instead of a local owner/repo#N regex",
  );
});

test("#857: only app/plan.ts defines the issue-URL regex (`/issues/<digits>`) — everyone else calls parseIssue", () => {
  // `parseIssue` is the single source of the issue-shape grammar, exactly as `parsePr` is for the PR
  // shape. Its `/issues/<n>` URL branch was unguarded, so a second issue-URL parser could drift in and
  // reopen the #856 class on the issue side. Ban the capture regex everywhere outside app/plan.ts.
  assert.deepEqual(
    offenders(ISSUES_URL_REGEX, PARSE_ISSUE),
    [],
    "use parseIssue from app/plan.ts instead of a local /issues/<n> regex",
  );
});
