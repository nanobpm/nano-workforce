// app/deliveryGraphText.ts — the shared PARSE step for the human-facing UI JSON-paste ingress
// (issue #386, ADR 0005). The Delivery Graphs page (`pages/delivery-graphs.page.json`) submits the
// operator's pasted delivery-graph as a raw JSON STRING (`graphJson`) — the page's text field cannot
// submit a structured object — so the preview/dispatch ingress operations parse it here before handing
// the resulting object to the SAME pure `compileDeliveryGraph` compiler / gated `startDeliveryGraph`
// door the agent-facing paths use. This is a UI text adapter, NOT a parallel compile/dispatch path.
//
// PURE and I/O-free so it unit-tests in isolation. A blank field, non-JSON text, or a non-object JSON
// value maps to a clean `{ ok:false, error }` the ingress surfaces as a 400 with a human banner —
// never a 500.

/** The result of parsing a UI JSON-paste body: the parsed graph (still `unknown` — the compiler/door
 * run the real shape + semantic validation), or a human-readable parse error. */
export type ParseDeliveryGraphTextResult =
  | { ok: true; graph: unknown }
  | { ok: false; error: string };

/** Parse a UI JSON-paste request body (`{ graphJson: string, … }`) into a candidate delivery graph.
 * Guards the three ways the paste can be unusable BEFORE any compile/dispatch runs: a missing/blank
 * `graphJson`, text that is not valid JSON, and JSON that is not an object (e.g. a bare array or
 * scalar). The returned `graph` is deliberately `unknown` — `compileDeliveryGraph` /
 * `validateDeliveryGraph` own the real validation. */
export function parseDeliveryGraphText(body: unknown): ParseDeliveryGraphTextResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "request body must carry a `graphJson` string" };
  }
  const graphJson = "graphJson" in body ? body.graphJson : undefined;
  if (typeof graphJson !== "string" || graphJson.trim() === "") {
    return { ok: false, error: "paste a delivery-graph JSON into the field" };
  }
  let graph: unknown;
  try {
    graph = JSON.parse(graphJson);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return { ok: false, error: "the pasted JSON must be a delivery-graph object" };
  }
  return { ok: true, graph };
}
