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

import { isSegmentName } from "@nanobpm/agentic/protocol";

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
  // The grammar is exactly `<rank>:<task>` with a SINGLE colon: a further colon (e.g.
  // `senior:feature:extra`) is not this form, so reject it rather than silently deriving `senior`.
  if (task.indexOf(":") !== -1) return undefined;
  // The rank must be a bare SINGLE-SEGMENT routing token (a role like `senior`) — not a dotted,
  // multi-segment token like `implementation.senior`, which would distort demand/supply matching.
  // `isSegmentName` enforces the single-segment `[a-z][a-z0-9-]*` grammar (no dots, no seat marker).
  return isSegmentName(rank) ? rank : undefined;
}

const SERVICE_TASK = /<(?:\w+:)?serviceTask\b[\s\S]*?<\/(?:\w+:)?serviceTask>/g;
const TASK_DEFINITION_TYPE = /<(?:\w+:)?taskDefinition\b[^>]*\btype="([^"]*)"/;
const EXTENSION_ELEMENTS = /<(?:\w+:)?extensionElements\b[\s\S]*?<\/(?:\w+:)?extensionElements>/;
// The engine only honours a `<zeebe:property>` nested inside a `<zeebe:properties>` wrapper (itself
// inside `<bpmn:extensionElements>`). A bare `<zeebe:property>` placed directly under
// `extensionElements` (or `serviceTask`) is ignored, so property-contract scans (the `--auto`
// opt-out) run against THIS wrapper — a misplaced bare property is treated as absent, exactly as the
// engine treats it.
const ZEEBE_PROPERTIES = /<(?:\w+:)?properties\b[\s\S]*?<\/(?:\w+:)?properties>/;
const PROMPT_LINK = /<(?:\w+:)?linkedResource\b[^>]*\blinkName="prompt"/;
// The engine-native AgentTask marker (issue #745): a `<zeebe:agentDefinition agentType="external" />`
// sibling of the `<zeebe:taskDefinition>` inside a `senior:*` agent task's extensionElements. It is
// what makes the element eligible for engine-native AgentInstance minting by the worker harness.
const EXTERNAL_AGENT_MARKER = /<(?:\w+:)?agentDefinition\b[^>]*\bagentType="external"/;
// The `--auto` opt-OUT marker (issue #779): a `<zeebe:property name="io.nanobpm.agentTask.
// autoSubscribe" value="false" />` sibling inside an agent task's extensionElements. It declares the
// task is EXCLUDED from the harness `--auto` reconciliation (which keys on EXTERNAL_AGENT_MARKER) and
// is served only by a worker that explicitly subscribes. The property is inert to the engine. Only
// the exact `value="false"` opts out — any other value auto-subscribes as normal (fail-safe).
const AUTO_SUBSCRIBE_OPTOUT =
  /<(?:\w+:)?property\b[^>]*\bname="io\.nanobpm\.agentTask\.autoSubscribe"[^>]*\bvalue="false"|<(?:\w+:)?property\b[^>]*\bvalue="false"[^>]*\bname="io\.nanobpm\.agentTask\.autoSubscribe"/;

// The label surfaced for an opted-out, unmarked service task whose `<zeebe:taskDefinition>` is
// missing or has an empty `type` (issue #779 drift guard). Such a block cannot be a real
// externally-marked agent task, so the opt-out is drift regardless of the absent type — we surface it
// under a descriptive sentinel rather than letting the dedupe skip swallow it.
export const MALFORMED_OPTOUT_LABEL = "(opted-out task with missing/empty taskDefinition type)";

/**
 * The `<bpmn:extensionElements>…</bpmn:extensionElements>` content of a service-task block, or the
 * empty string when the block has none. Placement-contract scans (issue #745/#779: a marker is only
 * honoured by the engine INSIDE `extensionElements`) run against THIS scope, so a property/marker
 * sitting outside `extensionElements` is treated as absent — the engine ignores it, and so must the
 * guard (an out-of-place external marker cannot "cover" an opt-out).
 */
function extensionElementsOf(block: string): string {
  return block.match(EXTENSION_ELEMENTS)?.[0] ?? "";
}

/**
 * The `<zeebe:properties>…</zeebe:properties>` content nested inside a block's `extensionElements`,
 * or the empty string when absent. The engine only honours `<zeebe:property>` entries INSIDE this
 * wrapper, so the `--auto` opt-out property scan runs against THIS scope — a bare `<zeebe:property>`
 * sitting directly under `extensionElements` (or `serviceTask`) is treated as absent, exactly as the
 * engine treats it, matching the registered/documented shape (`<zeebe:properties>`-nested).
 */
function optOutPropertiesOf(block: string): string {
  return extensionElementsOf(block).match(ZEEBE_PROPERTIES)?.[0] ?? "";
}

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

/**
 * Scan one BPMN document for the job types of PROMPT-BEARING agent service tasks that are MISSING the
 * engine-native AgentTask marker `<zeebe:agentDefinition agentType="external" />` (issue #745). Every
 * deployed `senior:*` agent task must carry the marker so the worker harness mints an AgentInstance
 * for it; a newly-added agent task that forgets it is a silent drift surface (its run never persists
 * durable AgentHistory), so the regression guard fails CI. The marker check is scoped to the block's
 * `<bpmn:extensionElements>` (the engine-honoured PLACEMENT scope, via `extensionElementsOf`) — a
 * marker sitting outside `extensionElements` is ignored by the engine, so it must not "cover" a task
 * here either. Returns the offending task types in first-occurrence order (empty when every agent
 * task is marked).
 */
