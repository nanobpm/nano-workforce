// Structural guard for the OPERATOR-VISIBILITY wiring of the inter-epic gate (issue #292, slice S4).
// S4 makes a parked dependent observable rather than a silent stall: the `select-wave` worker captures
// the preflight's bound `pkg@version`s off `resolvedArtifacts`, and the epic index/detail pages read
// the derived `wait_gate` projection + the raw `plan_deps` DAG. These pure text assertions lock the
// three surfaces that make that projection reachable end-to-end (the BPMN envelope that feeds the
// capture, and the two page datasources that display it), matching the repo's model-guard style (see
// planFanoutPreflight.test.ts).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";

test("select-wave's input envelope carries resolvedArtifacts so the worker can capture the bound version", () => {
  const bpmn = readFileSync("resources/processes/plan-fanout.bpmn", "utf8");
  const flat = bpmn.replace(/\s+/g, " ");
  const shape = flat.match(/<nano:shape\b[^>]*\bid="SelectWaveIn"[\s\S]*?<\/nano:shape>/);
  assert(shape, "SelectWaveIn envelope must exist");
  assertStringIncludes(
    shape![0],
    'name="resolvedArtifacts"',
    "select-wave must receive the preflight's resolvedArtifacts (the bound pkg@version list)",
  );
  // It is a process var the preflight MI produces — optional so a root (no preflight) is well-formed.
  assertStringIncludes(shape![0], 'name="resolvedArtifacts" type="string" list="true" optional="true"');
});

test("the epics index projects the wait-gate column", () => {
  const page = JSON.parse(readFileSync("pages/epic.page.json", "utf8"));
  const grid = page.nodes.find((n: any) => n.id === "epic-plans");
  assert(grid, "epics index must have the epic-plans grid");
  const cols: string[] = grid.props.columns.map((c: any) => c.field);
  assert(cols.includes("wait_gate_label"), "the index shows the wait-gate at a glance");
});

test("the epic detail projects both the DAG (plan_deps) and the wait-gate state", () => {
  const page = JSON.parse(readFileSync("pages/epic-detail.page.json", "utf8"));
  // 1. The inter-epic DAG: a dataGrid over plan_deps filtered to this epic (who it waits on).
  const dag = page.nodes.find((n: any) => n.id === "inter-epic-deps");
  assert(dag, "epic detail must project the inter-epic dependency DAG");
  assert(dag.props.data.table === "plan_deps", "the DAG grid reads the plan_deps edges");
  assert(
    dag.props.data.filter.some((f: any) => f.field === "plan_key" && f.eqParam),
    "the DAG grid is scoped to this epic's inbound edges",
  );
  const dagCols: string[] = dag.props.columns.map((c: any) => c.field);
  for (const f of ["depends_on_plan_key", "package", "capability_ref"]) {
    assert(dagCols.includes(f), `the DAG grid shows ${f}`);
  }
  // 2. The gate state on the Plan grid: a column + detail fields for the label and bound version.
  const plan = page.nodes.find((n: any) => n.id === "epic-plan");
  const planCols: string[] = plan.props.columns.map((c: any) => c.field);
  assert(planCols.includes("wait_gate_label"), "the Plan grid shows the wait-gate label");
  const detailFields: string[] = plan.props.detail.fields.map((f: any) => f.field);
  assert(detailFields.includes("wait_gate_label"), "the detail explains the gate state");
  assert(detailFields.includes("bound_artifacts"), "the detail shows the bound producer capabilities");
});
