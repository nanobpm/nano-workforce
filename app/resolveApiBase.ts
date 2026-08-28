// Canonical reconstruction of the app control-API base a caller reached us on (e.g.
// "https://host/app/api"), so an operation can rewrite its embedded examples to THIS instance and
// keep them copy-pasteable. One implementation shared by every /app/api operation that keys output
// to the request base (getAgentInstructions, getAgentSkill, …) — per AGENTS.md "Derivation over
// duplication: no drift surfaces", proxy-header handling and base-path stripping must not fork.
//
// Honour reverse-proxy forwarding headers — proto, host, and the external path prefix
// (X-Forwarded-Prefix, e.g. the console app-view proxy's "/console/app-view/{project}") — and fall
// back to a localhost default when the Host header is absent (e.g. a raw unit-test request).

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
  const prefix = sanitiseForwardedPrefix(req.headers.get("x-forwarded-prefix"));
  // The op is mounted at "<base>/<mountSuffix>"; strip the trailing segments to recover the base path.
  const suffix = mountSuffix.replace(/^\/+/, "").replace(/\/+$/, "");
  const stripRe = new RegExp(`/${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/*$`);
  const basePath = req.path.replace(stripRe, "") || "/app/api";
  return host ? `${proto}://${host}${prefix}${basePath}` : `http://localhost:3000${prefix}${basePath}`;
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
  const prefix = sanitiseForwardedPrefix(req.headers.get("x-forwarded-prefix"));
  return host ? `${proto}://${host}${prefix}` : `http://localhost:3000${prefix}`;
}

/** Sanitise the untrusted, proxy/user-controlled `x-forwarded-prefix` into a safe leading-slash,
 * no-trailing-slash path segment (or ""). The ONE canonical prefix sanitiser shared by
 * {@link resolveApiBase} and {@link resolvePublicOrigin} (AGENTS.md "derivation over duplication") —
 * the prefix is the reverse-proxy path the public URL was mounted under (e.g.
 * "/console/app-view/Workforce") and is reflected into a caller-facing URL, so it must not smuggle a
 * scheme, an authority ("//host"), or a "."/".." traversal segment into the URL. Accept only an
 * absolute path of URL-safe path characters, then drop trailing slashes so it composes cleanly with
 * the base path; anything else falls back to an empty prefix. Percent-encoding can smuggle those
 * forms past a literal check ("%2e%2e" decodes to "..", "%2f%2f" to an authority-introducing "//"),
 * so normalise the common encoded spellings of "." and "/" (case-insensitively) before rejecting
 * dot-segments and "//"; the still-encoded raw value is what we reflect once it validates. Because
 * the return is always either "" or a leading-"/" path, it can never alter the `${proto}://${host}`
 * authority. */
function sanitiseForwardedPrefix(raw: string | null): string {
  const rawPrefix = (raw ?? "").split(",")[0].trim();
  const decodedPrefix = rawPrefix.replace(/%2e/gi, ".").replace(/%2f/gi, "/");
  return /^\/(?!\/)[A-Za-z0-9._~\-/%]*$/.test(rawPrefix) &&
    !decodedPrefix.includes("//") &&
    !/(^|\/)\.\.?(\/|$)/.test(decodedPrefix)
    ? rawPrefix.replace(/\/+$/, "")
    : "";
}

/** The trusted (proto, host) pair for a request — the ONE place proxy-header handling lives so
 * `resolveApiBase` and `resolvePublicOrigin` can't drift (AGENTS.md "derivation over duplication").
 * Only `http`/`https` are trusted from the user-controlled `x-forwarded-proto`; the host prefers
 * `x-forwarded-host` over `host`. `host` is "" when neither header is present or the advertised host
 * is not a valid authority (see {@link sanitiseHost}). */
function requestProtoHost(req: { headers: Headers }): { proto: string; host: string } {
  const rawProto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim().toLowerCase();
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : "http";
  const rawHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  return { proto, host: sanitiseHost(rawHost) };
}

/** Sanitise the untrusted, proxy/user-controlled host (`x-forwarded-host`/`host`) into a bare
 * authority — a registered name or IPv4 with an optional `:port`, or a bracketed IPv6 literal with
 * an optional `:port` — or "" when it carries anything else. The host is reflected verbatim into the
 * `${proto}://${host}` authority of a caller-facing URL, so a hostile value like
 * `evil.com@real.example` (userinfo injection) or `real.example/extra-path` (path injection) must be
 * rejected outright rather than smuggled through. */
function sanitiseHost(host: string): string {
  if (!host) return "";
  const valid = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/.test(host);
  return valid ? host : "";
}
