// Class guard for the ADR-0065 terminal-edge reader migration (issues #503, #704).
//
// Since ADR-0065 (`@nanobpm/urban@0.81.0`) the `instanceTracking` reconciler is a SOURCE, not a
// writer: on cancel/terminate it feeds urban's instance projection and the terminal edge
// (`onTerminated`) is RECOMPUTED ON READ as `<table>__tracking.derived_status` — it NO LONGER writes
// the terminal (`abandoned`/`failed`/`reviewed`) onto the base `status` column. A classifying reader
// that inspects the BASE `status` column of a DERIVE-ONLY tracked table therefore sees a row frozen at
// its last worker-owned transient after the instance ends → phantom-active / wedged-idempotency bugs
// (the #497 / #503 / #704 class).
//
// This is a SOURCE-SCAN guard over the defect CLASS, not a single instance. It is PARAMETRIZED over
// the three derive-only tracked tables and their admission/idempotency/classifier readers
// (derivation-over-duplication in the test itself, so the whole class is unrepresentable):
//   - `pull_requests` → service.ts, `TERMINAL_STATUSES` (submitPr idempotency, activePrs, incidents,
//     merge lanes, wave gates)
//   - `plans`         → plan.ts,    `PLAN_TERMINAL_STATUSES` (startPlan re-admission, active-by-base)
//   - `feature_runs`  → feature.ts, `FEATURE_TERMINAL_STATUSES` (startFeature INTAKE idempotency — the
//     reader #503 omitted, closed by #704)
// Every terminal-set classification (both the `.includes(x)` and `.some((s) => s === x)` forms) MUST
// read the DERIVED effective status (`.derived_status`), never the frozen base `.status`. A future
// reader — on ANY of the three tables — that silently re-drifts onto the base column fails here; the
// pre-#704 feature intake (`FEATURE_TERMINAL_STATUSES.includes(existing.status)`) would have been red.
//
// Worker-owned terminals that PASS THROUGH the derive edge unchanged (`merged`) are exempt: a base
// `=== "merged"` read is legitimate (see `isDepMerged` / `classifyWaveTarget` / `mergeLaneDecisionForPr`
// in app/service.ts). Only the DERIVE-ONLY terminals (`abandoned`/`failed`/`reviewed`) must route
// through the derived accessor. Writers (`data.table(<table>).update({ status: … })`) are unaffected —
// they still write the base column.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { EFFECTIVE_STATUS_COLUMN } from "./featureReadModel.ts";

const SRC = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

/** Strip line (`//`) and block (`/* … *​/`) comments so the scan only inspects executable code — a
 * doc comment may legitimately mention `.status` in prose without being a classification. The line
 * stripper skips a `//` preceded by `:` so a URL scheme inside a string/template literal (e.g.
 * `https://…` in app/service.ts) is not mistaken for a comment start and does not corrupt the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every expression a `<SET>_TERMINAL_STATUSES` classifies, across BOTH idioms the app uses:
 *  `SET.includes(<expr>)` and `SET.some((s) => s === <expr>)` (and the mirrored `<expr> === s`). One
 *  extractor for both forms so a reader can't dodge the guard by switching idiom. For the `.some`
 *  form we capture the CLASSIFIED OPERAND — the side of `===` that is NOT the arrow parameter — on
 *  either orientation, and assert against that operand rather than the whole arrow body, so an
 *  incidental `.derived_status` reference elsewhere in the body can't mask a base-`.status`
 *  classification. */
function classifiedExprs(code: string, setName: string): string[] {
  const exprs: string[] = [];
  for (const m of code.matchAll(new RegExp(`${setName}\\.includes\\(([^)]*)\\)`, "g"))) {
    exprs.push(m[1]);
  }
  for (const m of code.matchAll(new RegExp(`${setName}\\.some\\(\\(\\s*(\\w+)\\s*\\)\\s*=>\\s*([^)]*)\\)`, "g"))) {
    const param = m[1]; // the arrow parameter, e.g. `s`
    const body = m[2]; // `s === <expr>` or the mirrored `<expr> === s`
    const sides = body.split("===").map((x) => x.trim());
    // Capture the operand compared against the loop parameter, on either side of `===`; fall back to
    // the whole body for any shape we don't recognise so the guard errs toward stricter, not looser.
    if (sides.length === 2 && (sides[0] === param || sides[1] === param)) {
      exprs.push(sides[0] === param ? sides[1] : sides[0]);
    } else {
      exprs.push(body);
    }
  }
  return exprs;
}

