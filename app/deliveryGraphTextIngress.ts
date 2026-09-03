// app/deliveryGraphTextIngress.ts — the shared PARSE → COMPILE → PROJECT pipeline behind the two
// human-facing delivery-graph text-ingress doors (issue #516):
//   • `previewDeliveryGraph`  — PURE preview: compile + project, NO staging.
//   • `stageDeliveryGraph`    — compile + project + STAGE a proposal for operator dispatch.
//
// Splitting preview from staging means both doors run the IDENTICAL parse+compile+project step and
// differ ONLY in whether they persist a staged proposal. That step therefore lives here ONCE
// (derivation over duplication) rather than being copied per door — the previous single door inlined
// it, and forking it would have created two drift-prone compile paths. Neither door dispatches; the
// #460 boundary (dispatch is an operator action on a staged proposal) is untouched.

import type { DeliveryGraphTextResult } from "../nano-generated/api-io.d.ts";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import { proposalReviewUrl } from "./deliveryGraphProposals.ts";
import { validateDeliveryGraphShape } from "./deliveryGraphShape.ts";
import { parseDeliveryGraphText } from "./deliveryGraphText.ts";
import { deliveryGraphDigest } from "./deliveryRunner.ts";

type CompileResult = Awaited<ReturnType<typeof compileDeliveryGraph>>;
type CompiledOk = Extract<CompileResult, { ok: true }>;
type CompileErrors = Extract<CompileResult, { ok: false }>["errors"];

/** A parse/validation failure, already shaped as the door's 400 response. */
export interface TextIngressFailure {
  ok: false;
  status: 400;
  body: { ok: false; error: string; errors?: CompileErrors };
}

/** A well-formed, compiled graph ready to project (and, for the stage door, to persist). */
export interface TextIngressOk {
  ok: true;
  graph: unknown;
  compiled: CompiledOk;
  digest: string;
  name: string | null;
}

export type TextIngressResult = TextIngressOk | TextIngressFailure;

/** Injectable seam for {@link parseAndCompileText}. `compile` defaults to the real
 * {@link compileDeliveryGraph}; a test overrides it to drive the never-throws guard with a compiler
 * that REJECTS — the real layout pass only throws on a server-side fault (a missing `bpmn-auto-layout`
 * peer, so no DI is produced), which is not reproducible from input alone. */
export interface ParseAndCompileDeps {
  compile?: (graph: unknown) => Promise<CompileResult>;
  /** Injectable seam for the reused OpenAPI shape gate — defaults to the real
   * {@link validateDeliveryGraphShape}. A test overrides it to drive the spec-load guard with a
   * validator that THROWS, standing in for a stripped/corrupt deployment whose `openapi.yaml` cannot
   * be read/parsed — not reproducible from input alone. */
  validateShape?: (graph: unknown) => ReturnType<typeof validateDeliveryGraphShape>;
}

/** Parse a UI JSON-paste body (`{ graphJson }`), then run the SAME pure compiler the agent door uses.
 * A blank/invalid paste or a graph that fails validation is returned as a ready-to-send 400; success
 * carries the compiled graph plus its content `digest` and human `name`. Never throws / never a 500 —
 * even a server-side layout fault is caught and mapped to the door's clean 400/no-persist shape. */
