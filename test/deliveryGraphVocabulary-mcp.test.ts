// test/deliveryGraphVocabulary-mcp.test.ts — S3/#609 surface guard.
//
// Verifies the `getDeliveryGraphVocabulary` READ tool is actually VISIBLE to agents over MCP (the
// Urban runtime projects `openapi.yaml` into MCP tools, ADR 0067 — zero MCP server code in nwf) and
// that its operation conforms to S0's self-contained convention: a `$ref`-free `200` response schema
// with an explicit `type: object` and a worked `example`. Drives the REAL projector (`collectOperations`
// from `@nanobpm/urban/toolkit`) over the checked-in spec, exactly like `test/mcp-tool-schemas.test.ts`,
// so a regression (the op excluded, or a re-leaked `$ref`/dropped example) fails the build.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collectOperations, parseSpec } from "@nanobpm/urban/toolkit";
import { parse as parseYaml } from "yaml";
import assert from "node:assert/strict";
import { deliveryGraphVocabulary } from "../app/deliveryGraphVocabulary.ts";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const SPEC_TEXT = readFileSync(`${ROOT}openapi.yaml`, "utf8");
const SPEC = parseSpec(SPEC_TEXT);
const OP_ID = "getDeliveryGraphVocabulary";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every `$ref` reachable in a schema, JSON-path-qualified for the failure message. */
function findRefs(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => findRefs(n, `${path}[${i}]`, out));
    return;
  }
  if (!isRecord(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") out.push(`${path}.$ref -> ${v}`);
    else findRefs(v, `${path}.${k}`, out);
  }
}

test("getDeliveryGraphVocabulary is projected onto the MCP tool surface (not excluded)", () => {
  const op = collectOperations(SPEC).find((o) => o.operationId === OP_ID);
  assert(op, `${OP_ID} must be a declared operation the projector can see`);
  assert(!op!.mcpExcluded, `${OP_ID} must be visible over MCP (no x-mcp exclusion)`);
});

test("the getDeliveryGraphVocabulary 200 response schema is $ref-free with an explicit type + example", () => {
  const doc = parseYaml(SPEC_TEXT) as Record<string, any>;
  const schema = doc?.paths?.["/delivery-graph/vocabulary"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
  assert(isRecord(schema), "the 200 response must carry an inline application/json schema");
  assert.equal(schema.type, "object", "the response schema must declare an explicit type: object");
  assert("example" in schema, "the response schema must embed a worked example (S0 self-contained convention)");
  const refs: string[] = [];
  findRefs(schema, `${OP_ID}.responses.200`, refs);
  assert(refs.length === 0, `${OP_ID}: 200 response schema leaks $ref(s): ${refs.join(", ")}`);
});

test("the served payload matches the response schema's required keys (data ⇄ contract)", () => {
  const doc = parseYaml(SPEC_TEXT) as Record<string, any>;
  const schema = doc.paths["/delivery-graph/vocabulary"].get.responses["200"].content["application/json"].schema;
  const required: string[] = schema.required ?? [];
  const payload = deliveryGraphVocabulary() as Record<string, unknown>;
  for (const key of required) {
    assert(key in payload, `served vocabulary is missing required schema key '${key}'`);
  }
});
