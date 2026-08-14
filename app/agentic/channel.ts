// nano-workforce — mount the app-tier agentic channel hub (ADR 0056, H0 / #143).
//
// This is the keystone of the agentic-visibility epic (#142): it stands up the WebSocket channel +
// hub on the app's OWN HTTP server (same port as the pages and `/app/api/hooks/*` — no sidecar
// port), authenticates each upgrade (ADR 0028 identity token + a capability credential, mirroring
// the `?token=…` pattern the blackboard hook uses), and mounts every registered family module
// through the {@link AgenticFamilyRegistry} seam.
//
// `main.ts` calls {@link mountAgenticChannel} once after `runFromEnv` and calls the returned
// handle's `teardown()` inside its existing `drainAndExit`. That is the ONLY place `main.ts` /
// `drainAndExit` are edited for the whole epic — siblings extend the channel purely by dropping a
// family module under `app/agentic/families/`.
//
// Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
// is untouched; advisory semantics preserved (a family never gates a BPMN sequence flow).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgenticHub,
  sharedSecretAuthenticator,
  WebSocketChannelTransport,
} from "@nanobpm/agentic/channel";
import type { DataLayer, Logger } from "@nanobpm/urban";
import { loadAgenticFamilies } from "./loader.ts";
import { AgenticFamilyRegistry } from "./registry.ts";

/** The path the agentic channel is served on, on the app's own port. */
export const AGENTIC_PATH = "/agentic";

/**
 * The well-known identity token used in LOCAL mode (security opt-in). Nano is local-first: on a
 * developer's own machine the visibility channel is on by default with no credential friction, so
 * the hub and the `nano work` worker agree on this constant, well-known localhost token. It is NOT
 * a secret — it only gates same-machine dev traffic. In secure mode (`secure: true` + a real
 * `NANO_AGENTIC_SECRET`) this constant is never used and a real ADR 0028 verifier applies. Keep in
 * lock-step with the worker constant in jwulf/c8ctl-plugin-nano (`c8ctl-plugin.js` LOCAL_AGENTIC_TOKEN).
 */
export const LOCAL_AGENTIC_TOKEN = "nano-local";

/**
 * True if `addr` (from {@link Server.address}) is a loopback / same-machine bind — the safety
 * assumption LOCAL mode relies on. A string address is a UNIX domain socket / named pipe (same-host
 * only) and is treated as safe; a TCP bind is loopback only for `127.0.0.0/8` or `::1`. A wildcard
 * bind (`0.0.0.0` / `::`) or any specific public interface is NOT loopback, so the well-known
 * {@link LOCAL_AGENTIC_TOKEN} would be reachable off-box. `null` (an unbound / not-yet-listening
 * server) is NOT treated as safe — the bind is unverifiable, so callers must handle it explicitly
 * rather than silently skipping the exposure check.
 */
function isLoopbackBind(addr: string | AddressInfo | null): boolean {
  if (addr === null) return false;
  if (typeof addr === "string") return true;
  const host = addr.address;
  return host === "::1" || host === "::ffff:127.0.0.1" || host.startsWith("127.");
}

export interface MountAgenticChannelOptions {
  /** The app's own `node:http` server (share its port; `app.httpServer` narrowed to `Server`). */
  readonly server: Server;
  /** The shared-secret ADR 0028 identity token every valid peer must present as `?token=…`. In LOCAL
   * mode (`secure: false`) this may be empty — the hub substitutes {@link LOCAL_AGENTIC_TOKEN}. */
  readonly secret: string;
  /**
   * Security mode. Nano is local-first, so this defaults to `true` (strict) at the library level to
   * keep the fail-closed contract for any caller that doesn't opt in — but `main.ts` passes
   * `secure: false` whenever no `NANO_AGENTIC_SECRET` is configured, mounting an on-by-default LOCAL
   * channel: a well-known localhost token ({@link LOCAL_AGENTIC_TOKEN}) and NO required capability
   * credential. Set `secure: true` (with a real secret) to require an ADR 0028 identity token AND a
   * capability credential on every upgrade.
   */
  readonly secure?: boolean;
  /** The app's SQLite data layer, threaded to family modules (may be absent when data isn't mounted). */
  readonly data: DataLayer | undefined;
  /** A structured logger for lifecycle lines. */
  readonly log: Logger;
  /**
   * Discover + register family modules from `app/agentic/families/`. Default: the real discovery
   * loader. Tests inject a fixed set to keep the mount hermetic.
   */
  readonly families?: () => Promise<AgenticFamilyRegistry> | AgenticFamilyRegistry;
}

