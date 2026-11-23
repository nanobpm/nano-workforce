// Guard for the Zeebe output-mapping scope rule (issue #1045).
//
// Zeebe semantics (adopted by the Nano engine in nanobpm/nano-bpm#1717): when an element declares
// `<zeebe:output>` mappings, the variables its completion produces stay LOCAL to the element — only
// the mapped targets reach the parent scope. The models were written against the engine's old
// behaviour (every job-result variable merged upward), so a task that mapped ONE derived output
// silently swallowed its real result: `attempt-merge` returned `mergeStatus: "merged"`, `gw-merge`
// never saw it, and every merge loop escalated a merged PR forever.
//
// The defect class: an element with output mappings whose produced variables are not all passed
// through. The produced set is DERIVED from the canonical contracts, never restated here:
//   • a service task's `io.nanobpm.dataEnvelope.out` `nano:shape` (the worker's declared result);
//   • a user task's static `formId` form — every keyed form component.
// Each produced field must be mapped to a target of the same name (`=x` → `x`; inside the element
// scope `x` resolves to the local result, falling back to the parent value when the result omits it,
// so the pass-through never clobbers an unchanged variable) — UNLESS the element deliberately consumes
// it: the field feeds one of the element's own output sources AND no FEEL expression elsewhere in the
// process reads the name (e.g. the delivery-graph human step folds `note` into `humanNote`).
// The same check runs over COMPILED delivery graphs (deliveryGraphCompiler), whose escalation user
// tasks are the generated twin of the class.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";

const PROCESS_DIR = "resources/processes";
const FORM_DIR = "resources/forms";
const ELEMENT_TAGS =
  "serviceTask|userTask|receiveTask|sendTask|scriptTask|businessRuleTask|intermediateCatchEvent|boundaryEvent|callActivity|task";

function bpmnSources(): Map<string, string> {
  return new Map(
    readdirSync(PROCESS_DIR)
      .filter((f) => f.endsWith(".bpmn"))
      .map((f) => [f, readFileSync(join(PROCESS_DIR, f), "utf8")]),
  );
}

/** Every `nano:shape` across all models (shapes may be declared in one file and referenced in another). */
function shapeFields(sources: Iterable<string>): Map<string, string[]> {
  const shapes = new Map<string, string[]>();
  for (const xml of sources) {
    for (const m of xml.matchAll(/<nano:shape id="([^"]+)"[^>]*>([\s\S]*?)<\/nano:shape>/g)) {
      // Scalar (`nano:extend`) AND reference-valued (`nano:reference`, incl. object lists) fields.
      shapes.set(m[1] ?? "", [...(m[2] ?? "").matchAll(/<nano:(?:extend|reference) name="([^"]+)"/g)].map((f) => f[1] ?? ""));
    }
  }
  return shapes;
}

function formFields(): Map<string, string[]> {
  const forms = new Map<string, string[]>();
  for (const f of readdirSync(FORM_DIR).filter((n) => n.endsWith(".form"))) {
    // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
    const form = JSON.parse(readFileSync(join(FORM_DIR, f), "utf8")) as { id: string; components?: { key?: string }[] };
    forms.set(form.id, (form.components ?? []).flatMap((c) => (c.key ? [c.key] : [])));
  }
  return forms;
}

/** Every FEEL expression in the process outside `element`: `="="…` attributes and condition bodies. */
function feelOutside(xml: string, element: string): string[] {
  const rest = xml.replace(element, "");
  const unescape = (s: string) => s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  return [
    ...[...rest.matchAll(/="(=[^"]*)"/g)].map((f) => unescape(f[1] ?? "")),
    ...[...rest.matchAll(/='(=[^']*)'/g)].map((f) => unescape(f[1] ?? "")),
    ...[...rest.matchAll(/<bpmn:conditionExpression[^>]*>([\s\S]*?)<\/bpmn:conditionExpression>/g)].map((f) => unescape(f[1] ?? "")),
  ];
}

interface Violation {
  readonly where: string;
  readonly missing: readonly string[];
}

