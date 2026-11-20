// nano-workforce — the MCP process-tool start admission (issue #976).
//
// The engine's process MCP (`/mcp/processes`) exposes each entry process's message start event as a
// tool (nano-bpm#1499), deriving its `inputSchema` from the start message's data envelope
// (nano-bpm#1738). A tool CALL correlates the start message with a fresh instance whose variables
// are the call's arguments — it does NOT pass through the app's API doors (`operations/start*.ts`),
// so none of their validation, read-model registration, idempotency, or variable seeding has run.
//
// This module is the ONE canonical admission the message-start worker tasks (`pr.start-feature-mcp`,
// `pr.start-plan-mcp`, `pr.start-convergence-mcp` — the first step after each message start) run to
// close that gap: it re-enters the SAME code the API door calls (`admitPlan` + `startFeature` /
// `startPlan` / `submitPr`), so a message-started run is registered, seeded, and deduplicated
// EXACTLY as an API-started one (AGENTS.md "Derivation over duplication"). The canonical starters
// create the real run's instance themselves (on the none start event); the MCP-starter instance
// then terminates (its only job was admission). Idempotency is the starters' own key gate
// (`feature_key` / `plan_key` / `pr_key`), so a duplicate tool call behaves like an `alreadyRunning`
// API re-POST — no second run. (The engine's reserved `businessId` tool argument additionally fences
// a duplicate at the message-start level while the first instance is active.)
//
// Every input arrives UNVALIDATED (the engine validates the call against the envelope-derived
// schema, but a direct `publishMessage` bypasses even that), so each admission validates defensively
// and THROWS on invalid input — the worker task fails into an engine incident, never a silent
// blank-variable run.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { startFeature } from "./feature.ts";
import { type FeatureReadiness, parseFeatureReadiness } from "./featureReadiness.ts";
import { admitPlan, parseIssue, startPlan } from "./plan.ts";
import { clampRounds, MAX_ROUNDS, parsePr, submitPr } from "./service.ts";

/** Read a required non-blank string field, throwing (→ incident) when absent/mistyped. */
function requireString(vars: Record<string, unknown>, field: string, tool: string): string {
  const v = vars[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`${tool}: "${field}" is required and must be a non-blank string`);
  }
  return v.trim();
}

/** Read an optional boolean field; a PRESENT-but-non-boolean value is invalid (→ incident), never
 *  silently coerced (mirrors the API doors' `autoMerge` guard, issue #916). */
function optionalBool(vars: Record<string, unknown>, field: string, tool: string): boolean | undefined {
  const v = vars[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Error(`${tool}: "${field}" must be a boolean (true or false)`);
  return v;
}

/** Read an optional string field; a present-but-non-string value is invalid. */
function optionalString(vars: Record<string, unknown>, field: string, tool: string): string | null {
  const v = vars[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`${tool}: "${field}" must be a string`);
  return v;
}

/** Read an optional string-list field; a present-but-non-list (or non-string-member) value is
 *  invalid. */
function optionalStringList(vars: Record<string, unknown>, field: string, tool: string): string[] | undefined {
  const v = vars[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`${tool}: "${field}" must be an array of strings`);
  }
  return v;
}

/** Admit a message-started SINGLE-issue feature run (`start_feature` tool) through the canonical
 *  `startFeature` path — the same registration, seeding, and idempotency the `startFeature` API
 *  operation performs. Throws on invalid input (→ incident). */
