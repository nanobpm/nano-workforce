// Scope-integrity guard — unit tests for the canonical router (app/scopeGuard.ts) and its parsing
// helpers.
//
// A parity slice can be silently under-delivered: an agent splits a large slice, ships one half,
// then `Closes #N` a broader-scoped parent while recording the deferred remainder only in PR prose
// (a `## Scope` section) with no filed follow-up issue. Magikcraft/nano-bpm#631 → PR #863 did
// exactly this and the deferred half was lost until a human re-filed it as #872. These two guards
// (#313) block that class: a partial delivery may not close-keyword a broader-scoped parent, and any
// deferral must link a filed follow-up issue rather than live in prose.
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import {
  collectDeferralEvidence,
  evaluateScopeGuard,
  findClosingKeywordRefs,
  hasDeferralMarker,
  hasFollowupIssueRef,
} from "./scopeGuard.ts";

// ── The canonical router ────────────────────────────────────────────────────

test("evaluateScopeGuard: a full-scope PR that Closes its parent, no deferral, is allowed", () => {
  const r = evaluateScopeGuard({ prBody: "Implements the feature end to end.\n\nCloses #313" });
  assertEquals(r.scopeBlocked, false);
  assertEquals(r.scopeBlockReason, "");
});

test("evaluateScopeGuard: a plain PR with no closing keyword and no deferral is allowed", () => {
  const r = evaluateScopeGuard({ prBody: "A small refactor. Refs #10" });
  assertEquals(r.scopeBlocked, false);
});

test("evaluateScopeGuard: Closes a broader parent AND defers scope → blocked (guard 1)", () => {
  const r = evaluateScopeGuard({
    prBody:
      "Delivers the nested ad-hoc half.\n\n## Scope\nEmbedded SUB_PROCESS tools remain the deferred refinement.\n\nCloses #631",
  });
  assertEquals(r.scopeBlocked, true);
  assertStringIncludes(r.scopeBlockReason, "must not close a broader-scoped issue");
  assertStringIncludes(r.scopeBlockReason, "#631");
});

test("evaluateScopeGuard: defers scope but links NO follow-up issue → blocked (guard 2)", () => {
  const r = evaluateScopeGuard({
    prBody: "Ships the first half.\n\n## Scope\nThe rest is deferred.\n\nRefs #631",
  });
  assertEquals(r.scopeBlocked, true);
  assertStringIncludes(r.scopeBlockReason, "no filed follow-up issue");
  // Guard 1 must NOT fire — this PR correctly used a non-closing ref.
  assert(
    !r.scopeBlockReason.includes("must not close"),
    "a non-closing ref must not trip the closing-keyword guard",
  );
});

test("evaluateScopeGuard: defers scope AND links a filed follow-up AND uses a non-closing ref → allowed", () => {
  const r = evaluateScopeGuard({
    prBody:
      "Ships the first half.\n\n## Scope\nThe embedded SUB_PROCESS half is deferred.\nTracked-in: #872\n\nRefs #631",
  });
  assertEquals(r.scopeBlocked, false);
  assertEquals(r.scopeBlockReason, "");
});

test("evaluateScopeGuard: the motivating incident (Closes #631 + ## Scope + no follow-up) trips BOTH guards", () => {
  const r = evaluateScopeGuard({
    prBody:
      "## Summary\nNested ad-hoc / agent-of-agents delivered.\n\n## Scope\nembedded `SUB_PROCESS` tools whose multi-element body runs by token flow remain the deferred refinement.\n\nCloses #631",
  });
  assertEquals(r.scopeBlocked, true);
  assertStringIncludes(r.scopeBlockReason, "must not close a broader-scoped issue");
  assertStringIncludes(r.scopeBlockReason, "no filed follow-up issue");
});

test("evaluateScopeGuard: a follow-up link alone does not excuse a closing keyword on a split", () => {
  // Even with the remainder tracked, closing the broader parent is still wrong — it reads as done.
  const r = evaluateScopeGuard({
    prBody: "Ships half.\n\nDeferred: the rest. Follow-up: #872\n\nCloses #631",
  });
  assertEquals(r.scopeBlocked, true);
  assertStringIncludes(r.scopeBlockReason, "must not close a broader-scoped issue");
  assert(!r.scopeBlockReason.includes("no filed follow-up issue"), "the follow-up was linked");
});

test("evaluateScopeGuard: tolerates null / empty bodies", () => {
  assertEquals(evaluateScopeGuard({ prBody: null }).scopeBlocked, false);
  assertEquals(evaluateScopeGuard({ prBody: undefined }).scopeBlocked, false);
  assertEquals(evaluateScopeGuard({ prBody: "" }).scopeBlocked, false);
});

// ── The parsers ─────────────────────────────────────────────────────────────

test("findClosingKeywordRefs: extracts bare, cross-repo, and URL closing refs; dedupes", () => {
  const body = [
    "Closes #12",
    "fixes: owner/repo#34",
    "Resolved https://github.com/owner/repo/issues/56",
    "Closes #12", // duplicate
  ].join("\n");
  assertEquals(findClosingKeywordRefs(body), [
    "#12",
    "owner/repo#34",
    "https://github.com/owner/repo/issues/56",
  ]);
});

