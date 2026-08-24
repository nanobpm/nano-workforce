// POST /app/api/actions/delivery-graph/library/import → operationId `importToLibrary` (issue #524, epic
// #519 S5). Import a delivery graph into the reusable LIBRARY from a filesystem FILE. The compose
// App-View's `<input type=file accept=.json>` reads the chosen file's text client-side and POSTs it here
// as the raw `graphJson` string.
//
// Like `saveToLibrary` (#522), every import validates the graph through the SAME `parseAndCompileText`
// pipeline the preview/stage doors use, so an uncompilable graph can NEVER be persisted — a file that is
// not valid JSON, or a graph that fails to compile, is a clean 400 (carrying the path-qualified compile
// `errors`) and NOTHING is written. The persisted entry is tagged `source: imported`. Its name defaults
// to the imported graph's own `name`; an explicit `name` in the body overrides it (an unnamed graph with
// no override is a clean 400 — the library id is name-derived, so a name is required).
//
// This is a MUTATING library door, so — like the get/delete library doors — it carries the optional
// shared-secret guard: when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret
// header (the compose client sends it for same-origin requests); unset → open. Without this, a configured
// deployment would let an unauthenticated caller upsert persistent library entries. (The `save` door is
// the deliberate exception — it is also reached by a declarative page row action that cannot carry the
// header, so it is unguarded; see `saveToLibrary.ts`.)

import { buildLibraryEntryRow, libraryEntryDto, saveLibraryEntry } from "../app/deliveryGraphLibrary.ts";
import { parseAndCompileText } from "../app/deliveryGraphTextIngress.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("importToLibrary", async ({ body, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("import-to-library rejected: missing/invalid shared secret");
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  const graphJson = body && typeof body.graphJson === "string" ? body.graphJson : "";
  if (graphJson.trim() === "") {
    app.log.warn("import-to-library rejected: empty file");
    return { status: 400, body: { ok: false, error: "the imported file was empty — select a delivery-graph `.json` file" } };
  }
  const description = body && typeof body.description === "string" ? body.description : undefined;
  const nameOverride = body && typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : undefined;

  // Validate/compile — a file that is not valid JSON, or a graph that fails validation, is a clean 400
  // with path-qualified errors and nothing is persisted (an uncompilable graph can never enter the library).
  const ingress = await parseAndCompileText({ graphJson });
  if (!ingress.ok) {
    app.log.warn("import-to-library rejected: graph failed validation", { message: ingress.body.error });
    return { status: 400, body: ingress.body };
  }

  // The library id is name-derived, so a name is required. It defaults to the imported graph's own
  // compiled `name`; an explicit override wins. An unnamed graph with no override is a clean 400.
  const name = nameOverride ?? ingress.name ?? "";
  if (name.trim() === "") {
    app.log.warn("import-to-library rejected: imported graph has no name and none was provided");
    return { status: 400, body: { ok: false, error: "the imported graph has no `name` — add one to the file, or supply a name" } };
  }

  const saved = await saveLibraryEntry(
    app.data,
    buildLibraryEntryRow({ name, description, graphJson: JSON.stringify(ingress.graph), source: "imported" }),
  );
  app.log.info("import-to-library saved", { id: saved.id, name: saved.name, source: "imported" });
  return { status: 200, body: { ok: true, entry: libraryEntryDto(saved) } };
});
