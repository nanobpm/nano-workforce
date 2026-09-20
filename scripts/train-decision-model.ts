// npm run train:decision — fit the tier-3a fixed-answer decision model over NWF's own history.
//
// Loads labelled samples, trains a `DecisionModel` (app/decisionTrain.ts), prints a held-out
// calibration report, and writes the model JSON to app/models/. This is the "measure before climbing
// tiers" step: it tells us whether a zero-infra logistic model over the round summaries is accurate
// enough at usable coverage before anyone reaches for a WASM encoder (3b) or an in-process GGUF (3c).
//
// Sources (auto-detected, override with --source):
//   • sqlite  — the app DB's `rounds` table: text = summary, label = status. Reads via the built-in
//               node:sqlite (no native dep). DB path from NANO_APP_DB_URL (file: URL) or --db.
//   • jsonl   — a file of {"text","label"} lines (--in), for offline experiments / fixtures.
//
// Usage:
//   npm run train:decision -- --source sqlite [--db file:./app.db] [--out app/models/round-status.json]
//   npm run train:decision -- --source jsonl --in data/rounds.jsonl
//
// Prototype scope: this trains and REPORTS. Nothing gates on the model yet — wiring a shadow pass onto
// convergeGate is the deliberate next step, only after the calibration numbers justify it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  if (u.startsWith("file://")) return new URL(u).pathname;
  return u.slice("file:".length);
}

/** rounds.summary → text, rounds.status → label; skip rows missing either. */
function loadFromSqlite(dbPath: string): Sample[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT summary, status FROM rounds WHERE summary IS NOT NULL AND status IS NOT NULL").all();
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

/** Deterministic interleaved split (every k-th row to holdout) — no RNG, so the report is stable. */
function split(samples: Sample[], holdoutFrac: number): { train: Sample[]; test: Sample[] } {
  if (holdoutFrac <= 0 || samples.length < 10) return { train: samples, test: samples };
  const step = Math.max(2, Math.round(1 / holdoutFrac));
  const train: Sample[] = [];
  const test: Sample[] = [];
  for (let i = 0; i < samples.length; i++) {
    (i % step === 0 ? test : train).push(samples[i]);
  }
  return { train: train.length ? train : samples, test: test.length ? test : samples };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source ?? (args.in ? "jsonl" : "sqlite");
  const name = args.name ?? "round-status";
  const out = args.out ?? `app/models/${name}.json`;
  const holdout = args.holdout ? Number(args.holdout) : 0.2;

  let samples: Sample[];
  if (source === "jsonl") {
    if (!args.in) throw new Error("--in <file.jsonl> is required for --source jsonl");
    samples = loadFromJsonl(args.in);
  } else {
    const dbUrl = args.db ?? process.env.NANO_APP_DB_URL ?? "file:./app.db";
    samples = loadFromSqlite(fileUrlToPath(dbUrl));
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

  const { train, test } = split(samples, holdout);
  const opts: TrainOptions = {
    name,
    dim: args.dim ? Number(args.dim) : 4096,
    epochs: args.epochs ? Number(args.epochs) : 300,
  };
  const model = trainDecisionModel(train, opts);
  const report = evaluate(model, test);

  console.log(`\ntrained "${name}" on ${train.length} / held out ${test.length}`);
  console.log(`  accuracy         ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`  coverage         ${(report.coverage * 100).toFixed(1)}%  (auto-acted, did not escalate)`);
  console.log(`  covered accuracy ${(report.coveredAccuracy * 100).toFixed(1)}%  (correct WHEN it acted)`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(model)}\n`);
  console.log(`\nwrote ${out}`);
}

main();
