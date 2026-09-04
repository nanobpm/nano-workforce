// GET /app/api/agent/guide → operationId `getAgentGuide` (epic nano-workforce#605, slice S5,
// issue #611). The ADDRESSABLE operator guide: fetch one section instead of the whole ~43KB blob
// that `getAgentInstructions` returns (which can exceed an agent's tool-result limit, forcing it to
// persist the blob and carve out a section out-of-band).
//
//   • No `section` query param → a compact table of contents: every stable section id + a one-line
//     summary (`kind: "toc"`). Small by construction — safe under any tool-result limit.
//   • `section=<id>` → ONLY that section's markdown (`kind: "section"`), examples keyed to THIS
//     instance's control-API base + engine base, exactly as the full guide keys them.
//   • An unknown id → 400 with `issues: [{ path: "section", message }]` listing the valid ids
//     (the uniform validation-error contract).
//
// This is the MCP-friendly companion to `getAgentInstructions`; the full-guide doors
// (`GET /agent`, `GET /agent/skill`) are untouched and byte-identical. Read-only, pure, idempotent.
//
// The optional shared-secret guard mirrors /agent and /version: enforced HERE only when
// NANO_PR_WEBHOOK_SECRET is set (the runtime does not enforce OpenAPI `security`).
import { GUIDE_SECTION_PAGE_DEFAULT, guideToc, renderGuideSection, renderGuideSectionChunk, resolveEngineBase } from "../app/agentGuide.ts";
import { resolveApiBase } from "../app/resolveApiBase.ts";
import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

/** Parse a `start`/`length` pagination query param: a present value must be a non-negative SAFE
 *  integer (`length` additionally >= 1). `Number.isSafeInteger` (not `Number.isInteger`) is required
 *  because these values are used as character cursors: an integer beyond `Number.MAX_SAFE_INTEGER`
 *  (e.g. `9007199254740993`) loses precision, so accepting it would silently misinterpret the
 *  caller's requested window. Returns the parsed number, `undefined` when absent, or a
 *  path-qualified validation issue. */
function parsePageArg(raw: unknown, path: string, min: number): { value?: number; issue?: { path: string; message: string } } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return {};
  const s = typeof raw === "string" ? raw.trim() : String(raw);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) {
    return { issue: { path, message: `\`${path}\` must be an integer >= ${min} (character offset); got "${s}"` } };
  }
  return { value: n };
}

export default defineOperation("getAgentGuide", ({ query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgentGuide rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }

  const baseUrl = resolveApiBase(req, "agent/guide");
  const rawSection = query.section;
  const section = typeof rawSection === "string" ? rawSection.trim() : "";

  // No section → the table of contents.
  if (!section) {
    return {
      status: 200,
      body: {
        kind: "toc",
        appVersion: buildVersionInfo().version,
        generatedAt: new Date().toISOString(),
        baseUrl,
        sections: guideToc(),
      },
    };
  }

  // Pagination window (issue #740): a caller engages it by passing `start` and/or `length` (character
  // offsets). Absent both, the whole section is returned unchanged (byte-for-byte identical to before).
  const startArg = parsePageArg(query.start, "start", 0);
  const lengthArg = parsePageArg(query.length, "length", 1);
  const pageIssues = [startArg.issue, lengthArg.issue].filter((i): i is { path: string; message: string } => i !== undefined);
  if (pageIssues.length > 0) {
    app.log.warn("getAgentGuide rejected: invalid pagination args", { issues: pageIssues.length });
    return { status: 400, body: { error: "invalid pagination arguments", issues: pageIssues } };
  }
  const paginate = startArg.value !== undefined || lengthArg.value !== undefined;

  // A section id → just that section (or a bounded page of it), or a 400 that names the valid ids.
  const chunk = paginate ? renderGuideSectionChunk(section, baseUrl, startArg.value ?? 0, lengthArg.value ?? GUIDE_SECTION_PAGE_DEFAULT) : undefined;
  // The resolved body text: a page's slice when paginating, else the whole section. `undefined` from
  // either path means the section id is unknown → the uniform 400 below.
  const resolved = chunk ? chunk.instructions : paginate ? undefined : renderGuideSection(section, baseUrl);
  if (resolved === undefined) {
    // Derive the valid ids from the PARSED table of contents — the sections this deployment can
    // actually serve — not the static registry. When the guide doc is unreadable (RAW_GUIDE
    // fallback, no `##` headings) the TOC is empty and NO id is retrievable, so say so explicitly
    // rather than list registry ids that would themselves 400.
    const validIds = guideToc().map((s) => s.id);
    const detail =
      validIds.length > 0
        ? `valid ids: ${validIds.join(", ")}`
        : "no sections are available in this deployment";
    return {
      status: 400,
      body: {
        error: `unknown guide section "${section}"`,
        issues: [
          {
            path: "section",
            message: `unknown section id "${section}"; ${detail}`,
          },
        ],
      },
    };
  }

  const title = guideToc().find((s) => s.id === section)?.title ?? section;
  return {
    status: 200,
    body: {
      kind: "section",
      appVersion: buildVersionInfo().version,
      generatedAt: new Date().toISOString(),
      baseUrl,
      engineBase: resolveEngineBase(),
      section: {
        id: section,
        title,
        format: "markdown",
        instructions: resolved,
        // Pagination cursor state — present ONLY when the caller engaged a window, so an un-paginated
        // `section=<id>` call's body stays byte-for-byte identical (issue #740).
        ...(chunk
          ? { start: chunk.start, length: chunk.length, totalLength: chunk.totalLength, nextStart: chunk.nextStart }
          : {}),
      },
    },
  };
});
