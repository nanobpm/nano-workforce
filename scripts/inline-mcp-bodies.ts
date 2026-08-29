// Single source of truth for the projected MCP tool INPUT schemas (epic nano-workforce#605, S0).
//
// The Urban runtime projects this app's `openapi.yaml` into MCP tools (ADR 0067) — there is
// intentionally ZERO MCP server code in nwf. The projector (`@nanobpm/urban`
// `collectOperations` → `toolInputSchema`) copies each operation's request-body schema VERBATIM
// into the tool's `inputSchema.properties.body`; it does NOT resolve `$ref`s. So a request body
// authored as `schema: { $ref: "#/components/schemas/DeliveryGraph" }` projects as an opaque
// `body: { "$ref": … }` a standard MCP client cannot resolve — and, unable to see it is an object,
// the client stringifies the argument and the door rejects it (`expected object, got string`).
// The upstream fix (a projector that bundles refs into self-contained schemas) is tracked in
// nano-ide#501 (P0 #502 self-contained schemas, P1 #503 faithful object-body transport, P2 #504
// real-spec conformance guard); THIS script is the nwf-side mitigation that keeps the surface
// callable today: it authors each projected request body as a self-contained, `$ref`-free
// `type: object` schema INLINE in `openapi.yaml`.
//
// Derivation over duplication (AGENTS.md): the `components.schemas` remain the single source of
// truth. This script DERIVES the inline body by fully dereferencing that component (merging
// `allOf`, inlining `oneOf` variants, dropping `discriminator` ref-mappings) and splicing the
// result into the operation's `requestBody` between sentinel markers, in place, without
// reformatting the rest of the hand-maintained file. Re-run it whenever a source component
// changes:
//
//   node --experimental-strip-types scripts/inline-mcp-bodies.ts          # write openapi.yaml
//   node --experimental-strip-types scripts/inline-mcp-bodies.ts --check  # verify (CI)
//
// The convention every projected request-body operation MUST follow (and every later slice that
// adds one inherits): author the body as a SINGLE top-level `$ref` to a `components.schemas` entry,
// yielding a `type: object` with inline `properties`, NO `$ref` in the projected schema, and a
// description that carries the contract; the graph doors (`compileDeliveryGraph`/
// `previewDeliveryGraph`) additionally carry a worked `example` (enforced by
// `test/mcp-tool-schemas.test.ts`). `test/mcp-tool-schemas.test.ts` is the runtime drift guard — it
// runs the REAL urban projector over the spec and fails if any projected tool body reintroduces a
// `$ref` or loses its explicit type.
//
// Drift detection survives inlining: the generated `# BEGIN` sentinel records the source component
// (`source=#/components/schemas/…`), so on every subsequent run the generator re-derives the inline
// body from the CURRENT component — even though the operation's `schema:` no longer carries a
// `$ref` — and `--check` fails if a source component changed but its inline body was not
// regenerated. (Without the recorded source the check would be a permanent false green: once the
// `$ref` is inlined there is nothing left to re-derive from.)
//
// Mirrors the repo's other derive/verify pairs (layout-bpmn --check, sync-nav --check,
// check-contracts / reconcile-contracts).
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
// `yaml` (eemeli) is the SAME parser `@nanobpm/urban` uses to read this spec at runtime
// (openapi/spec.ts), so a round-trip here matches what the projector sees.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const SPEC_PATH = `${ROOT}openapi.yaml`;

const BEGIN_PREFIX = "# BEGIN generated:mcp-body";
const BEGIN_TAIL = "(scripts/inline-mcp-bodies.ts — do not hand-edit)";
const END = "# END generated:mcp-body";

/** The `# BEGIN` sentinel for a block, embedding the source component so a later run can re-derive. */
function beginMarker(sourceRef: string): string {
  return `${BEGIN_PREFIX} source=${sourceRef} ${BEGIN_TAIL}`;
}

type Schema = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

/**
 * Fully dereference a schema against `components.schemas`, producing a `$ref`-free equivalent:
 *  - a `$ref` is replaced by the (recursively dereferenced) target component;
 *  - an `allOf` is MERGED into one object (union of `properties`/`required`) so a node variant
 *    like `DeliveryNodeAgent` (allOf [DeliveryNodeCommon, {inline}]) becomes one flat `type: object`;
 *  - `oneOf`/`anyOf` members are dereferenced but kept as a union;
 *  - `discriminator` is dropped (its `mapping` values are `#/components/...` pointers that would
 *    dangle once inlined, and MCP clients do not need it);
 *  - every other keyword is copied through, recursing into `properties`/`items`/arrays.
 * Cycles (none today) are guarded by the visited-name set.
 */