/** Pure: the elements whose output mappings drop a produced variable. */
function outputScopeViolations(sources: Map<string, string>, shapes: Map<string, string[]>, forms: Map<string, string[]>) {
  const violations: Violation[] = [];
  let checked = 0;
  for (const [file, xml] of sources) {
    const re = new RegExp(`<bpmn:(${ELEMENT_TAGS}) id="([^"]+)"[^>]*>([\\s\\S]*?)</bpmn:\\1>`, "g");
    for (const m of xml.matchAll(re)) {
      const body = m[3] ?? "";
      const targets = new Set([...body.matchAll(/<zeebe:output source="[^"]*" target="([^"]+)"/g)].map((t) => t[1]));
      if (targets.size === 0) continue; // no output mappings → every result variable propagates
      const env = /dataEnvelope\.out" value="([^"]+)"/.exec(body)?.[1];
      const formId = /formId="([^"]+)"/.exec(body)?.[1];
      const produced = [
        ...(env === undefined ? [] : (shapes.get(env) ?? [`<unknown shape ${env}>`])),
        ...(formId === undefined ? [] : (forms.get(formId) ?? [`<unknown form ${formId}>`])),
      ];
      if (produced.length > 0) checked++;
      const ownSources = [...body.matchAll(/<zeebe:output source="([^"]*)"/g)].map((t) => t[1] ?? "");
      const elsewhere = feelOutside(xml, m[0]);
      const word = (name: string) => new RegExp(`(^|[^\\w.])${name}(?![\\w])`);
      const consumed = (p: string) => ownSources.some((src) => word(p).test(src)) && !elsewhere.some((f) => word(p).test(f));
      const missing = produced.filter((p) => !targets.has(p) && !consumed(p));
      if (missing.length > 0) violations.push({ where: `${file} ${m[1]} #${m[2]}`, missing });
    }
  }
  return { violations, checked };
}

test("#1045: every element with output mappings passes through each variable its contract produces", () => {
  const sources = bpmnSources();
  const { violations, checked } = outputScopeViolations(sources, shapeFields(sources.values()), formFields());
  assert(checked >= 10, `expected to check the merge/convergence/plan elements, checked only ${checked}`);
  assert(
    violations.length === 0,
    `output mappings make these result variables task-local, so downstream never sees them — add ` +
      `<zeebe:output source="=x" target="x" /> for each:\n${violations.map((v) => `  ${v.where}: ${v.missing.join(", ")}`).join("\n")}`,
  );
});

test("#1045: the guard catches a task that maps a derived output but drops its result (attempt-merge shape)", () => {
  const xml = `<nano:shape id="Out"><nano:extend name="mergeStatus" type="string" /></nano:shape>
    <bpmn:serviceTask id="attempt-merge"><zeebe:property name="io.nanobpm.dataEnvelope.out" value="Out" />
    <zeebe:output source="=mergeRetryRound" target="mergeRetryRound" /></bpmn:serviceTask>`;
  const sources = new Map([["t.bpmn", xml]]);
  const { violations } = outputScopeViolations(sources, shapeFields(sources.values()), new Map());
  assert(violations.length === 1 && violations[0]?.missing.join() === "mergeStatus", JSON.stringify(violations));
});

test("#1045: the guard catches a user task that drops its form's decision field", () => {
  const xml = `<bpmn:userTask id="approve"><zeebe:formDefinition formId="f" />
    <zeebe:output source="=0" target="huskRetries" /></bpmn:userTask>`;
  const { violations } = outputScopeViolations(new Map([["t.bpmn", xml]]), new Map(), new Map([["f", ["decision"]]]));
  assert(violations.length === 1 && violations[0]?.missing.join() === "decision", JSON.stringify(violations));
});

test("#1045: compiled delivery graphs pass every escalation form answer through their output mappings", async () => {
  const graph = {
    name: "output-scope guard",
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "senior:a" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "b", kind: "agent", agent: { jobType: "senior:b" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "c", kind: "connector", connector: { target: "slack", dedupeKey: "c-1", payload: { pr: "a.pr" } } },
    ],
    edges: [
      { from: "a.pr", to: "c" },
      { from: "a.pr", to: "b" },
    ],
  } as DeliveryGraph;
  const r = await compileDeliveryGraph(graph);
  assert(r.ok, JSON.stringify(r));
  const sources = new Map([["compiled.bpmn", r.bpmn]]);
  const { violations, checked } = outputScopeViolations(sources, new Map(), formFields());
  assert(checked >= 2, `expected the agents' escalation user tasks to be checked, checked ${checked}`);
  assert(violations.length === 0, violations.map((v) => `${v.where}: ${v.missing.join(", ")}`).join("\n"));
});

test("#1045: the guard catches a dropped reference-valued (object list) result field", () => {
  const xml = `<nano:shape id="Out"><nano:extend name="status" type="string" /><nano:reference name="results" ref="R" list="true" /></nano:shape>
    <bpmn:serviceTask id="t"><zeebe:property name="io.nanobpm.dataEnvelope.out" value="Out" />
    <zeebe:output source="=status" target="status" /></bpmn:serviceTask>`;
  const sources = new Map([["t.bpmn", xml]]);
  const { violations } = outputScopeViolations(sources, shapeFields(sources.values()), new Map());
  assert(violations.length === 1 && violations[0]?.missing.join() === "results", JSON.stringify(violations));
});
