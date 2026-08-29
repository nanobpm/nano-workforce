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
import { GUIDE_SECTIONS, guideToc, renderGuideSection, resolveEngineBase } from "../app/agentGuide.ts";
import { resolveApiBase } from "../app/resolveApiBase.ts";
import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

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

  // A section id → just that section, or a 400 that names the valid ids.
  const instructions = renderGuideSection(section, baseUrl);
  if (instructions === undefined) {
    const validIds = GUIDE_SECTIONS.map((s) => s.id);
    return {
      status: 400,
      body: {
        error: `unknown guide section "${section}"`,
        issues: [
          {
            path: "section",
            message: `unknown section id "${section}"; valid ids: ${validIds.join(", ")}`,
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
        instructions,
      },
    },
  };
});
