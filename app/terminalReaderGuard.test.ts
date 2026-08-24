// Class guard for the ADR-0065 terminal-edge reader migration (issue #503).
//
// Since ADR-0065 (`@nanobpm/urban@0.81.0`) the `instanceTracking` reconciler is a SOURCE, not a
// writer: on cancel/terminate it feeds urban's instance projection and the terminal edge
// (`onTerminated`) is RECOMPUTED ON READ as `<table>__tracking.derived_status` — it NO LONGER writes
// the terminal (`abandoned`/`failed`/`reviewed`) onto the base `status` column. A classifying reader
// that inspects the BASE `status` column of a DERIVE-ONLY tracked table therefore sees a row frozen at
// its last worker-owned transient after the instance ends → phantom-active / wedged-idempotency bugs
// (the #497 / #503 class).
//
// This is a SOURCE-SCAN guard over the defect CLASS, not a single instance: it asserts that every
// terminal/active classification (`TERMINAL_STATUSES.includes` / `=== ABANDONED_STATUS` /
// `PLAN_TERMINAL_STATUSES` / the feature read model's status DSL) for the three derive-only tracked
// tables (`pull_requests`, `plans`, `feature_runs`) reads the DERIVED effective status
// (`.derived_status`), never the frozen base `.status`. A future reader that silently re-drifts onto
// the base column fails here.
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
 * doc comment may legitimately mention `.status` in prose without being a classification. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("class guard: every TERMINAL_STATUSES classification in service.ts reads derived_status, not base status", () => {
  const code = stripComments(SRC("service.ts"));
  const calls = [...code.matchAll(/TERMINAL_STATUSES\.includes\(([^)]*)\)/g)];
  assert(calls.length > 0, "expected TERMINAL_STATUSES.includes classifications in service.ts");
  for (const m of calls) {
    const arg = m[1];
    assert(
      /\.derived_status\b/.test(arg),
      `TERMINAL_STATUSES.includes(${arg}) classifies on the BASE status of a derive-only tracked table — ` +
        `route it through prsTracking and read \`.derived_status\` (ADR-0065, #503)`,
    );
    assert(
      !/[A-Za-z0-9_)\]]\.status\b/.test(arg),
      `TERMINAL_STATUSES.includes(${arg}) still reads a base \`.status\` — the terminal edge is derive-only (#503)`,
    );
  }
});

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

test("class guard: every PLAN_TERMINAL_STATUSES classification in plan.ts reads derived_status, not base status", () => {
  const code = stripComments(SRC("plan.ts"));
  // Match the `.some((s) => s === <ref>)` classification form used at both admission sites.
  const calls = [...code.matchAll(/PLAN_TERMINAL_STATUSES\.some\(\([^)]*\)\s*=>\s*[^)]*===\s*([A-Za-z0-9_.]+)\)/g)];
  assert(calls.length > 0, "expected PLAN_TERMINAL_STATUSES classifications in plan.ts");
  for (const m of calls) {
    const ref = m[1];
    assert(
      /\.derived_status$/.test(ref),
      `PLAN_TERMINAL_STATUSES classification reads \`${ref}\` — route it through plansTracking and read ` +
        `\`.derived_status\` so a derive-only-terminated epic is seen terminal (ADR-0065, #503)`,
    );
  }
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