function deref(node: unknown, comps: Record<string, unknown>, seen: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(n, comps, seen));
  if (!isRecord(node)) return node;

  if (typeof node.$ref === "string") {
    const m = node.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (!m) throw new Error(`non-local $ref cannot be inlined: ${node.$ref}`);
    const name = m[1];
    if (seen.has(name)) throw new Error(`cyclic $ref: ${name}`);
    const target = comps[name];
    if (!target) throw new Error(`dangling $ref: ${node.$ref}`);
    return deref(target, comps, new Set(seen).add(name));
  }

  if (Array.isArray(node.allOf)) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    const merged: Schema = { type: "object", properties: props, required };
    let additionalProperties: unknown;
    for (const part of node.allOf) {
      const d = deref(part, comps, seen);
      if (!isRecord(d)) continue;
      if (isRecord(d.properties)) Object.assign(props, d.properties);
      if (Array.isArray(d.required)) {
        for (const r of d.required) if (typeof r === "string") required.push(r);
      }
      if ("additionalProperties" in d) additionalProperties = d.additionalProperties;
      if (typeof d.type === "string") merged.type = d.type;
    }
    // Sibling keywords authored alongside `allOf` (e.g. `description`) win over the merged parts.
    for (const [k, v] of Object.entries(node)) {
      if (k === "allOf") continue;
      merged[k] = deref(v, comps, seen);
    }
    if (required.length === 0) delete merged.required;
    else merged.required = [...new Set(required)];
    if (additionalProperties !== undefined && !("additionalProperties" in node)) {
      merged.additionalProperties = additionalProperties;
    }
    return merged;
  }

  const out: Schema = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "discriminator") continue;
    out[k] = deref(v, comps, seen);
  }
  return out;
}

/** Does this (raw, un-dereferenced) schema contain a `$ref` anywhere? */
function hasRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRef);
  if (!isRecord(node)) return false;
  if (typeof node.$ref === "string") return true;
  return Object.values(node).some(hasRef);
}

/** `false` iff the operation is `x-mcp`-excluded (operator-only door). */
function isProjected(op: Record<string, unknown>): boolean {
  const x = op["x-mcp"];
  if (x === false) return false;
  if (isRecord(x) && x.exclude === true) return false;
  return true;
}

interface Target {
  operationId: string;
  sourceRef: string;
  inline: Schema;
}

/**
 * Recover `operationId -> source component $ref` from the `# BEGIN … source=…` sentinels already in
 * the raw text. This is what lets `--check` keep detecting drift AFTER the `$ref` has been inlined:
 * the operation's parsed `schema:` no longer carries a `$ref`, but the recorded source does, so the
 * generator can re-derive the block from the current component. Scans by operation region (the same
 * indentation-free `operationId:` split `spliceSchema` uses) so a block is attributed to its owner.
 */
function recordedSources(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const opRe = /^ *operationId: (\S+)/gm;
  const ops: Array<{ id: string; at: number }> = [];
  for (let m = opRe.exec(text); m !== null; m = opRe.exec(text)) {
    ops.push({ id: m[1], at: m.index });
  }
  for (let i = 0; i < ops.length; i++) {
    const end = i + 1 < ops.length ? ops[i + 1].at : text.length;
    const region = text.slice(ops[i].at, end);
    const bm = region.match(/# BEGIN generated:mcp-body source=(\S+)/);
    if (bm) out.set(ops[i].id, bm[1]);
  }
  return out;
}

/**
 * Collect the projected request-body operations to (re)generate. A body is a managed target when it
 * is authored as a single top-level `$ref` (first authoring) OR already carries a generated block
 * whose source component was recorded in its sentinel (subsequent runs). Either way the inline body
 * is DERIVED from the CURRENT `components.schemas`, so a source-component change is always re-derived
 * (and caught by `--check`). A projected body that leaks a NON-top-level `$ref` violates the
 * single-top-level-`$ref` convention and is rejected loudly rather than silently half-inlined.
 */
function collectTargets(doc: Record<string, unknown>, recorded: Map<string, string>): Target[] {
  const comps: Record<string, unknown> =
    isRecord(doc.components) && isRecord(doc.components.schemas) ? doc.components.schemas : {};
  const paths = isRecord(doc.paths) ? doc.paths : {};
  const targets: Target[] = [];
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isRecord(op) || typeof op.operationId !== "string") continue;
      if (!isProjected(op)) continue;
      const body = isRecord(op.requestBody) ? op.requestBody : undefined;
      const jsonNode =
        body && isRecord(body.content) && isRecord(body.content["application/json"])
          ? body.content["application/json"]
          : undefined;
      const json = isRecord(jsonNode) ? jsonNode.schema : undefined;
      if (!isRecord(json)) continue;
      let sourceRef: string | undefined;
      if (typeof json.$ref === "string") {
        sourceRef = json.$ref;
      } else if (recorded.has(op.operationId)) {
        sourceRef = recorded.get(op.operationId);
      } else {
        if (hasRef(json)) {
          throw new Error(
            `${op.operationId}: projected request body must be authored as a single top-level ` +
              "`$ref` to a components.schemas entry (found a nested `$ref`) — see the MCP schema " +
              "convention in openapi.yaml.",
          );
        }
        continue;
      }
      if (sourceRef === undefined) continue;
      const derefed = deref({ $ref: sourceRef }, comps, new Set());
      const inline: Schema = isRecord(derefed) ? derefed : {};
      if (typeof inline.type !== "string") {
        // A `oneOf`/`anyOf` body root has no single `type`; every projected body IS an object, so
        // pin the explicit `type: object` the MCP contract requires alongside the variant union.
        inline.type = "object";
      }
      targets.push({ operationId: op.operationId, sourceRef, inline });
    }
  }
  targets.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return targets;
}

