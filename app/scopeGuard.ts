// Scope-integrity gate for the review-convergence loop (issue #313).
//
// A parity slice can be silently under-delivered: an agent legitimately splits a large slice, ships
// one half, but then (a) uses a `Closes #N` closing keyword on an issue whose stated scope was
// broader than what shipped, and (b) records the deferred remainder only in PR/commit prose (a
// `## Scope` section) rather than as a filed, tracked issue. The parent then reads as fully done —
// `gh issue list` shows nothing outstanding — and downstream consumers trust "issue closed =
// capability present". This is exactly how Magikcraft/nano-bpm#631 → PR #863 (`## Scope` deferral,
// `Closes #631`, no follow-up) lost the deferred half until a human re-filed it by hand as #872.
//
// This pure router encodes the two guards proposed in #313, evaluated over the PR description body
// so the deterministic converge-gate (`workers/converge-gate`) can block a partial delivery from
// closing a broader-scoped parent, escalating to the human `wait-answer` task instead of merging:
//
//   1. Closing-keyword integrity — a PR may only carry `Closes/Fixes/Resolves #N` when it delivers
//      #N's full stated scope. When the same body ALSO defers scope (a `## Scope` section /
//      "deferred" / "out of scope" / "remains"), the closing keyword is flagged: the PR must instead
//      use a non-closing ref (`Refs #N` / `Part of #N`) and leave #N open (or convert #N into a
//      tracking issue).
//   2. Deferred ⇒ filed issue, not prose — any PR that defers part of its scope must LINK a filed
//      follow-up issue for the remainder (`Deferred-to: #N` / `Tracked-in: #N` / `Follow-up: #N`). A
//      deferral that exists only in commit/ADR/PR text is a drift surface (invisible, unclaimable
//      work); mirror the repo's "no drift surfaces" rule, applied to scope.
//
// Both guards fire only when the body actually DEFERS scope, so a full-scope `Closes #N` PR with no
// deferral prose passes untouched.

export interface ScopeGuardInput {
  /** The PR description body (the text `gh pr create --body` set). */
  prBody: string | null | undefined;
}

export interface ScopeGuardResult {
  scopeBlocked: boolean;
  scopeBlockReason: string;
}

// GitHub's closing keywords (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved)
// followed by an issue ref: a bare `#123`, a cross-repo `owner/repo#123`, or a full issue URL. The
// keyword and ref may be separated by whitespace and/or a colon (`Closes: #1`, `Closes #1`).
const CLOSING_KEYWORD =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|(?:[\w.-]+\/[\w.-]+)?#\d+)/gi;

// A body DEFERS scope when it carries a `## Scope` (any heading level) section OR names a deferral in
// prose. A bare `remain*`/`remainder` is deliberately NOT enough on its own — normal "all done"
// phrasing ("No issues remain.", "no failing tests remaining") uses it without deferring any scope,
// and flagging that would block a full-scope PR from converging. A remainder mention only defers when
// a deferral-context term (scope / follow-up / later / to-do / tracking) sits near it; the incident's
// honest deferral read "…remain the deferred refinement", which the explicit `defer*` branch catches.
const DEFERRAL_HEADING = /^#{1,6}\s+scope\b/im;
const DEFERRAL_PHRASE = /\bdefer(?:s|red|ral|ring)?\b|\bout[- ]of[- ]scope\b/i;
const REMAINDER_WORD = /\bremain(?:s|der|ing)?\b/gi;
const REMAINDER_CONTEXT = /\b(?:scope|follow[- ]?ups?|later|to[- ]?dos?|track(?:s|ed|ing)?|next[- ]steps?)\b/i;
const REMAINDER_WINDOW = 48;

// Whether any `remain*` mention sits within a short window of a deferral-context term.
function remainderDefersScope(text: string): boolean {
  for (const m of text.matchAll(REMAINDER_WORD)) {
    const idx = m.index ?? 0;
    const window = text.slice(Math.max(0, idx - REMAINDER_WINDOW), idx + m[0].length + REMAINDER_WINDOW);
    if (REMAINDER_CONTEXT.test(window)) {
      return true;
    }
  }
  return false;
}

// A FILED follow-up issue link for the deferred remainder: an explicit tracking marker followed by
// an issue ref. This is the machine-checkable contract feature.md asks split slices to emit.
const FOLLOWUP_MARKER =
  /\b(?:deferred[- ]to|tracked[- ]in|tracking issue|follow[- ]?ups?(?:\s+issue)?)\b[\s:]*(?:[\w.-]+\/[\w.-]+)?#\d+/i;

/** The distinct issue refs a body closes via a GitHub closing keyword, in first-seen order. */
export function findClosingKeywordRefs(body: string | null | undefined): string[] {
  const text = body ?? "";
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CLOSING_KEYWORD)) {
    const ref = m[0].slice(m[1].length).replace(/^[\s:]+/, "").trim();
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

/** Whether the body defers part of its scope (a `## Scope` section or a deferral phrase). */
export function hasDeferralMarker(body: string | null | undefined): boolean {
  const text = body ?? "";
  return DEFERRAL_HEADING.test(text) || DEFERRAL_PHRASE.test(text) || remainderDefersScope(text);
}

/** Whether the body links a filed follow-up issue for the deferred remainder. */
export function hasFollowupIssueRef(body: string | null | undefined): boolean {
  return FOLLOWUP_MARKER.test(body ?? "");
}

/** Decide whether a PR's scope framing is safe to converge/merge. Pure; the worker feeds it the
 * live PR body and fails CLOSED (blocks) when that body cannot be read. */
export function evaluateScopeGuard(input: ScopeGuardInput): ScopeGuardResult {
  const body = input.prBody ?? "";
  const defers = hasDeferralMarker(body);
  const reasons: string[] = [];

  if (defers) {
    const closing = findClosingKeywordRefs(body);
    if (closing.length > 0) {
      const noun = closing.length === 1 ? "issue" : "issues";
      reasons.push(
        `this PR defers part of its scope yet closing-keywords ${noun} ${closing.join(", ")} — a partial delivery must not close a broader-scoped issue; use a non-closing ref (Refs #N / Part of #N) and leave it open (or convert it into a tracking issue)`,
      );
    }
    if (!hasFollowupIssueRef(body)) {
      reasons.push(
        "this PR defers part of its scope but links no filed follow-up issue for the remainder — file a tracking issue for each deferred item and link it (Deferred-to: #N / Tracked-in: #N / Follow-up: #N) so the remainder is tracked, not left in PR prose",
      );
    }
  }

  if (reasons.length === 0) {
    return { scopeBlocked: false, scopeBlockReason: "" };
  }
  return {
    scopeBlocked: true,
    scopeBlockReason: `Scope integrity blocked: ${reasons.join("; ")}.`,
  };
}
