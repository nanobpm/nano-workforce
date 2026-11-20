// API-conventions guard (Part of #972 — normalise the nwf API with the Camunda Orchestration
// Cluster API). See docs/api-conventions.md for the rules this enforces.
//
// Parses the served `openapi.yaml` with the SAME `@nanobpm/urban` walker the runtime uses
// (`parseSpec` + `collectOperations`) and flags:
//   1. `key:` — an engine-entity field/parameter that is not the Camunda name (denylisted synonyms
//      such as `processKey`/`process_key`/`instanceKey`, or a non-canonical spelling of a canonical
//      key such as `process_instance_key`).
//   2. `list:` — a list response lacking an `items` array + `page.totalItems`.
// Fields marked `deprecated: true` are NOT exempt: they count until removed.
//
// Ratchet mode: today's violations are frozen in `apiConventions.baseline.json`. A NEW violation
// fails; a baselined violation that disappeared also fails until the baseline is shrunk. Regenerate
// the baseline deliberately with `NWF_API_BASELINE_WRITE=1 node --experimental-strip-types --test
// app/apiConventions.test.ts` (test-only switch, not a runtime config key).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectOperations, type OpenApiDoc, type OperationInfo, parseSpec, validateValue } from "@nanobpm/urban/toolkit";
import { assert } from "#test-assert";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SPEC_PATH = join(ROOT, "openapi.yaml");
const BASELINE_PATH = join(ROOT, "app", "apiConventions.baseline.json");

/** Canonical Camunda engine keys + nwf entity keys — always allowed. */
export const CANONICAL_KEYS: readonly string[] = [
  "processInstanceKey",
  "processDefinitionKey",
  "processDefinitionId",
  "elementInstanceKey",
  "jobKey",
  "userTaskKey",
  "incidentKey",
  "tenantId",
  "prKey",
  "featureKey",
  "planKey",
  "runKey",
  "agentInstanceKey",
];

/** Known non-canonical synonyms for engine entities. */
export const DENIED_KEYS: readonly string[] = [
  "processKey",
  "process_key",
  "instanceKey",
  "instance_key",
  "piKey",
  "processInstanceId",
  "process_instance_id",
  "instanceId",
  "bpmnProcessId",
  "taskKey",
  "task_key",
  "definitionKey",
  "processDefKey",
  "incidentId",
  "jobId",
];

/** List operations named by #972 — always checked, even if not detected generically. */
export const NAMED_LIST_OPS: readonly string[] = [
  "listActivePrs",
  "listEscalations",
  "listIncidents",
  "listAutoResolutions",
  "getLineage",
  "listAgentInstances",
  "getAgentInstanceHistory",
  "listStagedProposals",
  "listLibrary",
  "readBlackboard",
];

const norm = (s: string): string => s.replaceAll("_", "").toLowerCase();
const CANONICAL_NORM = new Map(CANONICAL_KEYS.map((k) => [norm(k), k]));