/** Render an inline schema as a YAML block indented to `pad` spaces, wrapped in the sentinels. */
function renderBlock(inline: Schema, pad: string, sourceRef: string): string {
  const dumped = stringifyYaml(inline, { indent: 2, lineWidth: 0, singleQuote: true });
  const body = dumped
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => (line.length ? pad + line : line))
    .join("\n");
  return `${pad}${beginMarker(sourceRef)}\n${body}\n${pad}${END}`;
}

/**
 * Replace the `requestBody` → `application/json` → `schema:` value of `operationId` in the raw
 * text with `block`, in place. Returns the new text. Boundaries are found by indentation, the same
 * span technique `scripts/sync-nav.ts` uses, so nothing else in the file is reformatted.
 */
function spliceSchema(text: string, operationId: string, inline: Schema, sourceRef: string): string {
  const opMarker = `operationId: ${operationId}\n`;
  const opAt = text.indexOf(opMarker);
  if (opAt < 0) throw new Error(`operationId not found in text: ${operationId}`);
  // Bound the search to this operation (up to the next operationId).
  const nextOp = text.indexOf("operationId: ", opAt + opMarker.length);
  const region = nextOp < 0 ? text.slice(opAt) : text.slice(opAt, nextOp);
  const rbRel = region.indexOf("requestBody:");
  if (rbRel < 0) throw new Error(`requestBody not found for ${operationId}`);
  // First `schema:` after requestBody is the request body schema.
  const schemaRel = region.indexOf("schema:", rbRel);
  if (schemaRel < 0) throw new Error(`request schema not found for ${operationId}`);
  const schemaAbs = opAt + schemaRel;
  const lineStart = text.lastIndexOf("\n", schemaAbs) + 1;
  const schemaIndent = schemaAbs - lineStart; // columns before `schema:`
  const pad = " ".repeat(schemaIndent + 2); // schema value is nested one level deeper
  // The schema value spans from the end of the `schema:` line to the first following line whose
  // indent is <= the `schema:` line's indent (a sibling/closing key), skipping blank lines.
  const afterSchemaLine = text.indexOf("\n", schemaAbs) + 1;
  const lines = text.slice(afterSchemaLine).split("\n");
  let consumed = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      consumed += line.length + 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= schemaIndent) break;
    consumed += line.length + 1;
  }
  const valueEnd = afterSchemaLine + consumed;
  const block = renderBlock(inline, pad, sourceRef);
  return `${text.slice(0, afterSchemaLine)}${block}\n${text.slice(valueEnd)}`;
}

function generate(text: string): string {
  const parsed = parseYaml(text);
  const doc: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const targets = collectTargets(doc, recordedSources(text));
  let out = text;
  for (const t of targets) out = spliceSchema(out, t.operationId, t.inline, t.sourceRef);
  return out;
}

function main(): void {
  const check = process.argv.includes("--check");
  const original = readFileSync(SPEC_PATH, "utf8");
  const next = generate(original);
  if (check) {
    if (next !== original) {
      process.stderr.write(
        "openapi.yaml projected MCP request bodies are STALE.\n" +
          "A source component schema changed but its inline `body` was not regenerated.\n" +
          "Run: npm run gen:mcp-bodies (node --experimental-strip-types scripts/inline-mcp-bodies.ts)\n",
      );
      process.exit(1);
    }
    process.stdout.write("openapi.yaml projected MCP request bodies are up to date.\n");
    return;
  }
  if (next !== original) {
    writeFileSync(SPEC_PATH, next);
    process.stdout.write("openapi.yaml projected MCP request bodies regenerated.\n");
  } else {
    process.stdout.write("openapi.yaml projected MCP request bodies already up to date.\n");
  }
}

main();
