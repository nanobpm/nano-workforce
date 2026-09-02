// nano-workforce — the agentic-channel `claim` / `release` job-ownership family (#713).
//
// H0 (#143) seam plug-in: ONE new file under `app/agentic/families/`, discovered by the loader's
// `*.family.ts` convention and mounted by the seam — it never edits `main.ts`, `drainAndExit`, or any
// shared boot line. It owns the `claim` (wire code 8) and `release` (wire code 9) message families —
// the explicit job-ownership frames nano-ide#542 appended to `@nanobpm/agentic` — attaching each
// handler through the hub's `registerFamilyHandler` seam (one family, one owning module), never a
// shared dispatch switch.
//
// What it gives the fleet: a first-class {@link ClaimRegistry} (`instance → set<jobKey>`) that becomes
// the AUTHORITATIVE source the supply snapshot reads for `jobKeys` — replacing the fragile
// relay-derived visibility. Each frame carries its OWNING `instance` EXPLICITLY, so attribution reads
// the frame, NOT the connection id (`conn.id`); that is what lets one per-host supervisor multiplex N
// distinct workers' ownership over a single connection. On a reconnect the supervisor re-`register`s
// every worker and re-`claim`s every active jobKey, and the (idempotent) claim handler rebuilds the
// registry from that resync.
//
// Liveness: a worker holding a claim reads "working" even with ZERO transcript — visibility no longer
// depends on terminal bytes landing/correlating. A bounded-memory maintenance tick reconciles the
// claim registry against the live presence set so a departed supervisor's claims are reclaimed (the
// `release` frame is the primary clear; this is the safety net for an unclean drop).
//
// Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
// is untouched; ADVISORY — the registry is a read-only visibility source and NEVER gates a BPMN
// sequence flow.
import type { HubConnection } from "@nanobpm/agentic/channel";
import { type Frame, validatePayload } from "@nanobpm/agentic/protocol";
import { ClaimRegistry, setCurrentClaimRegistry } from "../claim-registry.ts";
import type { AgenticContext, AgenticFamily } from "../registry.ts";
import { currentPresenceRegistry } from "./presence.family.ts";

/** The message-family names this module owns (the two ownership frames). */
export const CLAIM_FAMILY = "claim";
export const RELEASE_FAMILY = "release";

/** The reconcile tick runs at a third of the presence TTL — matching the presence-maintenance cadence. */
const SWEEP_DIVISOR = 3;
/** Fallback reconcile cadence when no presence registry is mounted to source a TTL. */
const DEFAULT_RECONCILE_MS = 10_000;

/** Read a string property from an unknown frame payload, or undefined when absent / non-string. */
function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!Object.hasOwn(value, key)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : undefined;
}

interface MountState {
  readonly registry: ClaimRegistry;
  readonly timer: ReturnType<typeof setInterval> | undefined;
}

let state: MountState | undefined;

/**
 * The `claim` / `release` family module. `mount` installs a fresh {@link ClaimRegistry} as the
 * process-wide singleton, attaches the two frame handlers via the S1 seam, and starts ONE bounded
 * reconcile tick. `teardown` stops the tick, detaches nothing (the hub owns handler lifetime for the
 * remount-guarded test path) and clears the singleton.
 */
export const family: AgenticFamily = {
  name: CLAIM_FAMILY,

  mount(ctx: AgenticContext): void {
    const registry = new ClaimRegistry();
    setCurrentClaimRegistry(registry);

    // `claim` opens the ownership window; `release` closes it. Attribution reads the frame's EXPLICIT
    // `instance` — never `conn.id` — so one connection can carry many instances' ownership frames. A
    // malformed payload is rejected before it touches the registry (advisory: logged, connection
    // kept). Both mutations are idempotent, matching the wire contract.
    ctx.hub.registerFamilyHandler(CLAIM_FAMILY, (frame: Frame, _conn: HubConnection) => {
      const result = validatePayload(CLAIM_FAMILY, frame.payload);
      if (!result.ok) {
        ctx.log.warn("agentic claim: malformed payload", { errors: result.errors.map((e) => e.code) });
        return;
      }
      const instance = readString(frame.payload, "instance");
      const jobKey = readString(frame.payload, "jobKey");
      if (!instance || !jobKey) return;
      registry.claim(instance, jobKey);
    });

    ctx.hub.registerFamilyHandler(RELEASE_FAMILY, (frame: Frame, _conn: HubConnection) => {
      const result = validatePayload(RELEASE_FAMILY, frame.payload);
      if (!result.ok) {
        ctx.log.warn("agentic release: malformed payload", { errors: result.errors.map((e) => e.code) });
        return;
      }
      const instance = readString(frame.payload, "instance");
      const jobKey = readString(frame.payload, "jobKey");
      if (!instance || !jobKey) return;
      registry.release(instance, jobKey);
    });

    // Bounded-memory reconcile: drop claims whose owning instance no longer has a presence row (a
    // dropped supervisor / aged-out worker). Read per tick, so it is independent of family mount order
    // and works whether presence mounts before or after this family. Advisory — a fault is logged,
    // never thrown, and the tick never keeps the process alive on its own.
    const presenceTtl = currentPresenceRegistry()?.ttlMs;
    const interval = Math.max(1, Math.floor((presenceTtl ?? DEFAULT_RECONCILE_MS) / SWEEP_DIVISOR));
    const tick = () => {
      try {
        const presence = currentPresenceRegistry();
        if (!presence) return; // no presence source → keep claims until one mounts (resync repopulates)
        const present = new Set(presence.registeredWorkers().map((w) => w.instance));
        const released = registry.reconcile(present);
        if (released.length > 0) {
          ctx.log.info("agentic claim reconcile released absent instances", { released: released.length });
        }
      } catch (err) {
        ctx.log.warn("agentic claim reconcile failed", { err: String(err) });
      }
    };
    const timer = setInterval(tick, interval);
    timer.unref?.();

    state = { registry, timer };
    ctx.log.info("agentic claim family mounted", { families: [CLAIM_FAMILY, RELEASE_FAMILY] });
  },

  teardown(): void {
    if (state?.timer !== undefined) clearInterval(state.timer);
    state = undefined;
    setCurrentClaimRegistry(undefined);
  },
};

export default family;
