// nano-workforce — the deployed-job-type ↔ crew-routing-token bridge (issue #323).
//
// The demand×supply board resolves live SUPPLY through the crew vocab, which emits dot-form routing
// tokens (`implementation.senior`, `planning.spar`, …). But the deployed fleet agent tasks are
// COLON-form job types (`senior:feature`, `senior:retro`, …) — the `<zeebe:taskDefinition type>` the
// engine matches 1:1. The two never string-match, so an advertised agentic demand shows RED (no
// supply) even when a suitably-capable senior worker is enrolled.
//
// This module is the app-tier bridge (design choice 1b): a pure DERIVATION from a deployed agent job
// type to the crew routing token an enrolled worker resolves — NOT a hand-maintained parallel list of
// task types (AGENTS.md: derivation over duplication; issue #323 acceptance §3). The colon in a fleet
// job type is `<rank>:<task>`: the `rank` prefix is a seniority assertion the crew vocab models as a
// bare rank role, and the `task` suffix is a job selector that does not change WHICH worker serves it
// (one senior worker serves every `senior:*` task). So the derivation is: take the rank segment as the
// bare routing token. `senior:retro` and `senior:feature` both derive to the `senior` role a
// weight≥4 worker fills — no per-task role, no drift surface.
//
// The prompt-bearing scan identifies the deployed AGENT tasks (a `<zeebe:linkedResource … linkName=
// "prompt">` on the service task) so a regression guard can enumerate the real demand corpus straight
// from the models and assert every agent job type resolves to a suppliable token.

import { isValidToken } from "@nanobpm/agentic/protocol";

/**
 * Derive the crew routing token an enrolled worker resolves to for a deployed fleet agent job type,
 * or `undefined` when the type is not an agent job type in `<rank>:<task>` colon form (e.g. an
 * ordinary host job like `pr.finalize`, which is already a dot-form token and is left untouched).
 *
 * The rank segment is returned as the bare routing token: `senior:retro` → `senior`. The derivation
 * is purely syntactic — it never enumerates task types — so a newly-added `senior:<task>` is covered
 * automatically by the same rank role, while a new RANK (`principal:*`) that has no crew role surfaces
 * as unsupplied and trips the regression guard.
 */
export function jobTypeToRoutingToken(jobType: string): string | undefined {
  const colon = jobType.indexOf(":");
  if (colon <= 0) return undefined;
  const rank = jobType.slice(0, colon);
  const task = jobType.slice(colon + 1);
  if (task.length === 0) return undefined;
  // The rank must be a valid single-segment routing token (a bare role like `senior`); anything else
  // is not a fleet agent job type this bridge can route.
  return isValidToken(rank) ? rank : undefined;
}

const SERVICE_TASK = /<(?:\w+:)?serviceTask\b[\s\S]*?<\/(?:\w+:)?serviceTask>/g;
const TASK_DEFINITION_TYPE = /<(?:\w+:)?taskDefinition\b[^>]*\btype="([^"]*)"/;
const PROMPT_LINK = /<(?:\w+:)?linkedResource\b[^>]*\blinkName="prompt"/;

/**
 * Scan one BPMN document for the job types of its PROMPT-BEARING service tasks — the deployed fleet
 * AGENT tasks. A task is prompt-bearing iff it carries a `<zeebe:linkedResource … linkName="prompt">`
 * (the base-prompt resource the engine delivers to the agent). Ordinary host jobs (no prompt link)
 * are excluded. Returns the distinct task types in first-occurrence order.
 */
export function promptBearingTaskTypes(xml: string): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  for (const [block] of xml.matchAll(SERVICE_TASK)) {
    if (!PROMPT_LINK.test(block)) continue;
    const type = block.match(TASK_DEFINITION_TYPE)?.[1];
    if (type === undefined || type.length === 0 || seen.has(type)) continue;
    seen.add(type);
    types.push(type);
  }
  return types;
}
