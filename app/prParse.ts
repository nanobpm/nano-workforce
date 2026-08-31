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
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
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
