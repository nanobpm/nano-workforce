// nano-workforce — the PROXY-SAFE client read URL for a stored transcript (issue #744).
//
// A cockpit "past session" replay fetches a stored transcript's bytes by its relay STREAM ID. Some
// stream ids embed a `/` (a past-session id such as `34:joshs-macbook-pro-copilot-3d6ee882/13859`).
// Carrying that id in a URL PATH SEGMENT — `.../agentic/transcripts/<encodeURIComponent(id)>` — is
// structurally unsafe behind the Nano Console gateway proxy: the proxy decodes the `%2F` back to a
// real `/` BEFORE the app routes, so the app sees an extra path segment and 404s
// (`{"error":"no such operation"}`), the replay fetch throws, and the terminal region renders empty.
//
// The fix is to carry the stream id as a QUERY PARAMETER, where an embedded `/` (encoded `%2F`) is a
// value, never a path separator, so no proxy layer can split it. This module is the SINGLE SOURCE OF
// TRUTH for that read-URL scheme: it is intentionally dependency-free (no engine / blackboard / DOM
// imports) so BOTH cockpit clients derive the exact same URL from one place — the Node/TypeScript core
// imports it directly (re-exported from `transcript-url.ts`), and the deployed browser adapter
// (`pages/cockpit/mount.js`) imports the type-stripped browser sibling emitted by
// `scripts/build-cockpit-browser.ts` — rather than each hand-rolling the scheme and drifting.

/**
 * Build the proxy-safe transcript READ URL for a stored `stream` from offset `from` (inclusive).
 *
 * `endpoint` is the transcripts collection endpoint (no trailing slash, no query), e.g.
 * `<appMount>/app/api/agentic/transcripts`. The stream id rides as the `stream` query parameter (so an
 * embedded `/` survives any gateway proxy intact) and the optional resume offset as `from`. `from` is
 * omitted when it is undefined or 0 (the whole retained transcript — the endpoint's default), keeping
 * the common case a bare `?stream=<enc>`.
 *
 * When `from` is provided it must be a non-negative safe integer — the same constraint the server
 * enforces (`resolveTranscriptRead` returns 400 on a malformed/negative offset). A provided-but-invalid
 * `from` (e.g. -1, NaN, 1.5) is a caller bug, so we THROW rather than silently omit it (which would
 * quietly change the semantics to `from=0` and mask the bug).
 */
export function transcriptReadUrl(endpoint: string, stream: string, from?: number): string {
  const params = new URLSearchParams({ stream });
  if (from !== undefined) {
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new RangeError(`invalid from: expected a non-negative integer offset, got ${from}`);
    }
    if (from > 0) {
      params.set("from", String(from));
    }
  }
  return `${endpoint}?${params.toString()}`;
}
