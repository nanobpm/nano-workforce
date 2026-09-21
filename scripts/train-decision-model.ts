// npm run train:decision — fit the tier-3a fixed-answer decision model over NWF's own history.
//
// Loads labelled samples, trains a `DecisionModel` (app/decisionTrain.ts), prints a held-out
// calibration report, and writes the model JSON to app/models/. This is the "measure before climbing
// tiers" step: it tells us whether a zero-infra logistic model over the round summaries is accurate
// enough at usable coverage before anyone reaches for a WASM encoder (3b) or an in-process GGUF (3c).
//
// Sources (auto-detected, override with --source):
//   • converge-shadow — the app DB's `converge_shadow` table: text = features, label = ground_truth
//               (converged | escalate | ack-retry — the canonical converge routes). THIS is the
//               source that produces the model the shadow gate consumes
//               (app/convergeShadow.ts → app/models/converge-shadow.json); it defaults --name to
//               `converge-shadow`. Reads via the built-in node:sqlite (no native dep). DB path from
//               NANO_APP_DB_URL (file: URL) or --db.
//   • sqlite  — the app DB's `rounds` table: text = summary, label = status
//               (converged | addressed | waiting | needs_input | blocked). This is a DIFFERENT label
//               space from the converge gate — it trains the `round-status` model, NOT the shadow
//               model, so it cannot produce a usable converge-shadow.json. DB path from
//               NANO_APP_DB_URL (file: URL) or --db.
//   • jsonl   — a file of {"text","label"} lines (--in), for offline experiments / fixtures.
//
// Usage:
//   npm run train:decision -- --source converge-shadow [--db file:./app.db]   # → app/models/converge-shadow.json
//   npm run train:decision -- --source sqlite [--db file:./app.db]            # → app/models/round-status.json
//   npm run train:decision -- --source jsonl --in data/rounds.jsonl
//
// Prototype scope: this trains and REPORTS a calibration model. The converge-gate now observes a
// model in a NON-GATING shadow pass (workers/converge-gate/worker.ts → recordConvergeShadow); the
// model is NOT yet authoritative — nothing gates on it until the calibration numbers justify it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONVERGE_LABELS } from "../app/convergeShadow.ts";
import { evaluate, type Sample, type TrainOptions, trainDecisionModel } from "../app/decisionTrain.ts";

interface Args {
  source?: string;
  db?: string;
  in?: string;
  out?: string;
  name?: string;
  holdout?: string;
  epochs?: string;
  dim?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    Object.assign(args, { [key]: val });
  }
  return args;
}

function fileUrlToPath(u: string): string {
  if (!u.startsWith("file:")) throw new Error(`--db / NANO_APP_DB_URL must be a file: URL, got: ${u}`);
  // Mirror the established datasource-URL handling (scripts/reconcile-contracts.ts): percent-decode
  // the path and strip any `?query`/`#hash` suffix so a SQLite-style URL like `file:./my%20app.db` or
  // `file:./app.db?mode=ro` resolves to the real on-disk path, not a different/nonexistent one.
  if (u.startsWith("file://")) {
    const p = safeDecodeURIComponent(new URL(u).pathname);
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
  }
  const raw = u.slice("file:".length).replace(/[?#].*$/, "");
  const p = safeDecodeURIComponent(raw);
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** rounds.summary → text, rounds.status → label; skip rows missing either. */
function loadFromSqlite(dbPath: string): Sample[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT summary, status FROM rounds WHERE summary IS NOT NULL AND status IS NOT NULL ORDER BY id")
      .all();
    const samples: Sample[] = [];
    for (const row of rows) {
      const text = typeof row.summary === "string" ? row.summary.trim() : "";
      const label = typeof row.status === "string" ? row.status.trim() : "";
      if (text && label) samples.push({ text, label });
    }
    return samples;
  } finally {
    db.close();
  }
}

/** converge_shadow.features → text, converge_shadow.ground_truth → label; skip rows missing either.
 *  This is the labelled dataset the shadow gate (app/convergeShadow.ts) is measured against — its
 *  labels are the canonical converge routes (converged | escalate | ack-retry), so it (not the
 *  `rounds` source) is what produces a usable converge-shadow.json. */
function loadFromConvergeShadow(dbPath: string): Sample[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT features, ground_truth FROM converge_shadow WHERE features IS NOT NULL AND ground_truth IS NOT NULL ORDER BY id",
      )
      .all();
    const samples: Sample[] = [];
    for (const row of rows) {
      const text = typeof row.features === "string" ? row.features.trim() : "";
      const label = typeof row.ground_truth === "string" ? row.ground_truth.trim() : "";
      if (text && label) samples.push({ text, label });
    }
    return samples;
  } finally {
    db.close();
  }
}

function loadFromJsonl(path: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parsed: unknown = JSON.parse(t);
    if (parsed && typeof parsed === "object" && "text" in parsed && "label" in parsed) {
      const rec: Record<string, unknown> = { ...parsed };
      if (typeof rec.text === "string" && typeof rec.label === "string") {
        samples.push({ text: rec.text, label: rec.label });
      }
    }
  }
  return samples;
}

