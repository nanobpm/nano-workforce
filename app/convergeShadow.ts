// Converge-gate shadow scoring (issue #811) — a NON-GATING observer over the deterministic
// `pr.converge-gate` (app/convergeGate.ts).
//
// The deterministic gate is the source of truth: it decides whether a self-reported "converged"
// round may proceed. This module reproduces the Jev / `/v1/score` decision path (app/scoreChoices.ts)
// as a SHADOW: for the same round it derives the gate's own verdict as a canonical LABEL, builds a
// deterministic text view of the gate inputs, optionally scores it with a checked-in tier-3a model,
// and persists BOTH to the `converge_shadow` calibration table. Nothing here ever changes the gate's
// output — the point is to accumulate labelled data + agreement stats so we can measure whether the
// scored model is trustworthy BEFORE granting it any authority.
//
// Graceful degradation is deliberate (option-2, "never a hard requirement"): if no model artifact is
// present, the scored columns are simply omitted — we still record `(features, ground_truth)`, which
// is exactly the labelled dataset the trainer consumes. So the shadow is useful with zero infra and
// zero committed model, and richer once one exists.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DataLayer } from "@nanobpm/urban";
import type { ConvergeGateInput, ConvergeGateResult } from "./convergeGate.ts";
import { type DecisionModel, ESCALATE, scoreChoices } from "./scoreChoices.ts";

/** The three canonical routes a converged-path round can take out of the deterministic gate. These
 *  are the fixed answers the shadow model scores over. */
export const CONVERGE_LABELS = ["converged", "escalate", "ack-retry"] as const;
export type ConvergeLabel = (typeof CONVERGE_LABELS)[number];

/** Derive the gate's own verdict as a canonical label — the ground truth the shadow is measured
 *  against. Mirrors the worker's routing: not blocked → converged; blocked & ack-only → the bounded
 *  agent auto-ack retry (#796); blocked & substantive → human escalation. */
export function deriveGateLabel(result: ConvergeGateResult): ConvergeLabel {
  if (!result.convergeBlocked) return "converged";
  return result.ackOnly ? "ack-retry" : "escalate";
}

/** A deterministic, model-agnostic text view of the gate inputs — the features the shadow scores and
 *  the trainer learns from. Order-stable so identical inputs always yield identical text. */
export function buildShadowText(input: ConvergeGateInput): string {
  const unresolvedAck = input.unresolvedAckThreadCount ?? 0;
  const acked = new Set(input.acknowledgedKeys);
  const unacked = input.suppressedAdvisories.filter((a) => !acked.has(a.key));
  const parts = [
    `unresolved-threads ${input.unresolvedThreadCount}`,
    `unresolved-ack-threads ${unresolvedAck}`,
    `suppressed-advisories ${input.suppressedAdvisories.length}`,
    `unacked-advisories ${unacked.length}`,
  ];
  if (unacked.length > 0) {
    parts.push(`labels ${[...unacked.map((a) => a.label)].sort().join(" ")}`);
  }
  return parts.join(" ; ");
}

/** The shadow observation for one gate decision: the ground truth plus, when a model is loaded, what
 *  the scored decision would have been and whether it agreed. */
export interface ShadowObservation {
  features: string;
  groundTruth: ConvergeLabel;
  modelName?: string;
  shadowAction?: string;
  shadowTopP?: number;
  shadowConfident?: boolean;
  agree?: boolean;
}

/** Pure: compute the shadow observation. When `model` is null the scored fields are omitted (the
 *  graceful path — the labelled row is still captured). */
export function observeConvergeShadow(
  input: ConvergeGateInput,
  result: ConvergeGateResult,
  model: DecisionModel | null,
): ShadowObservation {
  const features = buildShadowText(input);
  const groundTruth = deriveGateLabel(result);
  if (!model) return { features, groundTruth };
  // Restrict the softmax to EXACTLY the fixed converge routes. A model that does not carry all three
  // canonical labels cannot be scored over the converge decision safely: falling back to the model's
  // full label set would let a non-converge label (e.g. `addressed`/`blocked` learned from
  // `rounds.status`) win and be persisted as `shadow_action`, corrupting the calibration. In that
  // case keep the labelled-only observation (scored fields omitted, exactly as when no model loads).
  const hasAllCanonical = CONVERGE_LABELS.every((l) => model.labels.includes(l));
  if (!hasAllCanonical) return { features, groundTruth };
  const decision = scoreChoices(features, model, { allow: [...CONVERGE_LABELS] });
  return {
    features,
    groundTruth,
    modelName: model.name,
    shadowAction: decision.action,
    shadowTopP: decision.top.p,
    shadowConfident: decision.confident,
    agree: decision.action !== ESCALATE && decision.action === groundTruth,
  };
}