test("findClosingKeywordRefs: a non-closing ref (Refs / Part of) is not a closing keyword", () => {
  assertEquals(findClosingKeywordRefs("Refs #12\nPart of #34\nDepends-on: #56"), []);
});

test("hasDeferralMarker: detects a ## Scope heading and deferral phrases; ignores clean prose", () => {
  assert(hasDeferralMarker("## Scope\nfoo"), "a Scope heading defers");
  assert(hasDeferralMarker("### scope of work"), "any heading level counts");
  assert(hasDeferralMarker("The rest is deferred to later."), "'deferred' defers");
  assert(hasDeferralMarker("This is out of scope for now."), "'out of scope' defers");
  assert(hasDeferralMarker("The remainder is left for a follow-up."), "'remainder' defers");
  assert(!hasDeferralMarker("Implements everything. Closes #1."), "clean prose does not defer");
});

test("hasDeferralMarker: a bare 'remain*' without deferral context is not a deferral", () => {
  // "all done" phrasing must not be read as a scope deferral (Copilot advisory,
  // app/scopeGuard.ts:48): a full-scope PR that merely reports nothing outstanding
  // would otherwise be blocked from converging.
  assert(!hasDeferralMarker("No issues remain.\n\nCloses #123"), "'No issues remain' is not a deferral");
  assert(!hasDeferralMarker("All checks remain green."), "'remain green' is not a deferral");
  assert(!hasDeferralMarker("No failing tests remaining. Closes #7"), "'remaining' alone is not a deferral");
  // ...but a remainder mention near genuine deferral context still defers.
  assert(hasDeferralMarker("The remaining scope is tracked separately."), "'remaining' near 'scope' defers");
  assert(hasDeferralMarker("Remaining work is a follow-up."), "'remaining' near 'follow-up' defers");
});

test("hasFollowupIssueRef: only an explicit tracking marker + issue ref counts", () => {
  assert(hasFollowupIssueRef("Deferred-to: #872"), "Deferred-to marker");
  assert(hasFollowupIssueRef("Tracked-in: owner/repo#872"), "cross-repo tracking marker");
  assert(hasFollowupIssueRef("Follow-up: #900"), "Follow-up marker");
  assert(hasFollowupIssueRef("Follow up issue: #900"), "Follow up issue marker");
  assert(!hasFollowupIssueRef("The rest is deferred."), "bare deferral prose is not a filed link");
  assert(!hasFollowupIssueRef("Refs #631"), "a parent ref is not a remainder tracker");
  // A full GitHub issue URL is a valid filed follow-up link, same as the closing-keyword parser accepts.
  assert(
    hasFollowupIssueRef("Deferred-to: https://github.com/owner/repo/issues/872"),
    "Deferred-to marker with a full issue URL",
  );
  assert(
    hasFollowupIssueRef("Follow-up issue: https://github.com/nanobpm/nano-workforce/issues/900"),
    "Follow-up marker with a full issue URL",
  );
});

// ── Actionable evidence: quote WHAT the gate read as deferred ────────────────

test("collectDeferralEvidence: quotes the ## Scope section text (not just the heading)", () => {
  const body = "Ships the core.\n\n## Scope\nThe poll→inbox integration belongs to S4/S5.\n\n## Tests\ngreen";
  const ev = collectDeferralEvidence(body);
  assert(ev.length > 0, "a Scope section yields evidence");
  assertStringIncludes(ev[0], "poll→inbox integration belongs to S4/S5");
  assert(!ev[0].includes("## Tests"), "evidence stops at the next heading");
});

test("collectDeferralEvidence: quotes the exact defer* clause (e.g. an ADR non-goal)", () => {
  const ev = collectDeferralEvidence("connector is a real stub — real I/O deferred per ADR non-goals.");
  assertEquals(ev.length, 1);
  assertStringIncludes(ev[0], "real I/O deferred per ADR non-goals");
});

test("collectDeferralEvidence: a clean full-scope body yields no evidence", () => {
  assertEquals(collectDeferralEvidence("Implements the feature end to end.\n\nCloses #313"), []);
  assertEquals(collectDeferralEvidence(null), []);
});

test("collectDeferralEvidence: clips a very long section and de-dupes repeats", () => {
  const long = `## Scope\n${"x".repeat(400)}`;
  const ev = collectDeferralEvidence(long);
  assertEquals(ev.length, 1);
  assert(ev[0].length <= 161, "snippet is clipped to the max length + ellipsis");
  assertStringIncludes(ev[0], "…");
});

test("evaluateScopeGuard: the block reason quotes the specific deferred text", () => {
  const r = evaluateScopeGuard({
    prBody: "Delivers S3.\n\n## Scope\nThe poll→inbox integration belongs to S4/S5.\n\nCloses #378",
  });
  assert(r.scopeBlocked);
  // still names the closing-keyword issue and the two guards…
  assertStringIncludes(r.scopeBlockReason, "#378");
  assertStringIncludes(r.scopeBlockReason, "must not close a broader-scoped issue");
  // …and now ALSO quotes what it read as deferred, so the human sees the actual text.
  assertStringIncludes(r.scopeBlockReason, "The deferral the gate read in the PR body:");
  assertStringIncludes(r.scopeBlockReason, "poll→inbox integration belongs to S4/S5");
});
