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
  const rawProto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim().toLowerCase();
  // x-forwarded-proto is user-controlled behind some proxies; only trust http/https.
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : "http";
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  // The op is mounted at "<base>/<mountSuffix>"; strip the trailing segments to recover the base path.
  const suffix = mountSuffix.replace(/^\/+/, "").replace(/\/+$/, "");
  const stripRe = new RegExp(`/${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/*$`);
  const basePath = req.path.replace(stripRe, "") || "/app/api";
  return host ? `${proto}://${host}${basePath}` : `http://localhost:3000${basePath}`;
}