/** Non-null reason when `name` is a non-canonical engine-entity key. */
export function keyViolation(name: string): string | null {
  if (CANONICAL_KEYS.includes(name)) return null;
  if (DENIED_KEYS.includes(name)) return "denylisted synonym";
  const canon = CANONICAL_NORM.get(norm(name));
  if (canon !== undefined) return `non-canonical spelling of ${canon}`;
  return null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function resolve(doc: OpenApiDoc, node: unknown, seen: Set<string>): Json | undefined {
  let cur = node;
  while (isObj(cur) && typeof cur.$ref === "string") {
    const ref = cur.$ref;
    if (seen.has(ref)) return undefined;
    seen.add(ref);
    const name = ref.replace("#/components/schemas/", "");
    cur = doc.components?.schemas?.[name];
  }
  return isObj(cur) ? cur : undefined;
}

/** Walk a schema, reporting every property name with its dotted path. */
function walkProps(doc: OpenApiDoc, node: unknown, path: string, out: (p: string, name: string) => void, seen = new Set<string>()): void {
  const s = resolve(doc, node, new Set(seen));
  if (!s) return;
  const nextSeen = new Set(seen);
  if (isObj(node) && typeof node.$ref === "string") nextSeen.add(node.$ref);
  if (isObj(s.properties)) {
    for (const [name, child] of Object.entries(s.properties)) {
      out(path, name);
      walkProps(doc, child, path ? `${path}.${name}` : name, out, nextSeen);
    }
  }
  if (s.items !== undefined) walkProps(doc, s.items, `${path}[]`, out, nextSeen);
  if (isObj(s.additionalProperties)) walkProps(doc, s.additionalProperties, `${path}{}`, out, nextSeen);
  for (const comb of ["allOf", "oneOf", "anyOf"]) {
    const arr = s[comb];
    if (Array.isArray(arr)) for (const c of arr) walkProps(doc, c, path, out, nextSeen);
  }
}

/** Top-level (merged allOf) properties of a resolved object schema. */
function topProps(doc: OpenApiDoc, node: unknown): Record<string, unknown> {
  const s = resolve(doc, node, new Set());
  if (!s) return {};
  let props: Record<string, unknown> = isObj(s.properties) ? { ...s.properties } : {};
  if (Array.isArray(s.allOf)) for (const c of s.allOf) props = { ...props, ...topProps(doc, c) };
  return props;
}

const isArraySchema = (doc: OpenApiDoc, node: unknown): boolean => resolve(doc, node, new Set())?.type === "array";

function successSchemas(op: OperationInfo): unknown[] {
  return op.responseSchemas.filter((r) => r.status.startsWith("2") && r.schema !== undefined).map((r) => r.schema);
}

function listViolation(doc: OpenApiDoc, op: OperationInfo): string | null {
  const schemas = successSchemas(op);
  // Fail closed: a list op with no 2xx response schema declares neither items nor page.totalItems.
  if (schemas.length === 0) return `list:${op.operationId}`;
  for (const schema of schemas) {
    const props = topProps(doc, schema);
    const hasItems = props.items !== undefined && isArraySchema(doc, props.items);
    const page = topProps(doc, props.page);
    if (!hasItems || page.totalItems === undefined) return `list:${op.operationId}`;
  }
  return null;
}

/** A response is a list response if named by #972, or generically by operationId: `list*` /
 * `search*` (Camunda's collection verbs). Single-resource GETs that merely embed an array are not. */
function isListOp(op: OperationInfo): boolean {
  return NAMED_LIST_OPS.includes(op.operationId) || /^(list|search)[A-Z]/.test(op.operationId);
}

export function collectViolations(doc: OpenApiDoc): string[] {
  const found = new Set<string>();
  for (const op of collectOperations(doc)) {
    const id = op.operationId;
    for (const p of op.parameters) {
      const why = keyViolation(p.name);
      if (why) found.add(`key:${id}:${p.in}:${p.name}`);
    }
    const report = (where: string) => (path: string, name: string) => {
      if (keyViolation(name)) found.add(`key:${id}:${where}${path ? `.${path}` : ""}:${name}`);
    };
    if (op.requestBodySchema !== undefined) walkProps(doc, op.requestBodySchema, "", report("request"));
    for (const r of op.responseSchemas) if (r.schema !== undefined) walkProps(doc, r.schema, "", report(`response${r.status}`));
    if (isListOp(op)) {
      const v = listViolation(doc, op);
      if (v) found.add(v);
    }
  }
  return [...found].sort();
}

const doc = (): OpenApiDoc => parseSpec(readFileSync(SPEC_PATH, "utf8"));

test("keyViolation: canonical keys pass, synonyms and respellings fail", () => {
  for (const k of CANONICAL_KEYS) assert(keyViolation(k) === null, k);
  for (const k of ["processKey", "process_key", "instanceKey", "process_instance_key", "JobKey", "tenant_id"]) {
    assert(keyViolation(k) !== null, `${k} should be a violation`);
  }
  assert(keyViolation("title") === null, "unrelated field");
});

test("list detection: items + page.totalItems required; deprecated fields still count", () => {
  const spec = parseSpec(`
openapi: 3.0.3
info: { title: t, version: "1" }
paths:
  /good:
    get:
      operationId: listGood
      responses:
        "200":
          description: ok
          content: { application/json: { schema: { $ref: "#/components/schemas/Good" } } }
  /bad:
    get:
      operationId: listBad
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  rows: { type: array, items: { type: object, properties: { processKey: { type: string, deprecated: true } } } }
  /schemaless:
    get:
      operationId: listSchemaless
      responses:
        "200":
          description: ok
components:
  schemas:
    Good:
      type: object
      properties:
        items: { type: array, items: { type: object, properties: { processInstanceKey: { type: string } } } }
        page: { type: object, properties: { totalItems: { type: integer } } }
`);
  const v = collectViolations(spec);
  assert(v.includes("list:listBad"), JSON.stringify(v));
  assert(v.includes("key:listBad:response200.rows[]:processKey"), JSON.stringify(v));
  assert(v.includes("list:listSchemaless"), JSON.stringify(v));
  assert(!v.some((x) => x.includes("listGood")), JSON.stringify(v));
});

test("openapi.yaml conforms to the API conventions (ratchet against baseline)", () => {
  const current = collectViolations(doc());
  if (process.env.NWF_API_BASELINE_WRITE === "1") {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ violations: current }, null, 2)}\n`);
  }
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const baseline: string[] =
    isObj(parsed) && Array.isArray(parsed.violations) ? parsed.violations.filter((x): x is string => typeof x === "string") : [];
  const added = current.filter((v) => !baseline.includes(v));
  const fixed = baseline.filter((v) => !current.includes(v));
  assert(added.length === 0, `NEW API-convention violations (see docs/api-conventions.md):\n  ${added.join("\n  ")}`);
  assert(
    fixed.length === 0,
    `baselined violations no longer present — shrink app/apiConventions.baseline.json:\n  ${fixed.join("\n  ")}`,
  );
});

test("the named #972 list operations all exist in the spec", () => {
  const ids = new Set(collectOperations(doc()).map((o) => o.operationId));
  const missing = NAMED_LIST_OPS.filter((id) => !ids.has(id));
  assert(missing.length === 0, `missing list ops: ${missing.join(", ")}`);
});

// PR #980 review: the four acknowledgement request bodies carry a canonical key plus its deprecated
// alias, both optional so the canonical name can take precedence when both are sent — but that left
// `{}` valid under the schema while each delegate 400s it. The schemas now require at least one of
// the pair via `anyOf`; this pins the contract for every canonical/deprecated-alias request body so
// the next alias pair cannot reintroduce an empty-object hole.
test("acknowledgement request schemas reject an empty body and accept either key name (#980)", () => {
  const ACK_KEYS: Record<string, readonly [string, string]> = {
    acknowledgeDeliveryGraph: ["runKey", "run_key"],
    acknowledgeDone: ["featureKey", "feature_key"],
    acknowledgeEpic: ["planKey", "plan_key"],
    acknowledgePr: ["prKey", "pr_key"],
  };
  const spec = doc();
  const ops = new Map(collectOperations(spec).map((o) => [o.operationId, o]));
  for (const [id, [canonical, alias]] of Object.entries(ACK_KEYS)) {
    const op = ops.get(id);
    assert(op?.requestBodySchema !== undefined, `${id} request body schema missing`);
    const schema = op.requestBodySchema;
    assert(
      validateValue(spec, schema, {}).length > 0,
      `${id} must reject {} — require ${canonical} or its deprecated alias ${alias}`,
    );
    assert(
      validateValue(spec, schema, { [canonical]: "owner/repo#1" }).length === 0,
      `${id} must accept the canonical ${canonical}`,
    );
    assert(
      validateValue(spec, schema, { [alias]: "owner/repo#1" }).length === 0,
      `${id} must accept the deprecated alias ${alias}`,
    );
    assert(
      validateValue(spec, schema, { [canonical]: "owner/repo#1", [alias]: "owner/repo#1" }).length === 0,
      `${id} must accept both names (canonical wins at the delegate)`,
    );
  }
});
