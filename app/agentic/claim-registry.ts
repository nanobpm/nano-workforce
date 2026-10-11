// nano-workforce — the explicit job-ownership CLAIM registry (#713, upstream keystone nano-ide#542).
//
// The authoritative source of "which jobs a worker instance is currently running", replacing the
// fragile relay-DERIVED visibility it supersedes. Cockpit `jobKeys` used to be INFERRED from the
// `job:<jobKey>` relay-terminal stream correlated to a worker via its CONNECTION id — a path that in
// production went effectively dead (every live worker reported `jobKeys:[]` while actively running a
// job) and that breaks by construction the moment one per-host supervisor multiplexes N workers over
// a single connection (the instance can no longer be derived from `conn.id`).
//
// This registry fixes the failure MODE, not one instance of it: job ownership becomes a first-class,
// EXPLICITLY-attributed fact carried by `claim` / `release` frames (wire codes 8/9, added to
// `@nanobpm/agentic` by nano-ide#542). Each frame names its OWNING `instance` explicitly, so one
// connection can carry the ownership frames of many distinct workers. A worker that holds a claim
// reads "working" even with ZERO transcript — visibility no longer depends on terminal bytes landing
// or correlating.
//
// Relationship to the correlation registry (`./correlation.ts`): correlation is DEMOTED to drill-in
// context only (the process-instance / plan a terminal belongs to, keyed by jobKey). This registry —
// keyed by the frame's explicit `instance` — is the visibility source the supply snapshot's
// `jobKeysFor` seam resolves against. The two are distinct signals: presence "connected" and job
// "claimed" must not be conflated (a live channel is not an observed agent).
//
// Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
// is untouched — a claim is an app-side ownership announcement on the agentic channel, not a new wire
// type on the job protocol; ADVISORY — the registry is a read-only visibility source and NEVER
// hard-locks or gates a BPMN sequence flow.

import { composeStreamId } from "@nanobpm/agentic/emit";

/** One ownership record: a worker instance's claim over a job. */
export interface Claim {
  /** The owning worker instance (carried EXPLICITLY in the frame, never inferred from a connection). */
  readonly instance: string;
  /** The Camunda-8 job key the instance owns. */
  readonly jobKey: string;
}

/** The read-only claim snapshot: every currently-held claim, sorted by instance then jobKey. */
export interface ClaimSnapshot {
  readonly claims: readonly Claim[];
  readonly count: number;
}

/**
 * The advisory in-memory job-ownership registry. It holds two derived-from-one-write projections of
 * the same `claim` call: `instance → jobKeys` (the presence resolver) and `jobKey → instance` (the
 * owner lookup, so `release` and a re-claim can move a job cleanly). A jobKey is owned by at most one
 * instance at a time; re-claiming it under a different instance MOVES it (dropping the stale reverse
 * edge) so a re-dispatched job never double-counts. Every mutation is idempotent, matching the wire
 * contract: a duplicate `claim` is a no-op re-assertion; a duplicate or late `release` is a no-op.
 *
 * It needs no durable backing: claims are ephemeral and re-announced. On a WS reconnect the supervisor
 * re-`register`s every worker and re-`claim`s every active jobKey, so the registry is rebuilt from that
 * full-state resync — which is exactly what makes it survive the reconnect that the old relay-derived
 * path stranded the jobKey across. A supervisor may close its resync with an AUTHORITATIVE snapshot via
 * {@link replaceInstance} (issue #893), dropping any claim it did not re-assert so a lost `release`
 * cannot strand a job; omitting it keeps the additive re-claim behaviour.
 */
export class ClaimRegistry {
  /** worker instance → the set of jobKeys it currently owns (insertion-ordered). */
  readonly #jobsOf = new Map<string, Set<string>>();
  /** jobKey → the worker instance that currently owns it. */
  readonly #ownerOf = new Map<string, string>();