/** Deterministic interleaved split (every k-th row to holdout) — no RNG, so the report is stable.
 *  Returns `inSample: true` when it could not carve out a genuine holdout (holdout disabled, or too
 *  few rows to leave BOTH partitions non-empty) — the caller then reports in-sample rather than
 *  passing off training data as held-out calibration. */
function split(samples: Sample[], holdoutFrac: number): { train: Sample[]; test: Sample[]; inSample: boolean } {
  if (holdoutFrac <= 0 || samples.length < 4) return { train: samples, test: samples, inSample: true };
  const step = Math.max(2, Math.round(1 / holdoutFrac));
  const train: Sample[] = [];
  const test: Sample[] = [];
  for (let i = 0; i < samples.length; i++) {
    (i % step === 0 ? test : train).push(samples[i]);
  }
  if (!train.length || !test.length) return { train: samples, test: samples, inSample: true };
  return { train, test, inSample: false };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source ?? (args.in ? "jsonl" : "sqlite");
  const name = args.name ?? (source === "converge-shadow" ? "converge-shadow" : "round-status");
  const out = args.out ?? `app/models/${name}.json`;
  const holdout = args.holdout ? Number(args.holdout) : 0.2;

  let samples: Sample[];
  if (source === "jsonl") {
    if (!args.in) throw new Error("--in <file.jsonl> is required for --source jsonl");
    samples = loadFromJsonl(args.in);
  } else if (source === "sqlite" || source === "converge-shadow") {
    const dbUrl = args.db ?? process.env.NANO_APP_DB_URL ?? "file:./app.db";
    const dbPath = fileUrlToPath(dbUrl);
    samples = source === "converge-shadow" ? loadFromConvergeShadow(dbPath) : loadFromSqlite(dbPath);
  } else {
    throw new Error(`unknown --source "${source}" (expected: converge-shadow | sqlite | jsonl)`);
  }

  console.log(`loaded ${samples.length} samples from ${source}`);
  const labelCounts = new Map<string, number>();
  for (const s of samples) labelCounts.set(s.label, (labelCounts.get(s.label) ?? 0) + 1);
  console.log("label distribution:", Object.fromEntries([...labelCounts].sort()));

  const distinct = labelCounts.size;
  if (samples.length < 8 || distinct < 2) {
    console.error(
      `\nnot enough data to train (need ≥8 samples across ≥2 labels; have ${samples.length} across ${distinct}).`,
    );
    console.error("Run some convergence loops first, or pass --source jsonl --in <fixture>.");
    process.exitCode = 1;
    return;
  }

  const { train, test, inSample } = split(samples, holdout);
  // A converge-shadow model is scored ONLY over the fixed canonical routes, and `observeConvergeShadow`
  // (app/convergeShadow.ts) SILENTLY IGNORES any model whose labels don't carry all three — falling back
  // to the labelled-only observation. The model's label set comes from the TRAINING partition, so if the
  // deterministic holdout strands a rare route (e.g. a lone `ack-retry`) entirely in `test`, we'd write a
  // two-label `converge-shadow.json` that every live shadow observation discards while this report claims a
  // usable calibration model. Fail loudly without writing rather than emit that dead artifact (#812).
  if (source === "converge-shadow") {
    const trainLabels = new Set(train.map((s) => s.label));
    const missing = CONVERGE_LABELS.filter((l) => !trainLabels.has(l));
    if (missing.length > 0) {
      console.error(
        `\nconverge-shadow needs all canonical labels [${CONVERGE_LABELS.join(", ")}] in the TRAINING partition, ` +
          `but it is missing: ${missing.join(", ")}. A model without every canonical label is silently ignored by ` +
          `observeConvergeShadow, so writing it would produce a live-dead converge-shadow.json. Gather more ` +
          `converge-shadow rows (especially the rare route) and retrain — nothing was written.`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const opts: TrainOptions = {
    name,
    dim: args.dim ? Number(args.dim) : 4096,
    epochs: args.epochs ? Number(args.epochs) : 300,
  };
  const model = trainDecisionModel(train, opts);
  const report = evaluate(model, test);

  const calibrationKind = inSample ? "IN-SAMPLE (not held out)" : "held out";
  console.log(`\ntrained "${name}" on ${train.length} / ${calibrationKind} ${test.length}`);
  if (inSample) {
    console.log("  ⚠ too few samples for a genuine holdout — the figures below are IN-SAMPLE and overstate generalisation.");
  }
  console.log(`  accuracy         ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`  coverage         ${(report.coverage * 100).toFixed(1)}%  (auto-acted, did not escalate)`);
  console.log(`  covered accuracy ${(report.coveredAccuracy * 100).toFixed(1)}%  (correct WHEN it acted)`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(model)}\n`);
  console.log(`\nwrote ${out}`);
}

main();