export async function parseAndCompileText(
  body: unknown,
  deps: ParseAndCompileDeps = {},
): Promise<TextIngressResult> {
  const parsed = parseDeliveryGraphText(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { ok: false, error: parsed.error } };
  }
  // Re-apply the OpenAPI `DeliveryGraph` SHAPE gate the runtime runs at the typed `compileDeliveryGraph`
  // edge (its `validateValue`). These text doors receive a raw `graphJson` STRING, so the runtime never
  // shape-checked the parsed object — without this, malformed NESTED values (`nodes[0].human.prompt: 42`,
  // `wait.poll.backoff: 42`, unknown properties) reach the semantic validator, which deliberately does
  // not re-enumerate every optional-field type, and are persisted / later throw in `parseProbe`. Reusing
  // the SAME validator against the SAME canonical schema (no ajv, no drift-surface hand checks) gives the
  // text doors byte-identical shape enforcement to the agent door. Structural only, so a not-yet-
  // resolvable capability/pr probe still passes — its late-binding stays the runner's job.
  let shapeErrors: ReturnType<typeof validateDeliveryGraphShape>;
  try {
    shapeErrors = (deps.validateShape ?? validateDeliveryGraphShape)(parsed.graph);
  } catch (err) {
    // `validateDeliveryGraphShape` reads/parses `openapi.yaml` (once, cached) to reuse the runtime's
    // OWN validator. A stripped or corrupted deployment where the spec is missing/unparseable — or the
    // `DeliveryGraph` schema cannot be resolved — makes that read THROW. Left uncaught it would escape
    // whichever door called us (none wrap this call) as a raw, unhandled 500, breaking the "never throws
    // / never a 500" promise every caller depends on. This is a server-side fault (like the layout fault
    // caught below), not bad input, so map it to the SAME clean 400/no-persist shape — ONE contract for
    // every server fault this pipeline can hit, no partial/unhandled leak.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: `graph shape check unavailable: ${message}` },
    };
  }
  if (shapeErrors.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: `graph failed shape validation: ${shapeErrors.length} error(s)`,
        errors: shapeErrors,
      },
    };
  }
  const compile = deps.compile ?? compileDeliveryGraph;
  let compiled: CompileResult;
  try {
    compiled = await compile(parsed.graph);
  } catch (err) {
    // `compileDeliveryGraph` returns ok:false for every INPUT failure, but its layout pass
    // (`layoutDeliveryDiagram` → `layoutBpmn`) can still THROW on a server-side fault — e.g. the
    // `bpmn-auto-layout` peer missing, so no DI block is produced. Uncaught, that rejection would
    // escape whichever door called us (preview/stage/save/import — none wrap this call) as a raw,
    // unhandled 500, breaking the "never throws / never a 500" promise every caller depends on. Map it
    // to the SAME clean 400 shape a compile error produces, so ONE guard keeps the door's documented
    // "compile failure → clean 400, nothing persisted" contract honest for this edge case across all
    // four doors, rather than leaking a partial/unhandled failure.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 400, body: { ok: false, error: `graph failed to compile: ${message}` } };
  }
  if (!compiled.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: `graph failed validation: ${compiled.errors.length} error(s)`,
        errors: compiled.errors,
      },
    };
  }
  const digest = deliveryGraphDigest(compiled.semanticBpmn);
  const name =
    typeof compiled.resolved.name === "string" && compiled.resolved.name.trim() !== ""
      ? compiled.resolved.name.trim()
      : null;
  return { ok: true, graph: parsed.graph, compiled, digest, name };
}

/** Project a compiled graph into the shared `DeliveryGraphTextResult` 200 body both doors return: the
 * `digest`, node/human/side-effect counts, the mermaid `diagram`, and the full human-stop / side-effect
 * detail the Delivery Graphs page renders (#441). `staged` records whether a proposal was persisted;
 * `includeBpmn` attaches the compiled BPMN (with DI) so the PURE preview door can drive the host
 * explorer's DI preview WITHOUT staging (the stage door omits it — the staged grid recompiles by
 * digest). */
export function buildTextPreviewBody(
  ok: TextIngressOk,
  opts: { staged: boolean; includeBpmn?: boolean },
): DeliveryGraphTextResult {
  const { compiled, digest, name } = ok;
  return {
    ok: true,
    staged: opts.staged,
    digest,
    reviewUrl: proposalReviewUrl(digest),
    ...(name !== null ? { title: name } : {}),
    sideEffecting: compiled.sideEffects.length > 0,
    nodeCount: compiled.resolved.nodes.length,
    humanNodeCount: compiled.humanNodes.length,
    sideEffectCount: compiled.sideEffects.length,
    diagram: compiled.diagram,
    humanNodes: compiled.humanNodes,
    sideEffects: compiled.sideEffects,
    ...(opts.includeBpmn ? { bpmn: compiled.bpmn } : {}),
  };
}
