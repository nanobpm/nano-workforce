// The ONE issue-reference grammar (`owner/repo#N` or a canonical `/issues/` URL). A side-effect-free
// leaf so light modules (e.g. app/operatorFeedback.ts) can reuse it without importing app/plan.ts.

import { parsePr } from "./prParse.ts";

export interface ParsedIssue {
  repo: string;
  number: number;
  url: string;
  planKey: string;
}

/** Parse "owner/repo#123" or a canonical issue URL into its parts. The URL branch is the /issues/
 * spelling; the shorthand branch DELEGATES to the canonical {@link parsePr} (`app/prParse.ts`) — the
 * single source of truth for the `owner/repo#N` shape — rather than carrying a second copy of its
 * regex (#856/#857: a duplicated shorthand grammar is exactly the drift the single-grammar guard bans).
 *
 * `parseIssue` admits an ISSUE reference, and `parsePr` ALSO accepts a `/pull/<n>` URL, so delegating
 * raw input to it would silently widen every issue-target door (startPlan/startFeature/startEpicSet,
 * plan deps) to accept a PR URL — resolvable-by-accident (issues and PRs share GitHub's number space)
 * but undocumented and off-contract (#857). So only the bare `owner/repo#N` shorthand is delegated: a
 * GitHub URL that is not the `/issues/` spelling handled above (a PR URL, a commit URL, …) fails closed
 * here. The gate keys on the `github.com/` HOST spelling (host + path separator), which every GitHub
 * URL carries but the `owner/repo#N` shorthand never does — NOT the bare `github.com` substring, which
 * a valid shorthand CAN carry as a repository name (`owner/github.com#42`, which `parsePr` accepts).
 * So the host-spelling gate rejects every non-issue GitHub URL while leaving the shorthand — including
 * a repo literally named `github.com` — to the one canonical grammar. */
export function parseIssue(input: string): ParsedIssue | null {
  const s = input.trim();
  // ANCHORED to the whole string with an exact `github.com` host (optional scheme + `www.`),
  // mirroring the hardened `parsePr` URL branch: the old UNANCHORED `github\.com/…` matched
  // `github.com` as a SUBSTRING — a spoofed host suffix (`notgithub.com`), a userinfo trick
  // (`github.com@evil.com`), or any prose-wrapped occurrence — and issue intake then operated on the
  // embedded `owner/repo`, a DIFFERENT target than the submitted value (#857 review). Supported URL
  // suffixes (`?query`, `#fragment`) are preserved via the trailing group.
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/issues/${number}`, planKey: `${repo}#${number}` };
  }
  if (/github\.com\//i.test(s)) return null;
  const pr = parsePr(s);
  if (pr) {
    return { repo: pr.repo, number: pr.number, url: `https://github.com/${pr.repo}/issues/${pr.number}`, planKey: pr.prKey };
  }
  return null;
}
