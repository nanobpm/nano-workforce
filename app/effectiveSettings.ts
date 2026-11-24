// The run's EFFECTIVE settings, echoed by every start door (issue #1059).
//
// To check that a start took the settings it asked for, a caller used to run an engine variable
// search and parse JSON-encoded values — and merge intent was split across `autoMerge` and
// `convergeOnly` depending on the run kind. Every start door now returns `effective` (+ `warnings[]`)
// instead.
//
// ONE canonical derivation, and it reads the SEEDED VARIABLE MAP itself — the exact object handed to
// `engine.createInstance` — so the echo cannot drift from what the instance actually carries
// (AGENTS.md "derivation over duplication"). A setting the run kind does not seed is `null`, never a
// guessed default.

import { redactProbeTargetForDisplay } from "./deliveryGraphCompiler.ts";

/** The effective settings of a started run, as seeded on its engine instance. */
export interface EffectiveSettings {
  /** Whether the run converges its PR (feature runs). `null` when the run kind does not seed it. */
  converge: boolean | null;
  /** The canonical positive merge intent. `null` when the run kind does not seed it. */
  autoMerge: boolean | null;
  /** The legacy inverse of `autoMerge` (convergence loops). `null` when not seeded. */
  convergeOnly: boolean | null;
  /** The convergence round budget (convergence loops). `null` when not seeded. */
  maxRounds: number | null;
  /** The readiness-gate targets the run parks on before implementing; `null` when ungated. Each target is
   * REDACTED for display by the canonical {@link redactProbeTargetForDisplay} policy (a `command` probe
   * shows `<redacted>`, an `http` URL has its credentials stripped) — the raw target lives only in the
   * execution seed, never in this public echo. */
  blockedOn: string[] | null;
  /** Steward auto-resolution opt-in. */
  autoResolveEscalations: boolean;
  /** Whether operator custom instructions were seeded, and their (trimmed) length — not the text. */
  customInstructions: { present: boolean; length: number };
  /** The base branch the run targets. `null` when not seeded. */
  baseBranch: string | null;
}

const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function blockedOnOf(probes: unknown): string[] | null {
  if (!Array.isArray(probes) || probes.length === 0) return null;
  const targets: string[] = [];
  for (const p of probes) {
    if (typeof p !== "object" || p === null) continue;
    const kind: unknown = Reflect.get(p, "kind");
    const target: unknown = Reflect.get(p, "target");
    if (typeof target !== "string" || target === "") continue;
    // Fail closed: a probe without a string kind cannot be classified, so its target is redacted.
    targets.push(typeof kind === "string" ? redactProbeTargetForDisplay({ kind, target }) : "<redacted>");
  }
  return targets;
}

/** Derive the effective settings from the variable map seeded on the instance. */
export function deriveEffectiveSettings(seeded: Readonly<Record<string, unknown>>): EffectiveSettings {
  const ci = seeded.customInstructions;
  const text = typeof ci === "string" ? ci : "";
  const base = seeded.baseBranch;
  const maxRounds = seeded.maxRounds;
  return {
    converge: boolOrNull(seeded.converge),
    autoMerge: boolOrNull(seeded.autoMerge),
    convergeOnly: boolOrNull(seeded.convergeOnly),
    maxRounds: typeof maxRounds === "number" ? maxRounds : null,
    blockedOn: blockedOnOf(seeded.readinessProbes),
    autoResolveEscalations: seeded.autoResolveEscalations === true,
    customInstructions: { present: text !== "", length: text.length },
    baseBranch: typeof base === "string" && base !== "" ? base : null,
  };
}

/** The warning for a short-circuited start: the request's settings were NOT applied. */
export const ALREADY_RUNNING_WARNING =
  "a run is already active for this target — the request's settings were NOT applied; the live run keeps its own";

/** The warning for an ADOPTED convergence loop: the live run keeps its own budget/instructions, but a
 * resubmission still reconciles a narrower merge policy, an escalation-steward opt-in, and new
 * dependencies onto it (`submitPrCritical`, app/service.ts), so "NOT applied" would be false there. */
export const ADOPTED_CONVERGENCE_WARNING =
  "a convergence loop is already active for this PR — it was adopted: autoMerge=false/convergeOnly, autoResolveEscalations=true and new dependsOn entries were reconciled onto the live run; maxRounds and customInstructions were NOT applied (the live run keeps its own)";

/** Warn when supplied custom instructions were normalised away (blank) or trimmed. */
export function customInstructionsWarnings(requested: unknown): string[] {
  if (typeof requested !== "string") return [];
  if (requested.trim() === "") return ["customInstructions was blank and was ignored"];
  if (requested.trim() !== requested) return ["customInstructions was trimmed of surrounding whitespace"];
  return [];
}