/** The live channel, returned to `main.ts` so it can inspect it and tear it down on shutdown. */
export interface AgenticChannelHandle {
  readonly hub: AgenticHub;
  readonly transport: WebSocketChannelTransport;
  readonly registry: AgenticFamilyRegistry;
  /** A structured snapshot for `inspect()`/logs. */
  inspect(): Record<string, unknown>;
  /** Tear the families (reverse order) then the hub + transport down. Idempotent. */
  teardown(): Promise<void>;
}

/** Build a family registry from the on-disk discovery loader (the production default). */
async function discoverRegistry(log: Logger): Promise<AgenticFamilyRegistry> {
  const registry = new AgenticFamilyRegistry();
  registry.registerAll(await loadAgenticFamilies(undefined, log));
  return registry;
}

/**
 * Mount the agentic hub on `server`, authenticate upgrades with `secret`, and mount all discovered
 * family modules. Returns a handle whose `teardown()` reverses everything.
 */
export async function mountAgenticChannel(
  opts: MountAgenticChannelOptions,
): Promise<AgenticChannelHandle> {
  const { server, data, log } = opts;
  // Local-first: `secure` defaults to true at the library level (fail-closed for callers that don't
  // opt in), but `main.ts` passes `secure: false` for the on-by-default LOCAL channel. In LOCAL mode
  // an empty secret is fine — we substitute the well-known localhost token and drop the credential
  // requirement so a `nano work` worker appears live with zero configuration.
  const secure = opts.secure ?? true;
  const secret = opts.secret || (secure ? "" : LOCAL_AGENTIC_TOKEN);
  if (secure && !secret) {
    throw new Error("mountAgenticChannel (secure mode) requires a non-empty identity secret");
  }

  const transport = new WebSocketChannelTransport({ server, path: AGENTIC_PATH });
  const hub = new AgenticHub({
    transport,
    // Secure mode: a valid identity token PLUS a required capability credential upgrades; either
    // missing/invalid is rejected (4401 / 4403). Swap in a real ADR 0028 verifier later by passing an
    // Authenticator. LOCAL mode: token-only (the well-known localhost token), no credential required.
    authenticator: sharedSecretAuthenticator({ secret, requireCredential: secure }),
    onError: (err, connectionId) =>
      log.warn("agentic hub error", { connectionId, err: String(err) }),
  });
  // Share the app's port: the transport rode the existing server, so it is already listening.
  await transport.ready();

  // LOCAL mode gates only on the well-known localhost token, so it is safe ONLY while the server is
  // bound to loopback. The channel rides the app's server and does not own its bind address, so it
  // cannot enforce this — but if the server is exposed on a wildcard/public interface, the token is
  // reachable off-box; warn loudly so an operator either binds to loopback or switches to secure mode.
  // A `null` address (server not listening yet) is unverifiable — warn rather than silently skipping
  // the exposure check, since the bind could later resolve to a public interface.
  if (!secure) {
    const addr = server.address();
    if (addr === null) {
      log.warn(
        "agentic channel is in LOCAL mode but the server bind address could not be verified " +
          "(the server is not listening yet) — the well-known LOCAL_AGENTIC_TOKEN cannot be " +
          "confirmed loopback-only. Mount the channel after the server is listening, set " +
          "NANO_AGENTIC_SECRET for secure mode, or bind the server to 127.0.0.1.",
        { mode: "local", bind: null },
      );
    } else if (!isLoopbackBind(addr)) {
      log.warn(
        "agentic channel is in LOCAL mode but the server is not bound to loopback — the well-known " +
          "LOCAL_AGENTIC_TOKEN is reachable from other hosts. Set NANO_AGENTIC_SECRET for secure " +
          "mode, or bind the server to 127.0.0.1.",
        { mode: "local", bind: typeof addr === "object" ? addr.address : String(addr) },
      );
    }
  }

  // If discovery or any family mount throws, the transport + hub are already live: tear down whatever
  // mounted (in reverse) and close the hub before rethrowing, so a failed boot never strands upgrade
  // handlers or half-open connections.
  let registry: AgenticFamilyRegistry | undefined;
  try {
    registry = await (opts.families ? opts.families() : discoverRegistry(log));
    await registry.mountAll({ hub, registry: hub.registry, transport, data, log });
  } catch (err) {
    await registry?.teardownAll(log);
    await hub.close();
    throw err;
  }

  log.info("agentic channel mounted", {
    path: AGENTIC_PATH,
    mode: secure ? "secure" : "local",
    families: registry.names(),
  });

  let tornDown = false;
  return {
    hub,
    transport,
    registry,
    inspect() {
      return {
        path: AGENTIC_PATH,
        mode: secure ? "secure" : "local",
        families: registry.names(),
        connections: hub.connectionCount,
        address: hub.address,
      };
    },
    async teardown() {
      if (tornDown) return;
      tornDown = true;
      await registry.teardownAll(log);
      await hub.close();
      log.info("agentic channel torn down");
    },
  };
}
