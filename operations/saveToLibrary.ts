// POST /app/api/actions/delivery-graph/library/save → operationId `saveToLibrary` (issue #522, epic
// #519 S3). Persist a delivery graph to the reusable LIBRARY — the durable base S4/S5/S6 build on. The
// request carries the entry `name` (its slug + short-hash derive the stable library id, so re-saving
// the same name upserts) plus EITHER a raw `graphJson` STRING (compiled from scratch, `source:
// composed`) OR the `digest` of an existing staged/dispatched proposal whose ALREADY-STORED graph is
// reused (`source: from-staged` / `from-dispatched`).
//
// Every save validates the graph through the SAME `parseAndCompileText` pipeline the preview/stage
// doors use, so an uncompilable graph can NEVER be persisted — a bad JSON string or a graph that fails
// validation is a clean 400 and nothing is written. Mirrors the proposals store/door pattern so the S3
// API surface is familiar to the S4/S5/S6 slices.

import {
  buildLibraryEntryRow,
  type DeliveryLibrarySource,
  libraryEntryDto,
  saveLibraryEntry,
} from "../app/deliveryGraphLibrary.ts";
import { deliveryGraphProposals, isProposalExpired } from "../app/deliveryGraphProposals.ts";
import { parseAndCompileText } from "../app/deliveryGraphTextIngress.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("saveToLibrary", async ({ body }, app) => {
  const name = body && typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") {
    app.log.warn("save-to-library rejected: missing name");
    return { status: 400, body: { ok: false, error: "request body must carry a non-blank `name` for the library entry" } };
  }
  const description = body && typeof body.description === "string" ? body.description : undefined;

  const digest = body && typeof body.digest === "string" && body.digest.trim() !== "" ? body.digest.trim() : undefined;
  const graphJson = body && typeof body.graphJson === "string" && body.graphJson.trim() !== "" ? body.graphJson : undefined;
  if (digest && graphJson) {
    app.log.warn("save-to-library rejected: both digest and graphJson", { name });
    return { status: 400, body: { ok: false, error: "provide EITHER `graphJson` (a raw graph) OR `digest` (an existing proposal), not both" } };
  }

  // Resolve the graph text + its provenance. From a digest: reuse the proposal's already-stored graph
  // (still re-validated below, so a corrupt stored graph is refused). From raw JSON: compile from scratch.
  let sourceGraphJson: string;
  let source: DeliveryLibrarySource;
  if (digest) {
    const proposal = await deliveryGraphProposals(app.data).get(digest);
    if (!proposal) {
      app.log.warn("save-to-library rejected: unknown digest", { digest });
      return { status: 400, body: { ok: false, error: `no stored graph for digest ${digest} — stage or dispatch it first, or save a raw graph` } };
    }
    // Only a LIVE staged (not aged out of its TTL) or dispatched proposal may seed the library — a
    // superseded/expired/stale-staged digest is not a canonical graph, and reusing it would both persist a
    // retired graph and mis-label it `source: from-staged`.
    const isLiveStaged = proposal.status === "staged" && !isProposalExpired(proposal.expires_at);
    if (!isLiveStaged && proposal.status !== "dispatched") {
      app.log.warn("save-to-library rejected: digest not live staged/dispatched", { digest, status: proposal.status });
      return { status: 400, body: { ok: false, error: `digest ${digest} is not a live staged/dispatched proposal (status ${proposal.status}) — stage or dispatch it first, or save a raw graph` } };
    }
    sourceGraphJson = proposal.graph;
    source = proposal.status === "dispatched" ? "from-dispatched" : "from-staged";
  } else if (graphJson) {
    sourceGraphJson = graphJson;
    source = "composed";
  } else {
    app.log.warn("save-to-library rejected: no graph source", { name });
    return { status: 400, body: { ok: false, error: "request body must carry either `graphJson` (a raw graph) or `digest` (an existing proposal)" } };
  }

  // Validate/compile — an uncompilable graph can never enter the library (nothing is persisted here).
  const ingress = await parseAndCompileText({ graphJson: sourceGraphJson });
  if (!ingress.ok) {
    app.log.warn("save-to-library rejected: graph failed validation", { name, source, message: ingress.body.error });
    return { status: 400, body: ingress.body };
  }

  const saved = await saveLibraryEntry(
    app.data,
    buildLibraryEntryRow({ name, description, graphJson: JSON.stringify(ingress.graph), source }),
  );
  app.log.info("save-to-library saved", { id: saved.id, name: saved.name, source });
  return { status: 200, body: { ok: true, entry: libraryEntryDto(saved) } };
});
