// Drift guard for the per-form escalation answer shapes (issue #989). `completeUserTask`'s
// `variables` documents one schema per escalation `.form` so `d8ctl nwf escalations answer --help`
// lists the fields per kind. The `.form` files are the canonical contract (the completer validates
// against them via `formExpectedFields`), so every documented variant must match its form exactly.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@nanobpm/urban/toolkit";
import { assertEquals } from "#test-assert";
import { formExpectedFields } from "./agentCompletion.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pascal = (s: string) => s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

interface VariantSchema {
  required?: string[];
  properties?: Record<string, { enum?: string[]; anyOf?: { $ref: string }[] }>;
}

const doc: {
  components: { schemas: Record<string, VariantSchema> };
} = parseSpec(readFileSync(join(ROOT, "openapi.yaml"), "utf8"));

const forms = readdirSync(join(ROOT, "resources/forms"))
  .map((f) => f.replace(/\.form$/, ""))
  .filter((id) => id !== "spine-demo")
  .sort();

test("completeUserTask documents exactly one answer variant per escalation .form (issue #989)", () => {
  // The canonical (authored) body component; `gen:mcp-bodies` inlines it onto the path.
  const variants = (doc.components.schemas.EscalationAnswerRequest.properties?.variables?.anyOf ?? []).map((r) => r.$ref.replace("#/components/schemas/", ""));
  assertEquals(variants, forms.map((id) => `EscalationAnswer${pascal(id)}`));
});

test("each documented answer variant matches its canonical .form fields (issue #989)", () => {
  for (const id of forms) {
    const schema = doc.components.schemas[`EscalationAnswer${pascal(id)}`];
    const fields = formExpectedFields(id);
    assertEquals(Object.keys(schema.properties ?? {}), fields.map((f) => f.name), `${id}: field names`);
    assertEquals(schema.required ?? [], fields.filter((f) => f.required).map((f) => f.name), `${id}: required`);
    for (const f of fields) {
      assertEquals(schema.properties?.[f.name]?.enum, f.enum, `${id}.${f.name}: enum`);
    }
  }
});