/** The derive-only tracked tables and the reader module + terminal-status set that classifies each.
 * ONE registry drives the whole guard so adding a fourth derive-only admission reader is a one-line
 * change, never a copy-pasted test. */
const DERIVE_ONLY_READERS = [
  { table: "pull_requests", file: "service.ts", set: "TERMINAL_STATUSES" },
  { table: "plans", file: "plan.ts", set: "PLAN_TERMINAL_STATUSES" },
  { table: "feature_runs", file: "feature.ts", set: "FEATURE_TERMINAL_STATUSES" },
] as const;

for (const { table, file, set } of DERIVE_ONLY_READERS) {
  test(`class guard: every ${set} classification (${table} admission/idempotency) reads derived_status, not base status`, () => {
    const code = stripComments(SRC(file));
    const exprs = classifiedExprs(code, set);
    assert(exprs.length > 0, `expected ${set} classifications in ${file}`);
    for (const expr of exprs) {
      assert(
        /\.derived_status\b/.test(expr),
        `${set} classifies on \`${expr}\` — the BASE status of the derive-only tracked table \`${table}\`. ` +
          `Route it through the derived tracking view and read \`.derived_status\` (ADR-0065, #503/#704)`,
      );
      assert(
        !/[A-Za-z0-9_)\]]\.status\b/.test(expr),
        `${set} classifies on \`${expr}\` which still reads a base \`.status\` — the terminal edge is ` +
          `derive-only for \`${table}\` (ADR-0065, #503/#704)`,
      );
    }
  });
}

test("class guard: no base `.status === ABANDONED_STATUS` / `.status === \"abandoned\"` read classification in service.ts", () => {
  const code = stripComments(SRC("service.ts"));
  // A READ classification against the derive-only `abandoned` terminal must use `.derived_status`. A
  // base `.status === ABANDONED_STATUS`/`"abandoned"` would miss a derive-only-terminated PR. (Writers
  // use the object-literal form `{ status: ABANDONED_STATUS }`, which this pattern never matches.)
  const bad = [
    ...code.matchAll(/[A-Za-z0-9_)\]]\.status\s*===\s*ABANDONED_STATUS/g),
    ...code.matchAll(/[A-Za-z0-9_)\]]\.status\s*===\s*["']abandoned["']/g),
  ];
  assertEquals(
    bad.length,
    0,
    `a base \`.status\` is compared to the derive-only \`abandoned\` terminal — read \`.derived_status\` off ` +
      `prsTracking instead (ADR-0065, #503): ${bad.map((m) => m[0]).join(", ")}`,
  );
});

test("class guard: the feature read model classifies on derived_status, never the base status column", () => {
  // The feature history read model (app/featureReadModel.ts) buckets a run's pipeline `stage`/
  // `list_bucket` off its status. Under ADR-0065 that must be the terminal-folded `derived_status`
  // (off `feature_runs__tracking`), or a terminated run renders "Implementing" forever. Assert the DSL
  // never references the base `col("status")` for classification and that the effective-status column
  // is the derived one.
  assertEquals(EFFECTIVE_STATUS_COLUMN, "derived_status", "the feature read model's effective status must be the derived column");
  const code = stripComments(SRC("featureReadModel.ts"));
  assert(
    !/col\(\s*["']status["']\s*\)/.test(code),
    'app/featureReadModel.ts still references col("status") — the status-classifying derivations must ' +
      'read col("derived_status") off feature_runs__tracking (ADR-0065, #503)',
  );
  assert(
    /baseTable:\s*FEATURE_READ_MODEL_BASE_TABLE/.test(code) || /feature_runs__tracking/.test(code),
    "the feature read model must be based on the feature_runs__tracking derived VIEW (ADR-0065, #503)",
  );
});
