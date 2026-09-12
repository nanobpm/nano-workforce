// Standalone `/console` → engine-console redirect (issue #771).
//
// When Nano Workforce runs **embedded** behind the nano console, the console origin serves
// `/console/*` (its app-view host, `/console/app-view/Workforce/…`) and the reverse proxy strips the
// `/console/app-view/Workforce` prefix before the app's own HTTP server ever sees the request — so
// the app only ever handles `/app/*`, `/agentic`, and its page routes at the root.
//
// Run **standalone** (the default `npm start` on a bare port, no console proxy in front), links the
// UI emits under `/console` — the engine console's own origin — hit this app's port instead, where
// nothing serves them: the runtime answers a bare 503 because `/console/*` is not a registered
// app-view route. This is a narrow Node request redirect that rewrites those `/console/*` requests to
// the engine console origin, preserving the full path + query, and leaves every other route
// (`/app/*`, `/agentic`, the Workforce page routes at the root) untouched — it only ever fires for a
// path that is exactly `/console` or under `/console/`.
//
// The redirect is derived, not configured twice: the engine console shares the engine's origin, so
// the target origin is `NANOBPMN_BASE_URL`'s origin (default `http://localhost:8080`) — the same
// single source of truth the engine address resolves from (see `app/enginePreflight.ts`). Mounting
// it when embedded is harmless: the proxy owns `/console` there, so the app's server never sees such
// a path.

import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import { envVar } from "./version.ts";

/** A minimal logging surface (structurally a subset of `Logger`) the mount uses at boot. */
export interface ConsoleRedirectLog {
  info(msg: string): void;
}

/**
 * The `Location` a `/console`-prefixed request should be redirected to, or `null` when the request
 * is NOT a console route (and so must be left for the app's own handlers).
 *
 * Matches ONLY a path that is exactly `/console` or begins with `/console/` — a sibling route such
 * as `/console-x` or `/app/console` is deliberately NOT matched, keeping the redirect narrow. The
 * full original request target (path + query) is preserved by appending it verbatim to the console
 * origin: because the request path already carries the `/console` prefix, the result is
 * `<consoleOrigin>/console/<rest>?<query>`.
 *
 * @param url          the raw request target (`req.url`), e.g. `/console/app-view/Foo?tab=bar`.
 * @param consoleOrigin the engine console origin (scheme + authority, no trailing slash), e.g.
 *                      `http://localhost:8080`.
 */
export function consoleRedirectLocation(
  url: string | undefined,
  consoleOrigin: string,
): string | null {
  if (!url) return null;
  const queryAt = url.indexOf("?");
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  if (path === "/console" || path.startsWith("/console/")) {
    return `${consoleOrigin.replace(/\/+$/, "")}${url}`;
  }
  return null;
}

/**
 * Resolve the engine console origin (scheme + authority) from `NANOBPMN_BASE_URL` — the engine
 * console is served on the engine's own origin, so this reuses the single engine-base source of
 * truth rather than introducing a second knob. Any path/query on the base is discarded (only the
 * origin is meaningful for the redirect target). Falls back to the localhost default when unset or
 * unparseable.
 *
 * `read` is injectable so resolution is testable without mutating `process.env`.
 */
export function resolveConsoleOrigin(read: (name: string) => string | null = envVar): string {
  const raw = read("NANOBPMN_BASE_URL")?.trim();
  const candidate = raw && raw.length > 0 ? raw : "http://localhost:8080";
  try {
    return new URL(candidate).origin;
  } catch {
    return "http://localhost:8080";
  }
}

/**
 * Prepend a `/console` → engine-console redirect in front of `server`'s existing request handling.
 *
 * The runtime has already attached the app's own `request` listener(s) by the time this runs, so we
 * capture them, remove them, and install a single wrapper that either answers a `/console/*` request
 * with a `302` (preserving path + query) or delegates to every captured listener unchanged. This
 * keeps the app's own routing (control API, pages, agentic upgrade) intact for every non-console
 * request while giving the redirect first refusal on the console prefix.
 *
 * Returns a teardown that restores the original listener set.
 */
export function mountConsoleRedirect(
  server: Server,
  consoleOrigin: string,
  log?: ConsoleRedirectLog,
): () => void {
  // `Server#listeners` is typed `Function[]` by Node; narrow to the request-listener signature so we
  // can re-invoke and later restore them.
  // biome-ignore lint/plugin: runtime/framework contract boundary for Node's untyped listeners()
  const existing = server.listeners("request") as RequestListener[];
  server.removeAllListeners("request");

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const location = consoleRedirectLocation(req.url, consoleOrigin);
    if (location !== null) {
      res.statusCode = 302;
      res.setHeader("Location", location);
      res.end();
      return;
    }
    for (const listener of existing) listener.call(server, req, res);
  };

  server.on("request", handler);
  log?.info(`console redirect mounted: /console/* → ${consoleOrigin}/console/* (standalone links)`);

  return () => {
    server.removeListener("request", handler);
    for (const listener of existing) server.on("request", listener);
  };
}