export async function admitFeatureTool(
  data: DataLayer,
  engine: EngineClient,
  variables: Record<string, unknown>,
): Promise<void> {
  const tool = "start_feature";
  const parsed = parseIssue(requireString(variables, "issue", tool));
  if (!parsed) {
    throw new Error(`${tool}: could not parse issue (use owner/repo#123 or an issue URL)`);
  }
  const baseBranch = requireString(variables, "baseBranch", tool);
  const converge = optionalBool(variables, "converge", tool) === true;
  const rawAutoMerge = optionalBool(variables, "autoMerge", tool);
  const autoMerge = converge && rawAutoMerge === true;
  const humanApproval = autoMerge && optionalBool(variables, "humanApproval", tool) === true;
  const autoResolveEscalations = optionalBool(variables, "autoResolveEscalations", tool) === true;
  const customInstructions = optionalString(variables, "customInstructions", tool);
  const allowSharedBase = optionalBool(variables, "allowSharedBase", tool) === true;
  const confirmDefaultBase = optionalBool(variables, "confirmDefaultBase", tool) === true;
  // The intake readiness gate desugars `blockedOn` (+ `consumerPackage`) exactly as the API door
  // does; a malformed gate throws here (→ incident) rather than wedging the preflight at runtime.
  const readiness: FeatureReadiness = parseFeatureReadiness({
    blockedOn: optionalStringList(variables, "blockedOn", tool),
    consumerPackage: variables.consumerPackage,
  });
  const token = process.env.GITHUB_TOKEN ?? "";
  const normalizedBase = await admitPlan(data, parsed.repo, baseBranch, token, {
    allowSharedBase,
    confirmDefaultBase,
  });
  await startFeature(
    data,
    engine,
    parsed,
    normalizedBase,
    converge,
    autoMerge,
    customInstructions,
    { probes: readiness.probes, probeTimeout: readiness.probeTimeout, probePollEvery: readiness.probePollEvery },
    humanApproval,
    autoResolveEscalations,
  );
}

/** Admit a message-started epic (`start_plan_fanout` tool) through the canonical `startPlan`
 *  path. Throws on invalid input (→ incident). */
export async function admitPlanTool(
  data: DataLayer,
  engine: EngineClient,
  variables: Record<string, unknown>,
): Promise<void> {
  const tool = "start_plan_fanout";
  const parsed = parseIssue(requireString(variables, "issue", tool));
  if (!parsed) {
    throw new Error(`${tool}: could not parse issue (use owner/repo#123 or an issue URL)`);
  }
  const baseBranch = requireString(variables, "baseBranch", tool);
  const allowSharedBase = optionalBool(variables, "allowSharedBase", tool) === true;
  const confirmDefaultBase = optionalBool(variables, "confirmDefaultBase", tool) === true;
  const autoResolveEscalations = optionalBool(variables, "autoResolveEscalations", tool) === true;
  const token = process.env.GITHUB_TOKEN ?? "";
  const normalizedBase = await admitPlan(data, parsed.repo, baseBranch, token, {
    allowSharedBase,
    confirmDefaultBase,
    selfPlanKey: parsed.planKey,
  });
  await startPlan(data, engine, parsed, normalizedBase, { autoResolveEscalations });
}

/** Admit a message-started convergence loop (`start_convergence_loop` tool) through the canonical
 *  `submitPr` path. Throws on invalid input (→ incident). */
export async function admitConvergenceTool(
  data: DataLayer,
  engine: EngineClient,
  variables: Record<string, unknown>,
): Promise<void> {
  const tool = "start_convergence_loop";
  const parsed = parsePr(requireString(variables, "pr", tool));
  if (!parsed) {
    throw new Error(`${tool}: could not parse PR (use owner/repo#123 or a PR URL)`);
  }
  const dependsOn = optionalStringList(variables, "dependsOn", tool) ?? [];
  const rawMaxRounds = variables.maxRounds;
  if (rawMaxRounds !== undefined && rawMaxRounds !== null && typeof rawMaxRounds !== "number") {
    throw new Error(`${tool}: "maxRounds" must be an integer`);
  }
  const maxRounds = clampRounds(rawMaxRounds, MAX_ROUNDS);
  const autoMerge = optionalBool(variables, "autoMerge", tool);
  const autoResolveEscalations = optionalBool(variables, "autoResolveEscalations", tool) === true;
  const customInstructions = optionalString(variables, "customInstructions", tool);
  await submitPr(
    data,
    engine,
    parsed,
    dependsOn,
    maxRounds,
    false,
    null,
    false,
    autoResolveEscalations,
    autoMerge,
    null,
    null,
    customInstructions,
  );
}
