// #857 — pin `parseIssue`'s accepted grammar. Its shorthand branch delegates to the canonical
// `parsePr` (single `owner/repo#N` grammar, #856), and `parsePr` ALSO accepts a `/pull/<n>` URL — so
// without a guard, every issue-target door (startPlan/startFeature/startEpicSet, plan deps) would
// silently widen to admit a PR URL. These tests pin that `parseIssue`:
//   • accepts an `/issues/<n>` URL and the bare `owner/repo#N` shorthand, and
//   • REJECTS a PR URL (and any other non-`/issues/` GitHub URL), failing closed rather than
//     resolving it by accident off the shared issue/PR number space.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { parseIssue } from "./plan.ts";

test("parseIssue: accepts an /issues/<n> URL", () => {
  assertEquals(parseIssue("https://github.com/o/r/issues/42"), {
    repo: "o/r",
    number: 42,
    url: "https://github.com/o/r/issues/42",
    planKey: "o/r#42",
  });
});

test("parseIssue: accepts the bare owner/repo#N shorthand (delegated to the canonical parsePr)", () => {
  assertEquals(parseIssue("o/r#42"), {
    repo: "o/r",
    number: 42,
    url: "https://github.com/o/r/issues/42",
    planKey: "o/r#42",
  });
  // trims surrounding whitespace like every caller's `.trim()` path
  assertEquals(parseIssue("  o/r#7  ")?.planKey, "o/r#7");
});

test("parseIssue: accepts shorthand whose repo is literally named github.com (host-spelling gate, not bare substring) (#857)", () => {
  // The non-issue-URL gate keys on the `github.com/` HOST spelling, so a valid shorthand carrying
  // `github.com` as a REPO NAME still parses — parsePr accepts `owner/github.com#N`, so parseIssue must.
  assertEquals(parseIssue("owner/github.com#42"), {
    repo: "owner/github.com",
    number: 42,
    url: "https://github.com/owner/github.com/issues/42",
    planKey: "owner/github.com#42",
  });
});

test("parseIssue: REJECTS a PR URL — parsePr would accept it, but a PR URL is not an issue target (#857)", () => {
  assertEquals(parseIssue("https://github.com/o/r/pull/7"), null);
  // even with a trailing path segment or embedded in prose, the non-issue GitHub URL is rejected
  assertEquals(parseIssue("https://github.com/o/r/pull/7/files"), null);
  assertEquals(parseIssue("please land https://github.com/o/r/pull/7 now"), null);
});

test("parseIssue: REJECTS other non-/issues/ GitHub URLs (commit, blob, …) and junk", () => {
  assertEquals(parseIssue("https://github.com/o/r/commit/deadbeef"), null);
  assertEquals(parseIssue("https://github.com/o/r"), null);
  assertEquals(parseIssue(""), null);
  assertEquals(parseIssue("not a ref"), null);
});