export function agentTaskTypesMissingExternalMarker(xml: string): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const [block] of xml.matchAll(SERVICE_TASK)) {
    if (!PROMPT_LINK.test(block)) continue;
    if (EXTERNAL_AGENT_MARKER.test(extensionElementsOf(block))) continue;
    const type = block.match(TASK_DEFINITION_TYPE)?.[1];
    if (type === undefined || type.length === 0 || seen.has(type)) continue;
    seen.add(type);
    missing.push(type);
  }
  return missing;
}

/**
 * Scan one BPMN document for the job types of agent service tasks that OPT OUT of the harness
 * `--auto` reconciliation (issue #779) — those carrying `<zeebe:property
 * name="io.nanobpm.agentTask.autoSubscribe" value="false" />` inside their extensionElements. An
 * opted-out task is served ONLY by a worker that explicitly subscribes (`--job-type <type>` / a
 * profile capability), never by `--auto` auto-discovery (which keys on the
 * `<zeebe:agentDefinition agentType="external" />` marker). The property is inert to the engine;
 * only the exact `value="false"` opts out (any other value auto-subscribes, fail-safe). The opt-out
 * scan is scoped to the block's `<zeebe:properties>` wrapper inside `<bpmn:extensionElements>` (the
 * engine-honoured PLACEMENT scope, via `optOutPropertiesOf`) — a bare `<zeebe:property>` sitting
 * directly under `<bpmn:extensionElements>` or `<bpmn:serviceTask>` is ignored by the engine, so it
 * must not be reported as an active opt-out here (this keeps the reader consistent with the
 * placement-scoped drift guard `agentTaskTypesOptedOutMissingExternalMarker`). Returns the
 * distinct opted-out task types in first-occurrence order (empty when no task opts out).
 */
export function agentTaskTypesOptedOutOfAuto(xml: string): string[] {
  const seen = new Set<string>();
  const optedOut: string[] = [];
  for (const [block] of xml.matchAll(SERVICE_TASK)) {
    if (!AUTO_SUBSCRIBE_OPTOUT.test(optOutPropertiesOf(block))) continue;
    const type = block.match(TASK_DEFINITION_TYPE)?.[1];
    if (type === undefined || type.length === 0 || seen.has(type)) continue;
    seen.add(type);
    optedOut.push(type);
  }
  return optedOut;
}

/**
 * Scan one BPMN document for the job types of service tasks that OPT OUT of `--auto` (issue #779) yet
 * are NOT themselves externally-marked agent tasks — i.e. an opt-out property on a block WITHOUT a
 * sibling `<zeebe:agentDefinition agentType="external" />`. An opt-out only makes sense on a real
 * agent task (one that WOULD otherwise be auto-discovered via its external marker); a marker that has
 * drifted onto a host task (e.g. `pr.finalize`, which carries no external marker) or onto one task
 * that merely shares a `taskDefinition` type with a properly-marked sibling is authoring drift. This
 * checks both markers on the SAME service-task block — the opt-out property inside the block's
 * `<zeebe:properties>` wrapper (via `optOutPropertiesOf`, so a bare misplaced `<zeebe:property>` is
 * ignored just as the engine ignores it) and the external marker inside that block's
 * `<bpmn:extensionElements>` (the engine-honoured PLACEMENT scope), so an out-of-place external
 * marker sitting outside `extensionElements` cannot spuriously "cover" the opt-out — so, unlike
 * comparing the deduplicated `agentTaskTypesOptedOutOfAuto` / `agentTaskTypesMissingExternalMarker`
 * lists (the latter only reports PROMPT-BEARING tasks, so a non-prompt host task's opt-out is
 * invisible to it), the drift cannot hide. An opt-out on a block with a missing/empty
 * `<zeebe:taskDefinition>` type (which likewise cannot be a real agent task) is surfaced under a
 * descriptive sentinel BEFORE the external-marker short-circuit — so even a typeless block that
 * carries the external marker is still flagged as malformed drift. Returns the offending task types
 * in first-occurrence order (empty when every opted-out task is a properly-typed, externally-marked
 * agent task).
 */
export function agentTaskTypesOptedOutMissingExternalMarker(xml: string): string[] {
  const seen = new Set<string>();
  const offending: string[] = [];
  for (const [block] of xml.matchAll(SERVICE_TASK)) {
    const ext = extensionElementsOf(block);
    if (!AUTO_SUBSCRIBE_OPTOUT.test(optOutPropertiesOf(block))) continue;
    const type = block.match(TASK_DEFINITION_TYPE)?.[1];
    // A missing/empty type cannot be a real agent task, so an opt-out here is malformed drift
    // REGARDLESS of any external marker — surface it under the sentinel BEFORE the marker
    // short-circuit, so a marked-yet-typeless opt-out is caught rather than passed by the marker.
    if (type === undefined || type.length === 0) {
      if (seen.has(MALFORMED_OPTOUT_LABEL)) continue;
      seen.add(MALFORMED_OPTOUT_LABEL);
      offending.push(MALFORMED_OPTOUT_LABEL);
      continue;
    }
    // A properly-typed opt-out is fine only when the SAME block is externally marked inside its
    // extensionElements (the engine-honoured placement scope).
    if (EXTERNAL_AGENT_MARKER.test(ext)) continue;
    if (seen.has(type)) continue;
    seen.add(type);
    offending.push(type);
  }
  return offending;
}
