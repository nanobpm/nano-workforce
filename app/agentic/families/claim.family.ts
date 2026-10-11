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
// registry from that resync. A supervisor may additionally close its resync with an AUTHORITATIVE
// snapshot frame (`claim` carrying the full `jobKeys` set for an instance, issue #893): the handler
// then `replaceInstance`s, dropping any claim the supervisor did NOT re-assert — so a `release` lost
// during a hub outage no longer strands the job. A supervisor that omits the snapshot keeps the
// pre-#893 additive behaviour.
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

/**
 * Read a resync snapshot's `jobKeys` array (the authoritative full jobKey set an instance owns) from a
 * `claim` frame, or undefined when the field is absent / not an array of strings. Its PRESENCE is the
 * discriminant that tells an authoritative resync snapshot (`{ instance, jobKeys }`, issue #893) apart
 * from a classic per-job claim (`{ instance, jobKey }`). It rides the existing `claim` wire family as a
 * forward-compatible enrichment — the protocol's structural validators tolerate the extra field, so an
 * older hub ignores it and keeps additive behaviour.
 */
function readJobKeys(value: unknown): readonly string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!Object.hasOwn(value, "jobKeys")) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, "jobKeys")?.value;
  if (!Array.isArray(field) || !field.every((k) => typeof k === "string")) return undefined;
  return field;
}

interface MountState {
  readonly registry: ClaimRegistry;
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
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
      // An authoritative resync SNAPSHOT (`{ instance, jobKeys }`, issue #893): the reconnecting
      // supervisor restates the full current ownership for one instance and its view WINS —
      // `replaceInstance` drops every claim it did NOT re-assert (so a `release` lost during a hub
      // outage no longer strands the job). A supervisor that never sends it keeps additive behaviour.
      const jobKeys = readJobKeys(frame.payload);
      if (jobKeys !== undefined) {
        const instance = readString(frame.payload, "instance");
        if (!instance) {
          ctx.log.warn("agentic claim resync: missing instance", {});
          return;
        }
        registry.replaceInstance(instance, jobKeys);
        return;
      }
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
    // dropped supervisor / aged-out worker). BOTH the drop-set AND the cadence are recomputed per
    // tick from the live presence registry via a self-rescheduling timer, so the reconcile is truly
    // independent of family mount order: whether presence mounts before or after this family, once it
    // is present each tick reclaims absent instances' claims AND adjusts its cadence to the real TTL
    // (a fixed-at-mount interval would stay pinned to the fallback cadence when claim mounts first).
    // Advisory — a fault is logged, never thrown, and the tick never keeps the process alive on its
    // own.
    const reconcileMs = (): number => {
      const presenceTtl = currentPresenceRegistry()?.ttlMs;
      return Math.max(1, Math.floor((presenceTtl ?? DEFAULT_RECONCILE_MS) / SWEEP_DIVISOR));
    };
    const schedule = (): void => {
      if (!state || state.stopped) return;
      const timer = setTimeout(tick, reconcileMs());
      timer.unref?.();
      state.timer = timer;
    };
    const tick = () => {
      try {
        const presence = currentPresenceRegistry();
        if (presence) {
          const present = new Set(presence.registeredWorkers().map((w) => w.instance));
          const released = registry.reconcile(present);
          if (released.length > 0) {
            ctx.log.info("agentic claim reconcile released absent instances", { released: released.length });
          }
        }
        // else: no presence source → keep claims until one mounts (resync repopulates)
      } catch (err) {
        ctx.log.warn("agentic claim reconcile failed", { err: String(err) });
      }
      schedule();
    };

    state = { registry, timer: undefined, stopped: false };
    schedule();
    ctx.log.info("agentic claim family mounted", { families: [CLAIM_FAMILY, RELEASE_FAMILY] });
  },

  teardown(): void {
    if (state) {
      state.stopped = true;
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    state = undefined;
    setCurrentClaimRegistry(undefined);
  },
};

export default family;
