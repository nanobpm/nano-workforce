// Canonical source of truth for the workforce MCP tool SURFACE budget and the curated driving
// subset (issue #715, epic #605 "tractable surface").
//
// WHY THIS EXISTS
// ===============
// The runtime-served MCP surface (`/app/mcp`, ADR 0067) projects EVERY non-`x-mcp` `openapi.yaml`
// operation — plus the framework-owned `urban_debug_*` engine tools — into a tool. Measured against
// the deployed surface (issue #715) that is **56 tools / ~79 KB of `tools/list`**: large enough that
// an agent harness (Copilot CLI and others) DEFERS the whole set behind a tool-search gate, and a
// client config of `"tools": ["*"]` imports all 56 eagerly. That is the #605 "tractable surface"
// problem, quantified.
//
// The workforce-side lever is TWO-fold, and both live here as one source of truth:
//
//   1. A **budget** on the full projected surface (count + bytes), so the surface can only ever
//      SHRINK below these ceilings — a new door that pushes it over fails CI (`e2e/mcp-tractability.e2e.ts`).
//      The transport-level count reduction (gating rarely-used framework `urban_debug_*` tools
//      behind a mode) lives in the urban runtime and is tracked upstream (nano-ide#488); this budget
//      pins the workforce-visible number so it cannot regress while that lands.
//   2. A **curated subset** — the tools an agent actually drives/reads with day to day — that a
//      client imports via its MCP-server `"tools"` allowlist INSTEAD of `["*"]`, so the eagerly-loaded
//      set is materially smaller than the full surface and stays under the harness deferral threshold.
//      This is the "documented curated subset" the issue's acceptance allows.
//
// DERIVATION OVER DUPLICATION (AGENTS.md)
// =======================================
// This list is the ONE authored source. `e2e/mcp-tractability.e2e.ts` asserts every name here
// actually projects onto the LIVE `/app/mcp` surface (so a curated entry can never go dead), and
// `scripts/sync-mcp-curated.ts` renders it verbatim into the runbook (`docs/mcp-runbook.md`) — a
// drift test under `npm test` (`scripts/sync-mcp-curated.test.ts`, which CI runs) and
// `npm run sync:mcp-curated:check` both fail on any drift. The served "Connect over MCP" page
// (`pages/mcp.page.json`) carries the concept as prose and points here + at the runbook, so there is
// no second enumerated copy to drift. Never hand-edit the curated `tools` block in the runbook; edit
// HERE and re-run `npm run sync:mcp-curated`.

/**
 * The curated driving/reading subset an MCP client should import via its server entry's `"tools"`
 * allowlist instead of `["*"]`. Grouped by intent in authoring order; the union is what a workforce
 * operator/agent needs to drive work, read status, answer escalations, and triage a wedged instance —
 * WITHOUT eagerly loading the whole 56-tool surface. Every name is asserted to project onto the live
 * surface by `e2e/mcp-tractability.e2e.ts`.
 */
export const CURATED_MCP_TOOLS: readonly string[] = [
  // ── Drive / act ──────────────────────────────────────────────────────────
  "startConvergenceLoop",
  "startPlanFanout",
  "startEpicSet",
  "startFeature",
  "compileDeliveryGraph",
  "previewDeliveryGraph",
  "sequenceIssues",
  "agentCompleteEscalation",
  "completeUserTask",
  "cancelInstance",
  "appendBlackboard",
  "readBlackboard",
  // ── Read / orient ────────────────────────────────────────────────────────
  "getVersion",
  "getAgentInstructions",
  "getAgentGuide",
  "listActivePrs",
  "listStagedProposals",
  "listEscalations",
  "getLineage",
  "getPrHistory",
  // ── Engine-truth reads (wedge triage) ────────────────────────────────────
  "urban_debug_search_process_instances",
  "urban_debug_search_element_instance_wait_states",
  "urban_debug_search_incidents",
  "urban_debug_search_variables",
  "urban_debug_search_jobs",
  "urban_debug_instance_state",
  "urban_debug_open_user_tasks",
];

/** The framework-reserved namespace for engine-debug tools (mirrors the runtime's `DEBUG_PREFIX`).
 *  A curated entry with this prefix is a framework tool (not an `openapi.yaml` operation), so the
 *  spec-level unit guard validates it by prefix rather than against the projected operation set. */
export const FRAMEWORK_TOOL_PREFIX = "urban_debug_";

/**
 * Hard CEILING on the projected `tools/list` tool count. The deployed surface measures 56 (issue
 * #715); this budget forbids GROWTH — a new door that pushes the count over fails CI. It is a
 * regression guard, not the reduction itself: the reduction an agent actually experiences comes from
 * importing {@link CURATED_MCP_TOOLS} rather than `["*"]`, and the transport-level shrink of the
 * framework tool family is tracked upstream (nano-ide#488).
 */
export const MCP_TOOL_COUNT_BUDGET = 60;

/**
 * Hard CEILING on the serialized byte size of the full `tools/list` payload (the schema bytes a
 * client must parse). The deployed surface measures ~78,962 bytes (issue #715); this ceiling forbids
 * meaningful growth so a fat new schema cannot silently re-inflate the surface past the harness
 * deferral point.
 */
export const MCP_SURFACE_BYTES_BUDGET = 84_000;

/**
 * The eagerly-loaded curated subset MUST stay materially smaller than the full surface — otherwise it
 * is not "tractable". This ceiling pins the curated set at roughly half the full count so a creeping
 * curation cannot quietly grow back toward `["*"]`.
 */
export const CURATED_MCP_TOOLS_BUDGET = 30;

/**
 * The per-call budget (ms) a heavy tool (synchronous BPMN layout — `compileDeliveryGraph` /
 * `previewDeliveryGraph` / `sequenceIssues`) must complete within so a cold call does not exceed a
 * typical MCP client's request timeout and `-32001` (issue #715 gap 4). Measured cold at ~0.5 s in
 * the hermetic harness; the 4 s ceiling leaves generous headroom while still failing loudly if a
 * heavy door regresses into a multi-second stall.
 */
export const HEAVY_TOOL_BUDGET_MS = 4_000;
