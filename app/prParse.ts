// Canonical PR-key parser (extracted from app/service.ts so leaf modules can reuse the ONE
// implementation of the `owner/repo#N` shape without importing the heavy service module — which
// imports them, so a back-import would cycle). `app/service.ts` re-exports `parsePr`/`ParsedPr`
// from here, so every existing `import { parsePr } from "./service.ts"` keeps resolving. This is
// the single source of truth for "is this string a PR key?" — do not add a second shape regex.
export interface ParsedPr {
  repo: string;
  number: number;
  url: string;
  prKey: string;
}

/** Parse "owner/repo#123" or a canonical PR URL into its parts, or `null` when the input is not a
 *  PR key/URL. */
export function parsePr(input: unknown): ParsedPr | null {
  // Total on any input: a process-variable regression (or an older in-flight instance) can carry a
  // non-string prKey, and `.trim()` on a non-string throws — turning a should-fail-open caller into
  // a retrying job. Fail closed to `null` here so every caller resolves safely instead of throwing.
  if (typeof input !== "string") return null;
  const s = input.trim();
  // ANCHORED to the whole string with an exact `github.com` host (optional scheme + `www.`): an
  // unanchored `github\.com/…` matched `github.com` as a SUBSTRING — a spoofed host suffix
  // (`notgithub.com`), a userinfo trick (`github.com@evil.com`), or any prose-wrapped occurrence —
  // and the pr/epic probe would then silently poll the embedded `owner/repo` (a DIFFERENT target
  // than the submitted value) or time out (#857). Supported URL suffixes (`/files`, `?query`,
  // `#fragment`) are preserved via the trailing group. This is the ONE PR-URL grammar; every
  // downstream (`parsePrTarget`/`parsePlanKey` in readiness.ts, etc.) inherits the anchoring.
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  return null;
}
