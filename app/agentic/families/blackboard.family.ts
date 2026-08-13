// nano-workforce — the agentic-channel `blackboard` family (ADR 0056, H4 / #147).
//
// This is H4's ONE new file plugged into the H0 (#143) family-registration seam. It mounts
// `@nanobpm/agentic/blackboard`'s `blackboard` message family on the app-tier hub, backed by the
// SAME `BlackboardStore` — over the SAME app SQLite DataLayer (`ctx.data.source().db`) — that the
// legacy `/app/api/hooks/blackboard` HTTP hook now uses (see `app/blackboard.ts`). One canonical
// store, one table (`agentic_blackboard`), reached two ways: the HTTP side-channel and the agentic
// channel serve the identical per-plan board with no drift surface.
//
// Board scope parity: the family derives each connection's board `scope` from its capability
// credential — the per-plan blackboard token — resolved back to its `plan_key` via
// `planKeyForTokenSync`, EXACTLY as the HTTP hook resolves `?token=` to a plan. So a channel client
// and an HTTP caller holding the same plan token read/write the very same rows. An unknown/absent
// credential yields no scope and the frame is rejected (advisory — never a hard-lock, never gates a
// BPMN sequence flow).
//
// Adds NO migration of its own: H4's reserved `db/migrations/025_agentic_blackboard.sql` (owned by
// the app-side adapter) creates `agentic_blackboard`; `store.ensureSchema()` here is the idempotent
// belt-and-braces the store's own contract expects.
import { attachBlackboardFamily, BlackboardStore } from "@nanobpm/agentic/blackboard";
import type { HubConnection } from "@nanobpm/agentic/channel";
import { planKeyForTokenSync } from "../../blackboard.ts";
import type { AgenticContext, AgenticFamily } from "../registry.ts";

/** The capability-credential a connection presents at the handshake (the blackboard token). */
function credentialOf(conn: HubConnection): string {
  return (conn.handshake.credential ?? conn.handshake.query?.capability ?? "").trim();
}

let handle: { stop(): void } | undefined;

/**
 * The `blackboard` family module. `mount` attaches the family to the hub when the app has a data
 * layer; without one (data isn't mounted) it is a no-op — the channel simply serves no blackboard,
 * exactly as the HTTP hook would 404. `teardown` detaches it.
 */
export const family: AgenticFamily = {
  name: "blackboard",
  mount(ctx: AgenticContext): void {
    const data = ctx.data;
    if (!data) {
      ctx.log.warn("agentic blackboard family: no data layer; not mounting");
      return;
    }
    // Stop any previously-attached family before remounting, so a repeat mount() (tests or a future
    // remount path) can't leave stale handlers attached and double-handle frames / leak resources.
    handle?.stop();
    const db = data.source().db;
    const store = new BlackboardStore(db);
    store.ensureSchema();
    handle = attachBlackboardFamily(ctx.hub, store, {
      // Scope every board to the plan the credential's token maps to — the same plan the HTTP hook
      // scopes to — so the two paths share one board. Returning undefined rejects the frame.
      scopeOf: (conn) => planKeyForTokenSync(db, credentialOf(conn)),
      onError: (err, connectionId) =>
        ctx.log.warn("agentic blackboard family error", { connectionId, err: String(err) }),
    });
    ctx.log.info("agentic blackboard family mounted");
  },
  teardown(): void {
    handle?.stop();
    handle = undefined;
  },
};

export default family;
