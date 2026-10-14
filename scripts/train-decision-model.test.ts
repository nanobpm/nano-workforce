// Regression coverage for the `train:decision` CLI (scripts/train-decision-model.ts, PR #812).
//
// `node --test` on the app can stay green while this executable regresses, because its own branches —
// source dispatch, the datasource-URL conversion, the deterministic holdout split, the canonical-label
// guard, and the model-file write — were previously unexercised. A regression here could load the wrong
// table or emit a live-dead model with no failing test. These tests drive the (now exported) helpers and
// the argv/env-injectable `main` directly so each of those branches is pinned.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isDecisionModel } from "../app/convergeShadow.ts";
import { assert, assertEquals, assertThrows } from "#test-assert";
import { fileUrlToPath, loadFromConvergeShadow, loadFromJsonl, loadFromSqlite, main, parseArgs, split } from "./train-decision-model.ts";
import type { Sample } from "../app/decisionTrain.ts";

/** Run a body with console.{log,error} silenced so the trainer's progress output doesn't spam the
 *  test log; returns whatever the body returns. */
function quiet<T>(fn: () => T): T {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nwf-train-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a labelled fixture DB with both `converge_shadow` and `rounds`, deliberately using DISJOINT
 *  label spaces so a source-dispatch regression (reading the wrong table) is visible. */
function seedDb(dir: string, shadow: Sample[], rounds: Sample[]): string {
  const dbPath = join(dir, "app.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE converge_shadow (id INTEGER PRIMARY KEY, features TEXT, ground_truth TEXT)");
  db.exec("CREATE TABLE rounds (id INTEGER PRIMARY KEY, summary TEXT, status TEXT)");
  const insS = db.prepare("INSERT INTO converge_shadow (features, ground_truth) VALUES (?, ?)");
  for (const s of shadow) insS.run(s.text, s.label);
  const insR = db.prepare("INSERT INTO rounds (summary, status) VALUES (?, ?)");
  for (const r of rounds) insR.run(r.text, r.label);
  db.close();
  return dbPath;
}

/** ≥8 samples across all three canonical converge routes, enough to train. */
function canonicalShadowSamples(): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < 4; i++) out.push({ text: `resolved all threads round ${i}`, label: "converged" });
  for (let i = 0; i < 4; i++) out.push({ text: `blocked on human decision ${i}`, label: "escalate" });
  for (let i = 0; i < 4; i++) out.push({ text: `advisory not yet acked ${i}`, label: "ack-retry" });
  return out;
}

test("parseArgs reads valued flags and treats a bare flag as boolean-true", () => {
  const args = parseArgs(["--source", "converge-shadow", "--db", "file:./x.db", "--holdout", "0.3", "--verbose"]);
  assertEquals(args.source, "converge-shadow");
  assertEquals(args.db, "file:./x.db");
  assertEquals(args.holdout, "0.3");
  assertEquals((args as Record<string, unknown>).verbose, "true");
});

test("fileUrlToPath decodes percent-escapes and strips a query/hash suffix", () => {
  assertEquals(fileUrlToPath("file:./app.db"), "./app.db");
  assertEquals(fileUrlToPath("file:./my%20app.db"), "./my app.db");
  assertEquals(fileUrlToPath("file:./app.db?mode=ro"), "./app.db");
  assertEquals(fileUrlToPath("file:./app.db#frag"), "./app.db");
});

test("fileUrlToPath rejects a non-file URL", () => {
  assertThrows(() => fileUrlToPath("sqlite://host/app.db"), Error, "must be a file: URL");
});

test("split is a deterministic interleaved holdout that keeps both partitions non-empty", () => {
  const samples: Sample[] = Array.from({ length: 10 }, (_, i) => ({ text: `t${i}`, label: `l${i}` }));
  const a = split(samples, 0.2);
  const b = split(samples, 0.2);
  assertEquals(a.inSample, false);
  assert(a.train.length > 0 && a.test.length > 0, "both partitions populated");
  assertEquals(a.train.length + a.test.length, samples.length);
  assertEquals(a.test.map((s) => s.text), b.test.map((s) => s.text), "deterministic across calls");
});

test("split falls back to in-sample when holdout is disabled or too few rows", () => {
  const few: Sample[] = [{ text: "a", label: "x" }, { text: "b", label: "y" }];
  assertEquals(split(few, 0.2).inSample, true);
  const ten: Sample[] = Array.from({ length: 10 }, (_, i) => ({ text: `t${i}`, label: "x" }));
  assertEquals(split(ten, 0).inSample, true);
});

