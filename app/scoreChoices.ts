// Fixed-answer scoring — a self-contained (tier-3a), pure-Node decision seam.
//
// Many NWF decisions are bounded: the valid answers are already known (e.g. a converged round's
// status ∈ {converged, addressed, waiting, needs_input, blocked}, or an escalation's category). The
// Jev / SGLang `/v1/score` pattern turns such a call into a SCORE over the known answers instead of
// free-text generation the poller must parse. This module reproduces the *inference path* with ZERO
// new infra: a deterministic feature-hash + a small multinomial-logistic backend whose weights ship
// as a checked-in JSON (trained by `scripts/train-decision-model.ts` over the SQLite history). It is
// the "leanest tier" of the option-3 ladder — no native addon, no model download, no external
// server, sub-millisecond, and deterministic across platforms (so it is testable under the repo's
// "no flaky tests" rule).
//
// The scoring math is a RESTRICTED SOFTMAX over caller-declared choices (exactly the article's
// mechanism): given a text and a candidate label set, normalise only over those labels' logits and
// return a probability distribution. The confidence thresholds + the ESCALATE escape hatch live here
// in tested Node code, NOT in a service — so "auto-act on the confident one, escalate the tied one"
// is a pure function the process can gate on. The backend is a swappable seam (`DecisionBackend`):
// tier-3b (a WASM embedding encoder) or tier-3c (an in-process GGUF via node-llama-cpp) can drop in
// later behind the same interface without changing callers or the softmax/threshold logic.

/** The sentinel action returned when no choice clears the confidence bar — routes to NWF's durable
 *  human escalation instead of forcing probability mass onto an under-supported answer. */
export const ESCALATE = "__escalate__";

/** A trained fixed-answer decision model. Emitted by the trainer, shipped as JSON, loaded at score
 *  time. Pure data — no code, no native handle — so it is diff-reviewable and deterministic. */
export interface DecisionModel {
  version: 1;
  /** Human name of the decision surface, e.g. "round-status" or "escalation-category". */
  name: string;
  /** Class labels; the array index is the class id used by `weights`/`bias`. */
  labels: string[];
  /** Feature-hash dimension (the "hashing trick" output size). */
  dim: number;
  /** Highest n-gram order featurised (1 = unigrams only, 2 = unigrams + bigrams). */
  ngram: 1 | 2;
  /** `weights[label][feature]` — one dense row per class. */
  weights: number[][];
  /** `bias[label]` — per-class intercept. */
  bias: number[];
  /** Default min top-1 probability required to act (else ESCALATE). Overridable per call. */
  threshold: number;
  /** Default min (top − runner-up) probability gap required to act (else ESCALATE). */
  margin: number;
}

/** One label's score in a decision. */
export interface Scored {
  label: string;
  /** Restricted-softmax probability across the scored candidate set (sums to 1 over `scores`). */
  p: number;
  /** Raw pre-softmax logit (backend score). Exposed for calibration/inspection. */
  logit: number;
}

/** The outcome of a fixed-answer decision. */
export interface Decision {
  /** Every scored candidate, sorted by probability descending. */
  scores: Scored[];
  /** The highest-probability candidate. */
  top: Scored;
  /** The second-highest candidate, if the set has ≥2 members. */
  runnerUp?: Scored;
  /** True iff `top` clears both the probability threshold and the margin over `runnerUp`. */
  confident: boolean;
  /** `top.label` when `confident`, else `ESCALATE`. The value the process should route on. */
  action: string;
}

export interface ScoreOptions {
  /** Restrict scoring to this subset of the model's labels (must be a non-empty subset). Softmax is
   *  normalised only over these — the article's "the application already knows the allowed answers".
   *  Omit to score all model labels. */
  allow?: string[];
  /** Override the model's default probability threshold for this call. */
  threshold?: number;
  /** Override the model's default margin for this call. */
  margin?: number;
}

/** A pluggable scoring backend: map a text + candidate labels to a raw logit per candidate. The
 *  tier-3a logistic model below is one implementation; a WASM encoder (3b) or in-process GGUF (3c)
 *  can implement the same shape without touching the restricted-softmax/threshold code. */
