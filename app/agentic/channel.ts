// nano-workforce — mount the app-tier agentic channel hub (ADR 0056, H0 / #143).
//
// This is the keystone of the agentic-visibility epic (#142): it stands up the WebSocket channel +
// hub on the app's OWN HTTP server (same port as the pages and `/app/api/hooks/*` — no sidecar
// port), authenticates each upgrade (ADR 0028 identity token; the capability credential was removed
// as it was accept-any friction), and mounts every registered family module
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
 * The well-known identity token used in LOCAL mode (the default). Nano is trusted-network-first: the
 * visibility channel is on by default with no credential friction, so the hub and the `nano work`
 * worker agree on this constant, well-known token. It is NOT a secret — LOCAL mode is designed for a
 * trusted LAN and the token is honoured from ANY origin (the same trust posture the unauthenticated
 * engine already relies on); a non-loopback bind therefore leaves the visibility channel OPEN on the
 * LAN, which the startup WARN surfaces. Set `NANO_AGENTIC_SECRET` (SECURE mode) to require a shared
 * secret (the same value on the hub and every peer) instead. Keep in lock-step with the worker
 * constant in jwulf/c8ctl-plugin-nano
 * (`c8ctl-plugin.js` LOCAL_AGENTIC_TOKEN).
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

// LOCAL mode honours the well-known token from ANY origin: exposure is governed by the server bind
// (loopback by default) and surfaced by the startup WARN below, matching the trusted-network posture
// the unauthenticated engine already relies on. Set NANO_AGENTIC_SECRET (SECURE mode) to require a
// shared secret (the same value on the hub and every peer) instead.

export interface MountAgenticChannelOptions {
  /** The app's own `node:http` server (share its port; `app.httpServer` narrowed to `Server`). */
  readonly server: Server;
  /** The shared-secret ADR 0028 identity token every valid peer must present as `?token=…` (the same
   * value on the hub and every peer). In LOCAL mode (`secure: false`) this may be empty — {@link
   * mountAgenticChannel} substitutes {@link LOCAL_AGENTIC_TOKEN} via its local `secret` assignment. */
  readonly secret: string;
  /**
   * Security mode. Defaults to `true` (strict) at the library level — fail-closed for any caller
   * that doesn't explicitly opt in — but `main.ts` passes
   * `secure: false` whenever no `NANO_AGENTIC_SECRET` is configured, mounting an on-by-default LOCAL
   * channel: a well-known token ({@link LOCAL_AGENTIC_TOKEN}) honoured from any origin, with NO
   * capability credential. Set `secure: true` (with a real secret) to require an ADR 0028 identity
   * token on every upgrade.
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
  // Identity-token-only auth in both modes: SECURE verifies the token against the real
  // NANO_AGENTIC_SECRET; LOCAL accepts the well-known token from any origin. The capability
  // credential is intentionally NOT required — nano-workforce never verified it (accept-any), so it
  // was pure configuration friction; a real ADR 0028 capability check can reintroduce it later by
  // passing a verifier.
  const authenticator = sharedSecretAuthenticator({ secret, requireCredential: false });
  const hub = new AgenticHub({
    transport,
    // A valid identity token upgrades (4401 on mismatch). SECURE mode's token is the real secret;
    // LOCAL mode's is the well-known token, honoured from any origin (trusted-LAN posture).
    authenticator,
    onError: (err, connectionId) =>
      log.warn("agentic hub error", { connectionId, err: String(err) }),
  });
  // Share the app's port: the transport rode the existing server, so it is already listening.
  await transport.ready();

  // LOCAL mode honours the well-known token (not a secret) from any origin. On a loopback bind that
  // only reaches same-host peers; on a non-loopback bind the visibility channel is OPEN on the LAN —
  // anyone who can reach this port can attach and watch worker presence/terminals. That is the
  // intended trusted-network posture, but it must never be silent, so warn. A `null` address (server
  // not listening yet) is unverifiable — warn too, since it may be exposed.
  if (!secure) {
    const addr = server.address();
    if (addr === null) {
      log.warn(
        "agentic channel is in LOCAL mode but the server bind address could not be verified " +
          "(the server is not listening yet) — if it is bound off-box the visibility channel is " +
          "OPEN on the LAN with the well-known token. Mount the channel after the server is " +
          "listening, set NANO_AGENTIC_SECRET to require a secret, or NANO_AGENTIC=off to disable.",
        { mode: "local", bind: null },
      );
    } else if (!isLoopbackBind(addr)) {
      log.warn(
        "agentic channel is in LOCAL mode and the server is not bound to loopback — the visibility " +
          "channel is OPEN on the LAN: any peer that can reach this port can attach with the " +
          "well-known token and watch worker presence/terminals. Set NANO_AGENTIC_SECRET to require " +
          "a secret, or NANO_AGENTIC=off to disable.",
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
