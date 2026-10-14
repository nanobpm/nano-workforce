// Pure multinomial-logistic trainer for the tier-3a fixed-answer decision seam (app/scoreChoices.ts).
//
// Fits a `DecisionModel` from labelled `{text, label}` samples with deterministic full-batch gradient
// descent (softmax cross-entropy + L2). "Deterministic" is load-bearing: zero-initialised weights and
// a fixed epoch schedule mean the same samples always yield byte-identical weights, so the model is a
// reviewable diff and its accuracy is a stable test assertion (no seeds, no flakiness). It reuses the
// runtime `featurize` from scoreChoices.ts — ONE featuriser for fit and inference, so there is no
// train/serve skew.
//
// `evaluate` reports the calibration story that decides whether tier-3a is good enough before we ever
// consider the heavier tiers: overall argmax accuracy, plus COVERAGE (how often the model is
// confident enough to auto-act) and COVERED ACCURACY (how often it is RIGHT when it does). A tier-3a
// model earns authority only if covered accuracy is high at usable coverage; otherwise we climb to 3b/3c.

import { type DecisionModel, ESCALATE, featurize, scoreChoices } from "./scoreChoices.ts";

export interface Sample {
  text: string;
  label: string;
}

export interface TrainOptions {
  name: string;
  dim?: number;
  ngram?: 1 | 2;
  epochs?: number;
  lr?: number;
  l2?: number;
  threshold?: number;
  margin?: number;
}

export interface EvalReport {
  n: number;
  /** Argmax accuracy over all samples (ignores confidence). */
  accuracy: number;
  /** Fraction of samples the model was confident enough to auto-act on (did not ESCALATE). */
  coverage: number;
  /** Accuracy AMONG the covered (auto-acted) samples — the number that must be high to grant authority. */
  coveredAccuracy: number;
  /** `confusion[actual][predicted]` argmax counts. */
  confusion: Record<string, Record<string, number>>;
}

/** Distinct labels in stable sorted order → deterministic class ids. */
function deriveLabels(samples: Sample[]): string[] {
  return [...new Set(samples.map((s) => s.label))].sort();
}

/** Fit a `DecisionModel`. Deterministic for a given `(samples, options)`. */
export function trainDecisionModel(samples: Sample[], options: TrainOptions): DecisionModel {
  if (samples.length === 0) throw new Error("trainDecisionModel: no samples");
  const dim = options.dim ?? 4096;
  const ngram = options.ngram ?? 2;
  const epochs = options.epochs ?? 300;
  const lr = options.lr ?? 0.5;
  const l2 = options.l2 ?? 1e-4;
  const labels = deriveLabels(samples);
  const K = labels.length;
  if (K < 2) throw new Error(`trainDecisionModel: need ≥2 distinct labels, got ${K}`);
  const labelIndex = new Map(labels.map((l, i) => [l, i]));

  // Pre-featurise once (features are static across epochs).
  const X = samples.map((s) => featurize(s.text, dim, ngram));
  const y = samples.map((s) => {
    const li = labelIndex.get(s.label);
    if (li === undefined) throw new Error(`unreachable: label ${s.label}`);
    return li;
  });

  const W: number[][] = Array.from({ length: K }, () => new Array<number>(dim).fill(0));
  const b: number[] = new Array<number>(K).fill(0);
  const n = samples.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW: number[][] = Array.from({ length: K }, () => new Array<number>(dim).fill(0));
    const gradB: number[] = new Array<number>(K).fill(0);

    for (let s = 0; s < n; s++) {
      const x = X[s];
      const logits = new Array<number>(K);
      for (let k = 0; k < K; k++) {
        let dot = b[k];
        const wk = W[k];
        for (let j = 0; j < dim; j++) dot += wk[j] * x[j];
        logits[k] = dot;
      }
      let max = -Infinity;
      for (const v of logits) if (v > max) max = v;
      let sum = 0;
      const p = new Array<number>(K);
      for (let k = 0; k < K; k++) {
        p[k] = Math.exp(logits[k] - max);
        sum += p[k];
      }
      for (let k = 0; k < K; k++) {
        const err = p[k] / sum - (k === y[s] ? 1 : 0);
        gradB[k] += err;
        const gwk = gradW[k];
        for (let j = 0; j < dim; j++) gwk[j] += err * x[j];
      }
    }

    for (let k = 0; k < K; k++) {
      b[k] -= lr * (gradB[k] / n);
      const wk = W[k];
      const gwk = gradW[k];
      for (let j = 0; j < dim; j++) wk[j] -= lr * (gwk[j] / n + l2 * wk[j]);
    }
  }

  return {
    version: 1,
    name: options.name,
    labels,
    dim,
    ngram,
    weights: W,
    bias: b,
    threshold: options.threshold ?? 0.7,
    margin: options.margin ?? 0.2,
  };
}

/** Score a held-out set and report argmax accuracy + the confidence/coverage calibration numbers. */
export function evaluate(model: DecisionModel, samples: Sample[]): EvalReport {
  const confusion: Record<string, Record<string, number>> = {};
  for (const a of model.labels) {
    confusion[a] = {};
    for (const p of model.labels) confusion[a][p] = 0;
  }
  let correct = 0;
  let covered = 0;
  let coveredCorrect = 0;
  for (const s of samples) {
    const d = scoreChoices(s.text, model);
    const predicted = d.top.label;
    if (confusion[s.label]) confusion[s.label][predicted] += 1;
    if (predicted === s.label) correct += 1;
    if (d.action !== ESCALATE) {
      covered += 1;
      if (d.action === s.label) coveredCorrect += 1;
    }
  }
  const n = samples.length;
  return {
    n,
    accuracy: n ? correct / n : 0,
    coverage: n ? covered / n : 0,
    coveredAccuracy: covered ? coveredCorrect / covered : 0,
    confusion,
  };
}