export interface DecisionBackend {
  scoreLogits(text: string, labels: string[]): number[];
}

const BIGRAM_SEP = "\u2581"; // an unlikely-in-text separator so "a b" and "a␁b" never collide.

/** FNV-1a 32-bit, using Math.imul for exact 32-bit wraparound — deterministic on every platform. */
function fnv1a(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lowercase alphanumeric tokens; drops punctuation/markdown noise. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Feature-hash a text into a dense, L2-normalised vector of length `dim`. Signed hashing keeps the
 *  expected collision bias near zero. Shared by BOTH training and scoring — one featuriser, no drift
 *  between how the model was fit and how it is applied. */
export function featurize(text: string, dim: number, ngram: 1 | 2): Float64Array {
  const vec = new Float64Array(dim);
  const toks = tokenize(text);
  const add = (feature: string): void => {
    const idx = fnv1a(feature, 0) % dim;
    const sign = fnv1a(feature, 0x9e3779b1) & 1 ? 1 : -1;
    vec[idx] += sign;
  };
  for (let i = 0; i < toks.length; i++) {
    add(toks[i]);
    if (ngram >= 2 && i + 1 < toks.length) add(toks[i] + BIGRAM_SEP + toks[i + 1]);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

/** The tier-3a backend: a multinomial-logistic model over hashed features. Wraps a `DecisionModel`
 *  as a `DecisionBackend`, computing one raw logit (W·x + b) per requested label. */
export function logisticBackend(model: DecisionModel): DecisionBackend {
  const index = new Map(model.labels.map((l, i) => [l, i]));
  return {
    scoreLogits(text: string, labels: string[]): number[] {
      const x = featurize(text, model.dim, model.ngram);
      return labels.map((label) => {
        const li = index.get(label);
        if (li === undefined) throw new Error(`scoreChoices: label "${label}" is not in model "${model.name}"`);
        const w = model.weights[li];
        let dot = model.bias[li];
        for (let j = 0; j < model.dim; j++) dot += w[j] * x[j];
        return dot;
      });
    },
  };
}

/** Restricted softmax over the given logits (numerically stabilised). */
function softmax(logits: number[]): number[] {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

/** Score a text against a fixed set of choices and decide — the module's entry point.
 *
 *  Pass either a `DecisionModel` (uses the built-in tier-3a logistic backend) or any `DecisionBackend`
 *  (tier-3b/3c). `opts.allow` restricts the candidate set (restricted softmax over just those); the
 *  thresholds gate the ESCALATE escape hatch. Pure and deterministic. */
export function scoreChoices(
  text: string,
  modelOrBackend: DecisionModel | DecisionBackend,
  opts: ScoreOptions = {},
): Decision {
  const isModel = "labels" in modelOrBackend && "weights" in modelOrBackend;
  const backend = isModel ? logisticBackend(modelOrBackend) : modelOrBackend;
  const defaults = isModel
    ? { threshold: modelOrBackend.threshold, margin: modelOrBackend.margin, all: modelOrBackend.labels }
    : { threshold: 0.7, margin: 0.2, all: undefined };

  const labels = opts.allow ?? defaults.all;
  if (!labels || labels.length === 0) {
    throw new Error("scoreChoices: no candidate labels (pass opts.allow with a raw backend)");
  }
  const threshold = opts.threshold ?? defaults.threshold;
  const margin = opts.margin ?? defaults.margin;

  const logits = backend.scoreLogits(text, labels);
  const probs = softmax(logits);
  const scores: Scored[] = labels
    .map((label, i) => ({ label, p: probs[i], logit: logits[i] }))
    .sort((a, b) => b.p - a.p);

  const top = scores[0];
  const runnerUp = scores[1];
  const gap = runnerUp ? top.p - runnerUp.p : top.p;
  const confident = top.p >= threshold && gap >= margin;
  return { scores, top, runnerUp, confident, action: confident ? top.label : ESCALATE };
}