const MODEL_URL = new URL("./models/converge-shadow.json", import.meta.url);
let modelCache: DecisionModel | null | undefined;

/** Load the committed shadow model once (cached). Returns null when the artifact is absent or
 *  unreadable — the graceful path. Never throws. */
export function loadConvergeShadowModel(): DecisionModel | null {
  if (modelCache !== undefined) return modelCache;
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(MODEL_URL), "utf8"));
    modelCache = isDecisionModel(parsed) ? parsed : null;
  } catch {
    modelCache = null;
  }
  return modelCache;
}

/** Reset the cache — test-only seam so a fixture model can be injected/cleared. */
export function resetConvergeShadowModelCache(next?: DecisionModel | null): void {
  modelCache = next;
}

const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isFiniteNumRow = (x: unknown, len: number): boolean =>
  Array.isArray(x) && x.length === len && x.every(isFiniteNum);

/** Structural guard for a persisted `DecisionModel` artifact. Validates the COMPLETE shape — not just
 *  that the fields are arrays — so a malformed artifact (mismatched weight rows, a short/ragged row,
 *  a missing/invalid `ngram`/`threshold`/`margin`, or a non-positive `dim`) is rejected here and
 *  `loadConvergeShadowModel` falls back to `null` (the graceful labelled-only path) instead of letting
 *  `scoreChoices` throw mid-scoring — after which `recordConvergeShadow` would swallow the exception
 *  and drop even the labelled row — or persist NaN / always-escalate shadow scores (#812). */
export function isDecisionModel(v: unknown): v is DecisionModel {
  if (!v || typeof v !== "object") return false;
  const m: Record<string, unknown> = { ...v };
  if (m.version !== 1 || typeof m.name !== "string") return false;
  const dim = m.dim;
  if (!isFiniteNum(dim) || !Number.isInteger(dim) || dim <= 0) return false;
  if (m.ngram !== 1 && m.ngram !== 2) return false;
  if (!isFiniteNum(m.threshold) || !isFiniteNum(m.margin)) return false;
  if (!Array.isArray(m.labels) || m.labels.length === 0 || !m.labels.every((l) => typeof l === "string")) {
    return false;
  }
  const nLabels = m.labels.length;
  // One dense weight row per label, each exactly `dim` finite numbers; one finite bias per label.
  if (!Array.isArray(m.weights) || m.weights.length !== nLabels) return false;
  if (!m.weights.every((row) => isFiniteNumRow(row, dim))) return false;
  if (!isFiniteNumRow(m.bias, nLabels)) return false;
  return true;
}

interface ConvergeShadowRow {
  pr_key: string;
  round_no?: number;
  features: string;
  ground_truth: string;
  shadow_action?: string;
  shadow_top_p?: number;
  shadow_confident?: number;
  agree?: number;
  model_name?: string;
  created_at: string;
}

/** Best-effort persist of one shadow observation to `converge_shadow`. Swallows every error: a shadow
 *  failure must NEVER perturb the gate verdict. Returns the row it wrote (or null on failure) for
 *  tests. */
export async function recordConvergeShadow(
  data: DataLayer,
  meta: { prKey: string; round?: number },
  input: ConvergeGateInput,
  result: ConvergeGateResult,
): Promise<ShadowObservation | null> {
  try {
    const obs = observeConvergeShadow(input, result, loadConvergeShadowModel());
    const row: ConvergeShadowRow = {
      pr_key: meta.prKey,
      ...(typeof meta.round === "number" ? { round_no: meta.round } : {}),
      features: obs.features,
      ground_truth: obs.groundTruth,
      ...(obs.shadowAction !== undefined ? { shadow_action: obs.shadowAction } : {}),
      ...(obs.shadowTopP !== undefined ? { shadow_top_p: obs.shadowTopP } : {}),
      ...(obs.shadowConfident !== undefined ? { shadow_confident: obs.shadowConfident ? 1 : 0 } : {}),
      ...(obs.agree !== undefined ? { agree: obs.agree ? 1 : 0 } : {}),
      ...(obs.modelName !== undefined ? { model_name: obs.modelName } : {}),
      created_at: new Date().toISOString(),
    };
    await data.table<ConvergeShadowRow>("converge_shadow", "id").insert(row);
    return obs;
  } catch {
    return null;
  }
}
