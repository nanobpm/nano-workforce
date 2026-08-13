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

export interface MountAgenticChannelOptions {
  /** The app's own `node:http` server (share its port; `app.httpServer` narrowed to `Server`). */
  readonly server: Server;
  /** The shared-secret ADR 0028 identity token every valid peer must present as `?token=…`. */
  readonly secret: string;
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
  const { server, secret, data, log } = opts;
  if (!secret) throw new Error("mountAgenticChannel requires a non-empty identity secret");

  const transport = new WebSocketChannelTransport({ server, path: AGENTIC_PATH });
  const hub = new AgenticHub({
    transport,
    // A valid identity token PLUS a required capability credential upgrades; either missing/invalid
    // is rejected (4401 / 4403). Swap in a real ADR 0028 verifier later by passing an Authenticator.
    authenticator: sharedSecretAuthenticator({ secret, requireCredential: true }),
    onError: (err, connectionId) =>
      log.warn("agentic hub error", { connectionId, err: String(err) }),
  });
  // Share the app's port: the transport rode the existing server, so it is already listening.
  await transport.ready();

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
    families: registry.names(),
  });

  let torndown = false;
  return {
    hub,
    transport,
    registry,
    inspect() {
      return {
        path: AGENTIC_PATH,
        families: registry.names(),
        connections: hub.connectionCount,
        address: hub.address,
      };
    },
    async teardown() {
      if (torndown) return;
      torndown = true;
      await registry.teardownAll(log);
      await hub.close();
      log.info("agentic channel torn down");
    },
  };
}
