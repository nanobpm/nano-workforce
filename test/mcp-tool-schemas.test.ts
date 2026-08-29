// Drift guard for the projected MCP tool INPUT schemas (epic nano-workforce#605, S0).
//
// The Urban runtime projects `openapi.yaml` into MCP tools (ADR 0067) and copies each operation's
// request-body schema VERBATIM into the tool's `inputSchema.properties.body` — it does NOT resolve
// `$ref`s. A leaked `$ref` is therefore unresolvable in a standard MCP client, and, unable to see
// the body is an object, the client stringifies the argument and the door rejects it
// (`expected object, got string`). This test drives the REAL projector (`collectOperations` from
// `@nanobpm/urban`, plus the runtime's own `toolInputSchema` shape) over the checked-in spec and
// fails the build if any projected tool body reintroduces a `$ref`, loses its explicit `type`, or a
// graph door drops its worked example. It is the runtime counterpart to
// `scripts/inline-mcp-bodies.ts --check` (which guards the derive step); together they keep the
// convention every later slice inherits: `type: object`, inline `properties`, no `$ref`, an example.
//
// Extension seam: a sibling slice adding a projected request-body operation to `openapi.yaml` needs
// no change here — this walks EVERY projected operation. A new graph door should be added to
// GRAPH_DOORS so its example is required too.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { collectOperations, type OperationInfo, parseSpec } from "@nanobpm/urban/toolkit";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
// Parse the spec exactly as the runtime does (`@nanobpm/urban/toolkit` `parseSpec`), so this guard
// sees precisely the document the MCP projector projects.
const SPEC = parseSpec(readFileSync(`${ROOT}openapi.yaml`, "utf8"));

/** Graph doors that MUST carry at least one worked example (epic #605 acceptance). */
const GRAPH_DOORS = new Set(["compileDeliveryGraph", "previewDeliveryGraph"]);

/** The client-visible tool `inputSchema`, reproduced exactly from the runtime's `toolInputSchema`
 *  (mcp.ts) — path/query params plus the request body copied verbatim under `body`. */
function toolInputSchema(op: OperationInfo): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of op.parameters) {
    if (p.in === "path" || p.in === "query") {
      properties[p.name] = p.schema ?? {};
      if (p.required) required.push(p.name);
    }
  }
  if (op.requestBodySchema) {
    properties.body = op.requestBodySchema;
    if (op.requestBodyRequired) required.push("body");
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Every `$ref` string reachable in a schema, with a JSON-path for the failure message. */
function findRefs(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => findRefs(n, `${path}[${i}]`, out));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") out.push(`${path}.$ref -> ${v}`);
    else findRefs(v, `${path}.${k}`, out);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The projected operations whose tool carries a request body (the object-body tools). */
function projectedBodyOps(): OperationInfo[] {
  return collectOperations(SPEC).filter((op) => !op.mcpExcluded && op.requestBodySchema);
}

test("every projected object-body tool schema is $ref-free (self-contained)", () => {
  const ops = projectedBodyOps();
  assert(ops.length >= 10, `expected the full projected object-body surface, saw ${ops.length}`);
  for (const op of ops) {
    const refs: string[] = [];
    findRefs(toolInputSchema(op).properties, `${op.operationId}.properties`, refs);
    assert(
      refs.length === 0,
      `${op.operationId}: projected tool schema leaks $ref(s) a standard MCP client cannot ` +
        `resolve — inline the component(s) (run npm run gen:mcp-bodies): ${refs.join(", ")}`,
    );
  }
});

test("every projected object-body tool declares an explicit body type: object", () => {
  for (const op of projectedBodyOps()) {
    const body = op.requestBodySchema as Record<string, unknown>;
    // A `oneOf`/`anyOf` body still carries an explicit `type: object` (the generator pins it) so a
    // client knows to pass an object, not a string.
    assert(
      body.type === "object",
      `${op.operationId}: request body must declare an explicit \`type: object\` (saw ` +
        `type=${JSON.stringify(body.type)})`,
    );
    assert(
      isRecord(body.properties) || Array.isArray(body.oneOf) || Array.isArray(body.anyOf),
      `${op.operationId}: request body must expose inline \`properties\` (or a \`oneOf\`/\`anyOf\` ` +
        "of object variants) so the shape is discoverable from the tool surface",
    );
  }
});

test("each graph door carries at least one worked example", () => {
  const byId = new Map(projectedBodyOps().map((op) => [op.operationId, op]));
  for (const door of GRAPH_DOORS) {
    const op = byId.get(door);
    assert(op, `expected graph door ${door} to be a projected object-body tool`);
    const body = op!.requestBodySchema as Record<string, unknown>;
    const hasExample =
      "example" in body ||
      "examples" in body ||
      (isRecord(body.properties) &&
        Object.values(body.properties).some((p) => isRecord(p) && "example" in p));
    assert(hasExample, `${door}: request body must embed a worked \`example\` (§9.5 canonical graph)`);
  }
});

test("operator-only delivery-graph doors stay withheld from the MCP tool surface", () => {
  const excluded = new Set(
    collectOperations(SPEC)
      .filter((op) => op.mcpExcluded)
      .map((op) => op.operationId),
  );
  for (const door of ["stageDeliveryGraph", "dispatchDeliveryGraph", "dismissProposal"]) {
    assert(excluded.has(door), `${door} must remain x-mcp-excluded (operator-only dispatch gate)`);
  }
});
