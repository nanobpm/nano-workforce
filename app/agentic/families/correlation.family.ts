// nano-workforce — the jobKey ⇄ process/plan correlation family (ADR 0056, H6 / #149).
//
// The closing slice's family module. Like every sibling it plugs into the H0 (#143) seam
// (`../registry.ts`) as ONE NEW FILE and never edits `main.ts`, `drainAndExit`, or any shared boot
// line — the auto-discovery loader (`../loader.ts`) finds it by the `*.family.ts` suffix and the seam
// mounts + tears it down.
//
// Unlike presence/relay it owns NO channel message family: correlation is an app-side observation
// (jobKey ⇄ process-instance / plan), fed by the orchestrator that dispatches agentic jobs, not a new
// wire conversation (the Camunda-8 job protocol is untouched — ADR 0056). So `mount` simply installs a
// fresh {@link CorrelationRegistry} as the process-wide singleton the supply report (H5) reads, and
// `teardown` clears it. The registry is the single canonical join the cockpit uses to line a worker's
// terminal up with "that process instance / this plan".

import { CorrelationRegistry, setCurrentCorrelation } from "../correlation.ts";
import type { AgenticContext, AgenticFamily } from "../registry.ts";

/** The stable family name this module registers under the seam. */
export const CORRELATION_FAMILY = "correlation";

let registry: CorrelationRegistry | undefined;

/** The H6 correlation family: install the correlation registry singleton on mount, clear on teardown. */
export const family: AgenticFamily = {
  name: CORRELATION_FAMILY,

  mount(ctx: AgenticContext): void {
    registry = new CorrelationRegistry();
    setCurrentCorrelation(registry);
    ctx.log.info("agentic correlation mounted", { family: CORRELATION_FAMILY });
  },

  teardown(): void {
    registry = undefined;
    setCurrentCorrelation(undefined);
  },
};

export default family;
