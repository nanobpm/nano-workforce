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
// The scan must cover EVERY production source file, not only the package subdirs above: the repo's
// production entrypoint + host glue (`main.ts`) lives at the repo ROOT, so a duplicate grammar added
// there would leave all three guards green while reopening the #856 class. Include every root-level
// `.ts` module (not just a hardcoded `main.ts`) so any future root production source is covered too.
const ROOT_FILES_FILTER = (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts");
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
// is matched DIGIT-CLASS-, ANCHOR-, and CAPTURE-SPELLING-AGNOSTICALLY — pinned to a capture group
// (plain OR named) opening on a digit atom (`\d` or `[0-9]`), NOT to one verbatim `#(\d+)$` spelling —
// so a drifted duplicate cannot stay green by respelling the capture (#857 review): `#(\d+)`,
// `#([0-9]+)$`, `#(\d+)\b`, `issues/([0-9]+)`, AND the named-capture forms `#(?<number>\d+)`,
// `/pull/(?<number>\d+)`, `/issues/(?<n>[0-9]+)` are ALL caught. Pinning the scan to a BARE `(` before
// the digit atom was the fail-open gap: a named capture inserts `?<name>` between the `(` and the
// digit, so the old `…\(${DIGITS}` patterns never matched it and a duplicate grammar in that spelling
// regressed the single-grammar invariant while every guard stayed green:
//  1. the PR-URL branch — a `/pull/(<digits>` capture regex (`github\.com/…/pull/(\d+)`);
//  2. the PR shorthand branch — a `#(<digits>` capture regex (`^([^/]+/[^#]+)#(\d+)$`), the exact
//     duplicate that caused #856 — matched with no trailing `)$` so any drifted spelling is caught;
//  3. the issue-URL branch — an `/issues/(<digits>` capture regex (`parseIssue`'s URL spelling).
// Written per-branch so this guard's own pattern stays self-consistent with the ban it enforces (a
// combined `#(\d+)` scan would flag the pattern text).
const DIGITS = /(?:\\d|\[0-9\])/.source; // `\d` or `[0-9]` as it appears in regex SOURCE text
// A capture-group OPENING in regex source: a bare `(` OR a named capture `(?<name>` — the `?<name>`
// prefix is what the old bare-`\(` scan missed. `(?:\?<[A-Za-z_][A-Za-z0-9_]*>)?` is the optional
// named-capture tag, so both `(\d+)` and `(?<number>\d+)` match. (Lookahead/lookbehind `(?=…)`/`(?<=…)`
// and non-capturing `(?:…)` openers are not capture groups a parser extracts a number from, so they are
// intentionally out of scope — the guard bans a duplicate *capture* of the digits.)
const CAPTURE_OPEN = `\\((?:\\?<[A-Za-z_][A-Za-z0-9_]*>)?`;
const PULL_URL_REGEX = new RegExp(`\\\\/pull\\\\/${CAPTURE_OPEN}${DIGITS}`);
const HASH_NUMBER_REGEX = new RegExp(`#${CAPTURE_OPEN}${DIGITS}`);
const ISSUES_URL_REGEX = new RegExp(`\\\\/issues\\\\/${CAPTURE_OPEN}${DIGITS}`);

function collectProductionFiles(): string[] {
  const files: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), files);
  // Root-level production modules (e.g. main.ts) are not under any package dir — scan them too.
  for (const e of readdirSync(ROOT)) {
    const p = join(ROOT, e);
    if (!statSync(p).isDirectory() && ROOT_FILES_FILTER(e)) files.push(p);
  }
  return files;
}

function offenders(regex: RegExp, allowed: string): string[] {
  return collectProductionFiles()
    .map((f) => relative(ROOT, f))
    .filter((rel) => rel !== allowed)
    .filter((rel) => regex.test(readFileSync(join(ROOT, rel), "utf8")));
}

test("#856/#857: the grammar guard scans the root production entrypoint (main.ts), not only the package dirs", () => {
  // A duplicate grammar in the root entrypoint/host glue must not slip past the three guards below.
  const scanned = collectProductionFiles().map((f) => relative(ROOT, f));
  assert.ok(
    scanned.includes("main.ts"),
    "the guard's scanned set must include the root main.ts production entrypoint",
  );
});

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

test("#857: the guard's scan catches a duplicate grammar in ANY capture spelling (mutation fixtures)", () => {
  // The scan must be CAPTURE-SPELLING-AGNOSTIC: a duplicate parser that respells the capture group
  // (named capture, `[0-9]` for `\d`, a drifted anchor) must still be flagged, or the single-grammar
  // invariant regresses behind a green guard. These are the regex SOURCE fragments a duplicate parser
  // would carry; each must match its branch's scan regex. (The canonical modules' own real spellings
  // are covered by the allowlist in the tests above — these fixtures prove the *detector* fires on the
  // drifted forms a copy-paste would actually produce.)
  // Fixtures are written as the duplicate's regex SOURCE TEXT appears in a `.ts` module — slashes
  // escaped (`\/`) and the digit atom as `\d` / `[0-9]` — exactly what `readFileSync` reads and the
  // scan regexes are built to match.
  const dupSpellings: Array<{ branch: RegExp; src: string; why: string }> = [
    // PR-URL branch — plain, named-capture, and [0-9] spellings of `/pull/(<digits>`:
    { branch: PULL_URL_REGEX, src: "github\\.com\\/([^/]+)\\/([^/]+)\\/pull\\/(\\d+)", why: "plain /pull/(\\d+)" },
    { branch: PULL_URL_REGEX, src: "\\/pull\\/(?<number>\\d+)", why: "named /pull/(?<number>\\d+)" },
    { branch: PULL_URL_REGEX, src: "\\/pull\\/([0-9]+)", why: "[0-9] /pull/([0-9]+)" },
    // PR shorthand branch — plain and named-capture spellings of `#(<digits>`:
    { branch: HASH_NUMBER_REGEX, src: "^([^/]+\\/[^#]+)#(\\d+)$", why: "plain #(\\d+)" },
    { branch: HASH_NUMBER_REGEX, src: "#(?<number>\\d+)", why: "named #(?<number>\\d+)" },
    { branch: HASH_NUMBER_REGEX, src: "#([0-9]+)\\b", why: "[0-9] #([0-9]+)" },
    // Issue-URL branch — plain and named-capture spellings of `/issues/(<digits>`:
    { branch: ISSUES_URL_REGEX, src: "\\/issues\\/(\\d+)", why: "plain /issues/(\\d+)" },
    { branch: ISSUES_URL_REGEX, src: "\\/issues\\/(?<n>[0-9]+)", why: "named /issues/(?<n>[0-9]+)" },
  ];
  for (const { branch, src, why } of dupSpellings) {
    assert.ok(branch.test(src), `the guard must flag a duplicate spelled as ${why} (${src})`);
  }
  // And a NON-capturing numeric match (no capture group — `(?:\d+)` or a bare `\d+`) is NOT a parser
  // extraction and must NOT be flagged, so the guard does not false-positive on innocent digit matches.
  assert.ok(!HASH_NUMBER_REGEX.test("#(?:\\d+)"), "a non-capturing #(?:\\d+) is not a duplicate parser");
  assert.ok(!PULL_URL_REGEX.test("\\/pull\\/(?:\\d+)"), "a non-capturing /pull/(?:\\d+) is not a duplicate parser");
});
