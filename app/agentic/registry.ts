// nano-workforce — the agentic-channel family-registration SEAM (ADR 0056, H0 / #143).
//
// This module is OWNED by H0 (the keystone slice). It is the single extension point every sibling
// slice of the agentic-visibility epic (#142) plugs into:
//
//   - H1 presence  (#144) → adds `app/agentic/families/presence.family.ts`
//   - H3 relay     (#146) → adds `app/agentic/families/relay.family.ts`
//   - H4 blackboard(#147) → adds `app/agentic/families/blackboard.family.ts`
//
// A sibling adds ONE NEW FILE under `app/agentic/families/` exporting an {@link AgenticFamily} and
// NOTHING ELSE — it never edits `main.ts`, `drainAndExit`, or any shared boot line. The loader
// ({@link ./loader.ts}) discovers those files by convention (`*.family.ts`) and hands them to this
// registry, so there is no central registration list for siblings to collide on either — the
// shared-file collision the plan review flagged is designed out, not merely relocated.
//
// The registry mounts families on boot (in discovery order) and tears them down in REVERSE order on
// shutdown — the mirror-image lifecycle a stack of resources needs so a later family that depends on
// an earlier one is torn down first.
//
// RESERVED forward-only migration prefixes (H0 pre-allocates these so no two siblings independently
// grab "the next" number — current highest committed prefix is 022):
//   - `db/migrations/023_agentic_presence.sql`   → H1 (#144)
//   - `db/migrations/024_agentic_transcript.sql` → H3 (#146)
//   - `db/migrations/025_agentic_blackboard.sql` → H4 (#147), only if it needs a schema change
//
// Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
// is untouched — the agentic channel is the only new conversation; advisory semantics are preserved
// (a family NEVER hard-locks or gates a BPMN sequence flow).
import type { AgenticHub, ConnectionRegistry, WebSocketChannelTransport } from "@nanobpm/agentic/channel";
import type { DataLayer, Logger } from "@nanobpm/urban";

/**
 * The reusable handle the seam threads to every family module at mount time. A sibling family uses
 * these — and only these — so it never re-mounts the transport, re-authenticates, or reaches into
 * the boot script.
 */
export interface AgenticContext {
  /** The app-tier hub: attach a family message handler via `hub.registerFamilyHandler(...)`. */
  readonly hub: AgenticHub;
  /** The shared connection registry with liveness (presence detail is attached here by H1). */
  readonly registry: ConnectionRegistry;
  /** The listening WebSocket transport bound to the app's OWN port. */
  readonly transport: WebSocketChannelTransport;
  /** The app's SQLite data layer — the same store the advisory blackboard uses (may be absent). */
  readonly data: DataLayer | undefined;
  /** A structured logger for boot/shutdown lifecycle lines. */
  readonly log: Logger;
}

/**
 * One pluggable family module. A sibling slice implements this and exports it (default export, or a
 * named `family` export) from a `*.family.ts` file under `app/agentic/families/`.
 */
export interface AgenticFamily {
  /** A stable, unique name (used for ordering diagnostics, `inspect()`, and teardown logging). */
  readonly name: string;
  /** Attach the family's behaviour to the hub/channel. May be async. */
  mount(ctx: AgenticContext): void | Promise<void>;
  /** Release anything `mount` acquired. Called in REVERSE registration order on shutdown. */
  teardown?(): void | Promise<void>;
}

/**
 * The seam itself: collects registered families, mounts them all on boot (in registration order),
 * and tears them down in reverse on shutdown. Mounting is idempotent-guarded (each family mounts at
 * most once) so a double `mountAll` can never double-attach a handler.
 */
export class AgenticFamilyRegistry {
  readonly #families: AgenticFamily[] = [];
  readonly #mounted: AgenticFamily[] = [];
  #isMounted = false;

  /** Register a family. Rejects a duplicate name so two slices cannot silently claim one slot. */
  register(family: AgenticFamily): void {
    if (this.#isMounted) {
      throw new Error(`cannot register agentic family "${family.name}" after mount`);
    }
    if (this.#families.some((f) => f.name === family.name)) {
      throw new Error(`duplicate agentic family name "${family.name}"`);
    }
    this.#families.push(family);
  }

  /** Register several families at once (the loader hands the discovered set here). */
  registerAll(families: Iterable<AgenticFamily>): void {
    for (const family of families) this.register(family);
  }

  /** The registered family names, in registration order. Surfaced in `inspect()`/logs. */
  names(): string[] {
    return this.#families.map((f) => f.name);
  }

  /** Mount every registered family, in registration order. A no-op if already mounted. */
  async mountAll(ctx: AgenticContext): Promise<void> {
    if (this.#isMounted) return;
    this.#isMounted = true;
    try {
      for (const family of this.#families) {
        await family.mount(ctx);
        // Track post-mount so a failure mid-mount only tears down what actually mounted.
        this.#mounted.push(family);
      }
    } catch (err) {
      // A mid-mount failure must not wedge the registry at #isMounted=true (which would make every
      // later mountAll a silent no-op). Reuse the canonical teardown to reverse the partial mount and
      // reset the flag, leaving the registry clean and re-mountable, then rethrow to the caller.
      await this.teardownAll(ctx.log);
      throw err;
    }
  }

  /**
   * Tear every mounted family down in REVERSE mount order. Each teardown is isolated: a throw is
   * logged (when a logger is supplied) and swallowed so one family's failure cannot strand another's
   * cleanup. Safe to call more than once; the second call is a no-op.
   */
  async teardownAll(log?: Logger): Promise<void> {
    while (this.#mounted.length > 0) {
      const family = this.#mounted.pop();
      if (!family?.teardown) continue;
      try {
        await family.teardown();
      } catch (err) {
        log?.error("agentic family teardown failed", { family: family.name, err: String(err) });
      }
    }
    this.#isMounted = false;
  }
}
