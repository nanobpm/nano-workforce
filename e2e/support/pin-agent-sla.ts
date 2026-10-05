// Isolate the agent-SLA e2e suite from ambient `NANO_PR_AGENT_SLA_TIMEOUT`.
//
// `app/agentSla.ts` resolves its `AGENT_SLA_TIMEOUT` constant ONCE, at import time, from the ambient
// `NANO_PR_AGENT_SLA_TIMEOUT` env (through the typed env schema). That frozen constant is what every
// process start seeds as the `agentSlaTimeout` process variable — including the app-booted feature
// run, whose `app/feature.ts` imports the same const. So the SLA the boundary fires on is whatever
// env was present when the module graph loaded, NOT a value the test can set in a `before` hook.
//
// If a CI box or a developer shell exports e.g. `NANO_PR_AGENT_SLA_TIMEOUT=PT30M`, the suite's
// "under SLA" advance (shorter than the default PT2H) would suddenly EXCEED the SLA and fire the
// boundary; with `PT4H` the "past SLA" advance would no longer reach it. Either way the suite fails
// for a reason that has nothing to do with the code under test — a non-deterministic,
// ambient-config-driven failure (AGENTS.md: "no such thing as flaky tests").
//
// This module pins a FIXED duration BEFORE `app/agentSla.ts` can be evaluated, so the frozen const
// is deterministic regardless of the ambient env. `agent-sla-boundary.e2e.ts` imports it FIRST (no
// support module nor the engine testkit imports `app/agentSla.ts`, so this side effect lands before
// that module's const is computed). Both the direct-instance seeds and the advance thresholds derive
// from the SAME pinned duration, so they can never drift apart.

/** The fixed agent SLA this suite runs against (ISO-8601 duration), pinned into the env before any
 * app module reads it. Kept equal to the production default `DEFAULT_AGENT_SLA_TIMEOUT` (PT2H). */
export const PINNED_AGENT_SLA = "PT2H";

process.env.NANO_PR_AGENT_SLA_TIMEOUT = PINNED_AGENT_SLA;

/** Parse the subset of ISO-8601 durations this suite uses (`PT#H#M#S`) to milliseconds. Throws on an
 * unparseable value so a mistyped pin fails loudly rather than silently yielding a 0ms threshold. */
function isoDurationToMs(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match || (!match[1] && !match[2] && !match[3])) {
    throw new Error(`pin-agent-sla: cannot parse pinned duration "${iso}" (expected PT#H#M#S)`);
  }
  const [, h, m, s] = match;
  return ((Number(h ?? 0) * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0)) * 1000;
}

/** The pinned SLA in ms — the single source both advance thresholds derive from. */
export const PINNED_AGENT_SLA_MS = isoDurationToMs(PINNED_AGENT_SLA);

/** Comfortably PAST the SLA (1.5×) so the agent boundary fires, yet well under the downstream
 * human-escalation SLA (PT24H) so that one stays dormant — isolating the agent-SLA arm. */
export const PAST_AGENT_SLA_MS = Math.round(PINNED_AGENT_SLA_MS * 1.5);

/** Comfortably UNDER the SLA (0.25×) so the boundary is proven genuinely armed on the seeded
 * duration, not firing spuriously. */
export const UNDER_AGENT_SLA_MS = Math.round(PINNED_AGENT_SLA_MS * 0.25);
