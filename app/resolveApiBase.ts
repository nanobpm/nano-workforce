// Canonical reconstruction of the app control-API base a caller reached us on (e.g.
// "https://host/app/api"), so an operation can rewrite its embedded examples to THIS instance and
// keep them copy-pasteable. One implementation shared by every /app/api operation that keys output
// to the request base (getAgentInstructions, getAgentSkill, …) — per AGENTS.md "Derivation over
// duplication: no drift surfaces", proxy-header handling and base-path stripping must not fork.
//
// Honour reverse-proxy forwarding headers; fall back to a localhost default when the Host header is
// absent (e.g. a raw unit-test request).

/**
 * Recover the control-API base from a request, stripping the operation's own mount suffix.
 *
 * @param req         the request (path + headers)
 * @param mountSuffix the operation's path suffix to strip to recover the base, e.g. "agent" or
 *                    "agent/skill" (with or without a leading slash). The base defaults to
 *                    "/app/api" when the path is nothing but the suffix.
 */
export function resolveApiBase(req: { path: string; headers: Headers }, mountSuffix: string): string {
  const { proto, host } = requestProtoHost(req);
  // The op is mounted at "<base>/<mountSuffix>"; strip the trailing segments to recover the base path.
  const suffix = mountSuffix.replace(/^\/+/, "").replace(/\/+$/, "");
  const stripRe = new RegExp(`/${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/*$`);
  const basePath = req.path.replace(stripRe, "") || "/app/api";
  return host ? `${proto}://${host}${basePath}` : `http://localhost:3000${basePath}`;
}

/** The public ORIGIN (+ proxy prefix) this request arrived on — the base for a navigational link
 * handed back to the caller (e.g. a cockpit deep-link), WITHOUT the `/app/api` mount suffix that
 * {@link resolveApiBase} keeps. Where `resolveApiBase` reconstructs the control-API base an *agent*
 * calls back on, this reconstructs the human-facing origin: proto + host (same proxy-header trust as
 * `resolveApiBase`) plus any reverse-proxy path prefix advertised via `x-forwarded-prefix`, so a
 * link built as `${resolvePublicOrigin(req)}/app/pages/…` opens on the exact origin the operator is
 * driving this app from (e.g. a tunnel), not a static deployment-wide base. Falls back to a
 * localhost origin when the Host header is absent (a raw unit-test request). */
export function resolvePublicOrigin(req: { path: string; headers: Headers }): string {
  const { proto, host } = requestProtoHost(req);
  // x-forwarded-prefix is the reverse-proxy path the public URL was mounted under (e.g.
  // "/console/app-view/Workforce"); normalise to a leading-slash, no-trailing-slash segment or "".
  const rawPrefix = (req.headers.get("x-forwarded-prefix") ?? "").split(",")[0].trim();
  const prefix = rawPrefix ? `/${rawPrefix.replace(/^\/+/, "").replace(/\/+$/, "")}` : "";
  return host ? `${proto}://${host}${prefix}` : `http://localhost:3000${prefix}`;
}

/** The trusted (proto, host) pair for a request — the ONE place proxy-header handling lives so
 * `resolveApiBase` and `resolvePublicOrigin` can't drift (AGENTS.md "derivation over duplication").
 * Only `http`/`https` are trusted from the user-controlled `x-forwarded-proto`; the host prefers
 * `x-forwarded-host` over `host`. `host` is "" when neither header is present. */
function requestProtoHost(req: { headers: Headers }): { proto: string; host: string } {
  const rawProto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim().toLowerCase();
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : "http";
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  return { proto, host };
}
