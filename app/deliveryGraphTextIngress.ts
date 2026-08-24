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
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import { parseDeliveryGraphText } from "./deliveryGraphText.ts";
import { proposalReviewUrl } from "./deliveryGraphProposals.ts";
import { deliveryGraphDigest } from "./deliveryRunner.ts";
import type { DeliveryGraphTextResult } from "../nano-generated/api-io.d.ts";

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

/** Parse a UI JSON-paste body (`{ graphJson }`), then run the SAME pure compiler the agent door uses.
 * A blank/invalid paste or a graph that fails validation is returned as a ready-to-send 400; success
 * carries the compiled graph plus its content `digest` and human `name`. Never throws / never a 500. */
export async function parseAndCompileText(body: unknown): Promise<TextIngressResult> {
  const parsed = parseDeliveryGraphText(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { ok: false, error: parsed.error } };
  }
  const compiled = await compileDeliveryGraph(parsed.graph);
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
  const digest = deliveryGraphDigest(compiled.bpmn);
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