  /**
   * Record that `instance` now OWNS `jobKey` (the authoritative ownership window opens). Idempotent:
   * a repeat claim of the same `{ instance, jobKey }` is a no-op re-assertion. If the jobKey is
   * currently owned by a DIFFERENT instance, it MOVES to the new owner (the stale reverse edge is
   * dropped) — a re-dispatched or reconnected-under-new-instance job never double-counts. Both args
   * must be non-empty; an empty value is ignored.
   */
  claim(instance: string, jobKey: string): void {
    if (instance === "" || jobKey === "") return;
    const previousOwner = this.#ownerOf.get(jobKey);
    if (previousOwner === instance) return; // idempotent re-assertion
    if (previousOwner !== undefined) {
      this.#jobsOf.get(previousOwner)?.delete(jobKey);
      this.#pruneInstance(previousOwner);
    }
    this.#ownerOf.set(jobKey, instance);
    const jobs = this.#jobsOf.get(instance) ?? new Set<string>();
    jobs.add(jobKey);
    this.#jobsOf.set(instance, jobs);
  }

  /**
   * Release `instance`'s claim over `jobKey` (the ownership window closes — the job finished, failed,
   * or moved on). Idempotent and a strict no-op unless `instance` is the CURRENT owner: a duplicate or
   * late `release`, a `release` with no preceding `claim`, or a `release` from an instance that no
   * longer owns the job (it already moved to another owner) all leave the registry untouched — so a
   * stale release can never blank a still-running job another instance now owns.
   */
  release(instance: string, jobKey: string): void {
    if (instance === "" || jobKey === "") return;
    if (this.#ownerOf.get(jobKey) !== instance) return;
    this.#ownerOf.delete(jobKey);
    this.#jobsOf.get(instance)?.delete(jobKey);
    this.#pruneInstance(instance);
  }

  /**
   * Release EVERY claim a worker instance holds (e.g. its supervisor connection dropped, or presence
   * aged it out). No-op for an unknown instance.
   */
  releaseInstance(instance: string): void {
    const jobs = this.#jobsOf.get(instance);
    if (!jobs) return;
    for (const jobKey of jobs) this.#ownerOf.delete(jobKey);
    this.#jobsOf.delete(instance);
  }

  /**
   * Authoritatively REPLACE every claim held by `instance` with `jobKeys` — the reconnect-resync
   * contract (issue #893). A reconnecting supervisor restates the full, current ownership snapshot for
   * one worker instance; its view WINS. Every claim this instance held that is NOT in `jobKeys` is
   * dropped (so a `release` lost during a hub outage no longer strands the job as "working" until the
   * worker exits entirely), and every jobKey in `jobKeys` is (re-)claimed — an idempotent no-op for one
   * it already owned, a {@link claim} move for one another instance held.
   *
   * It keeps the registry's existing guarantees: a jobKey that has MOVED to another instance is never
   * blanked by the OLD instance's resync (the old instance no longer holds it, so the drop pass cannot
   * touch it), and repeated resyncs are safe. Only `instance`'s own claims are considered — a sibling's
   * claims are untouched. An empty `instance` is ignored; empty jobKeys in the snapshot are skipped.
   *
   * This is ADDITIVE on the wire: a supervisor that never sends a resync snapshot keeps the pre-#893
   * merge behaviour (claims cleared only by an explicit `release` or the presence-driven
   * {@link reconcile}). Authoritative replacement is safe precisely because ownership is advisory,
   * short-lived visibility the supervisor can always restate (ADR 0056 — the registry never gates a
   * BPMN flow).
   */
  replaceInstance(instance: string, jobKeys: Iterable<string>): void {
    if (instance === "") return;
    const next = new Set<string>();
    for (const jobKey of jobKeys) if (jobKey !== "") next.add(jobKey);
    const current = this.#jobsOf.get(instance);
    if (current) {
      for (const jobKey of [...current]) {
        if (!next.has(jobKey)) this.release(instance, jobKey);
      }
    }
    for (const jobKey of next) this.claim(instance, jobKey);
  }

  /**
   * Drop every claim whose owning instance is NOT in `presentInstances` — the bounded-memory
   * reconcile a maintenance tick drives against the live presence set, so a departed supervisor's
   * claims do not linger. A reconnecting worker keeps its presence row (presence is keyed by instance
   * across reconnects), so this never drops a mid-job reconnect's claim; a truly-exited worker loses
   * its presence row and its claims are reclaimed here. Returns the released instance ids. This is a
   * safety net, not the primary path — `release` frames and reconnect-resync are.
   */
  reconcile(presentInstances: ReadonlySet<string>): string[] {
    const released: string[] = [];
    for (const instance of [...this.#jobsOf.keys()]) {
      if (!presentInstances.has(instance)) {
        this.releaseInstance(instance);
        released.push(instance);
      }
    }
    return released;
  }

  /**
   * The jobKeys a worker instance currently owns, sorted for a stable render. This is the resolver
   * injected into {@link PresenceRegistry.snapshot}'s `jobKeysFor` seam — the visibility source the
   * supply feed / cockpit reads (superseding the relay correlation).
   */
  jobKeysFor(instance: string): string[] {
    const jobs = this.#jobsOf.get(instance);
    return jobs ? [...jobs].sort((a, b) => a.localeCompare(b)) : [];
  }

  /**
   * The jobKey-scoped relay stream a worker's terminal should drill into: its lowest-sorted current
   * claim's stream (`composeStreamId(instance, jobKey)`). A worker runs one job at a time in this
   * fleet, but sorting keeps it stable if it ever holds several. Undefined when the worker holds no
   * claim — the caller then falls back to the instance-keyed stream. This is the "relay demoted to
   * drill-in, keyed by the CLAIM (not by `instanceForConnection`)" seam. The instance-scoped stream id
   * is the one canonical `@nanobpm/agentic/emit` codec the producer writes under (issue #738), so the
   * cockpit drills the SAME stream the transcript bytes actually land on.
   */
  primaryStreamFor(instance: string): string | undefined {
    const [first] = this.jobKeysFor(instance);
    return first === undefined ? undefined : composeStreamId(instance, first);
  }

  /** Whether any instance currently owns `jobKey`. */
  isClaimed(jobKey: string): boolean {
    return this.#ownerOf.has(jobKey);
  }

  /** The instance currently owning `jobKey`, or undefined when it is unclaimed. */
  ownerOf(jobKey: string): string | undefined {
    return this.#ownerOf.get(jobKey);
  }

  /** The number of currently-held claims. */
  count(): number {
    return this.#ownerOf.size;
  }

  /** The read-only claim snapshot: every held claim, sorted by instance then jobKey. */
  snapshot(): ClaimSnapshot {
    const claims: Claim[] = [];
    for (const [instance, jobs] of this.#jobsOf) {
      for (const jobKey of jobs) claims.push({ instance, jobKey });
    }
    claims.sort((a, b) => a.instance.localeCompare(b.instance) || a.jobKey.localeCompare(b.jobKey));
    return { claims, count: claims.length };
  }

  /** Drop a worker's reverse-edge entry once it holds no more claims, so the map stays bounded. */
  #pruneInstance(instance: string): void {
    const jobs = this.#jobsOf.get(instance);
    if (jobs && jobs.size === 0) this.#jobsOf.delete(instance);
  }
}

/** The live claim registry from the most recent mount, so the supply report (H5) can read it. */
let currentRegistry: ClaimRegistry | undefined;

/** The mounted claim registry, or undefined before mount / after teardown. */
export function currentClaimRegistry(): ClaimRegistry | undefined {
  return currentRegistry;
}

/** Install the live registry (called by the claim family's `mount`). */
export function setCurrentClaimRegistry(registry: ClaimRegistry | undefined): void {
  currentRegistry = registry;
}
