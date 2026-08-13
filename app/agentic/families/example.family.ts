// nano-workforce — a no-op EXAMPLE agentic family module (ADR 0056, H0 / #143).
//
// This is the concrete, copyable pattern H1 (#144), H3 (#146) and H4 (#147) follow. It lives in the
// discovery directory (`app/agentic/families/`), so the loader ({@link ../loader.ts}) finds it by
// the `*.family.ts` suffix and the H0 seam mounts + tears it down — a genuine registered sample. It
// is a deliberate no-op (no message handler, no state), so mounting it in production is harmless.
//
// To add a real family slice, copy this file to `app/agentic/families/<slice>.family.ts`, rename it,
// and implement `mount` (and optionally `teardown`). That is the WHOLE integration: you add ONE NEW
// FILE and register NOTHING by hand — you never touch `main.ts` or `drainAndExit`.
//
// Reserved forward-only migration prefixes (do NOT compute "the next" number — use your reserved one):
//   - H1 presence   → `db/migrations/023_agentic_presence.sql`
//   - H3 transcript → `db/migrations/024_agentic_transcript.sql`
//   - H4 blackboard → `db/migrations/025_agentic_blackboard.sql` (only if a schema change is needed)
import type { AgenticContext, AgenticFamily } from "../registry.ts";

/**
 * A minimal, no-op family. A real slice would, inside `mount`:
 *   - `ctx.hub.registerFamilyHandler("<family>", (frame, conn) => { … })` to own a message family,
 *   - persist via `ctx.data` (the app's SQLite DataLayer — the same store the blackboard uses),
 *   - attach presence via `ctx.registry.setPresence(conn.id, …)`,
 * and release those in `teardown`.
 */
export const family: AgenticFamily = {
  name: "example",
  mount(_ctx: AgenticContext): void {
    // No-op template. Replace with the slice's real wiring against `_ctx`.
  },
  teardown(): void {
    // No-op template. Release anything `mount` acquired here.
  },
};

export default family;