test("loaders read their own table and skip rows missing text or label", () => {
  withTmpDir((dir) => {
    const dbPath = seedDb(
      dir,
      [{ text: "shadow one", label: "converged" }, { text: "shadow two", label: "escalate" }],
      [{ text: "round one", label: "addressed" }],
    );
    // A blank feature must be skipped.
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO converge_shadow (features, ground_truth) VALUES (?, ?)").run("   ", "converged");
    db.close();

    const shadow = loadFromConvergeShadow(dbPath);
    assertEquals(shadow.length, 2, "blank-feature row skipped; rounds not mixed in");
    assertEquals(shadow.map((s) => s.label).sort(), ["converged", "escalate"]);

    const rounds = loadFromSqlite(dbPath);
    assertEquals(rounds, [{ text: "round one", label: "addressed" }], "reads rounds, not converge_shadow");
  });
});

test("loadFromJsonl parses well-formed lines, skips blanks, and drops objects missing a field", () => {
  withTmpDir((dir) => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, ['{"text":"a","label":"converged"}', "", '{"text":"b"}', '{"text":"c","label":"escalate"}'].join("\n"));
    assertEquals(loadFromJsonl(p), [{ text: "a", label: "converged" }, { text: "c", label: "escalate" }]);
  });
});

test("main dispatches converge-shadow and writes a structurally valid model", () => {
  withTmpDir((dir) => {
    const dbPath = seedDb(dir, canonicalShadowSamples(), []);
    const out = join(dir, "converge-shadow.json");
    const code = quiet(() => main(["--source", "converge-shadow", "--db", `file:${dbPath}`, "--out", out, "--holdout", "0", "--epochs", "30"]));
    assertEquals(code, 0);
    const model: unknown = JSON.parse(readFileSync(out, "utf8"));
    assert(isDecisionModel(model), "written artifact passes the full structural guard");
    const labels = (model as { labels: string[] }).labels;
    for (const l of ["converged", "escalate", "ack-retry"]) assert(labels.includes(l), `label ${l} present`);
  });
});

test("main refuses to write a converge-shadow model missing a canonical label", () => {
  withTmpDir((dir) => {
    const twoLabel: Sample[] = [];
    for (let i = 0; i < 5; i++) twoLabel.push({ text: `resolved ${i}`, label: "converged" });
    for (let i = 0; i < 5; i++) twoLabel.push({ text: `blocked ${i}`, label: "escalate" });
    const dbPath = seedDb(dir, twoLabel, []);
    const out = join(dir, "converge-shadow.json");
    const code = quiet(() => main(["--source", "converge-shadow", "--db", `file:${dbPath}`, "--out", out, "--holdout", "0"]));
    assertEquals(code, 1, "canonical-label guard fails the run");
    assertThrows(() => readFileSync(out, "utf8"), Error, "ENOENT");
  });
});

test("main returns 1 (no throw, no write) when there is not enough data", () => {
  withTmpDir((dir) => {
    const dbPath = seedDb(dir, [{ text: "only one", label: "converged" }], []);
    const out = join(dir, "converge-shadow.json");
    const code = quiet(() => main(["--source", "converge-shadow", "--db", `file:${dbPath}`, "--out", out]));
    assertEquals(code, 1);
    assertThrows(() => readFileSync(out, "utf8"), Error, "ENOENT");
  });
});

test("main throws on an unknown source and on jsonl without --in", () => {
  assertThrows(() => quiet(() => main(["--source", "nope"])), Error, 'unknown --source "nope"');
  assertThrows(() => quiet(() => main(["--source", "jsonl"])), Error, "--in <file.jsonl> is required");
});

test("main reads NANO_APP_DB_URL from the injected env when --db is absent", () => {
  withTmpDir((dir) => {
    const dbPath = seedDb(dir, canonicalShadowSamples(), []);
    const out = join(dir, "converge-shadow.json");
    const code = quiet(() =>
      main(["--source", "converge-shadow", "--out", out, "--holdout", "0", "--epochs", "30"], { NANO_APP_DB_URL: `file:${dbPath}` }),
    );
    assertEquals(code, 0, "env-provided DB URL is honoured");
  });
});
