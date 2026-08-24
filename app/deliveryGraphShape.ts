// app/deliveryGraphShape.ts — reuse the RUNTIME's OWN OpenAPI request-body validator to shape-check a
// delivery graph that reached the compiler through a TEXT-ingress door (preview/stage/save/import).
//
// The typed agent door (`compileDeliveryGraph`) has its body validated against the openapi
// `DeliveryGraph` schema by the runtime BEFORE the delegate runs (`@nanobpm/urban`
// runtime/core/modules/api.js → `validateValue`). The four human-facing doors instead receive a raw
// `graphJson` STRING, which the runtime cannot shape-check — so the parsed object reaches
// `compileDeliveryGraph` having BYPASSED that gate, and only the SEMANTIC validator
// (`validateDeliveryGraph`) sees it. That validator, by design, does not re-enumerate every nested
// optional-field type (the drift surface it explicitly forbids — see `REQUIRED_CONFIG_FIELDS` in
// `app/deliveryGraph.ts`), so malformed nested values (`nodes[0].human.prompt: 42`,
// `wait.poll.backoff: 42`, unknown properties) slipped through, were persisted, and later made
// `parseProbe` throw downstream in `prepareDeliveryGraph`.
//
// Rather than hand-write those nested checks (drift) or add a new JSON-Schema dependency, we reuse the
// EXACT validator the runtime applies at the typed edge — `validateValue` from `@nanobpm/urban/toolkit`
// — against the SAME canonical `DeliveryGraph` schema in `openapi.yaml`. ONE schema, ONE validator, no
// second source of truth: the text doors now get byte-identical shape enforcement to the typed door.
// It is PURELY structural, so a shape-valid but not-yet-resolvable `capability`/`pr` wait probe passes
// (its late-binding is the runner's job, not the edge's) — exactly the deferred-resolution contract the
// canonical `parseProbe` intentionally keeps out of validate time.

import { readFileSync } from "node:fs";
import {
  type OpenApiDoc,
  type OpenApiSchema,
  parseSpec,
  resolveSchema,
  validateValue,
} from "@nanobpm/urban/toolkit";
import type { CompileDeliveryGraphErrors } from "../nano-generated/api-io.d.ts";

/** The wire error pair the compiler/doors forward (`{ path, message }`) — the stable schema `code`
 * stays server-side, mirroring how `validateDeliveryGraph` errors are stripped for the wire. */
type WireError = CompileDeliveryGraphErrors["errors"][number];

// The spec ships at the repo root; this module lives in `app/`, so `..` is the repo root. Mirrors the
// app's existing runtime-repo-file reads (`agentGuide.ts`, `agentSkill.ts`, `agentCompletion.ts`).
const SPEC_URL = new URL("../openapi.yaml", import.meta.url);

let cached: { doc: OpenApiDoc; schema: OpenApiSchema } | undefined;

/** Load + parse `openapi.yaml` ONCE and resolve the `DeliveryGraph` component schema (cached — the
 * spec is immutable for a process lifetime, so re-reading per compile would be pure waste). */
function deliveryGraphSchema(): { doc: OpenApiDoc; schema: OpenApiSchema } {
  if (!cached) {
    const doc = parseSpec(readFileSync(SPEC_URL, "utf8"));
    const schema = resolveSchema(doc, { $ref: "#/components/schemas/DeliveryGraph" });
    if (!schema) {
      throw new Error("openapi.yaml is missing the #/components/schemas/DeliveryGraph schema");
    }
    cached = { doc, schema };
  }
  return cached;
}

/** Shape-check `graph` against the canonical openapi `DeliveryGraph` schema using the runtime's OWN
 * validator — the SAME gate the typed `compileDeliveryGraph` edge applies. Returns path-qualified
 * `{ path, message }` errors (empty = the shape is valid). Structural only: a shape-valid but
 * not-yet-resolvable `capability`/`pr` probe passes (late-binding is deferred to the runner). */
export function validateDeliveryGraphShape(graph: unknown): WireError[] {
  const { doc, schema } = deliveryGraphSchema();
  return validateValue(doc, schema, graph).map((issue) => ({
    path: issue.path === "" ? "/" : issue.path,
    message: issue.message,
  }));
}
