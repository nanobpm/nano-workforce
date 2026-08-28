// Authoring guard for the `x-mcp` MCP tool-exclusion switch (ADR 0067 §2, nano-ide#488 slice 3;
// adopted here as slice 4, issue #567).
//
// The runtime-served MCP surface (`/app/mcp`) projects every non-excluded `openapi.yaml` operation
// into an MCP tool. An operation opts OUT with the `x-mcp` extension — `x-mcp: false` or
// `x-mcp: { exclude: true }`; any other value (or its absence) leaves it exposed. That switch is
// security-relevant: it is the one authoring control that keeps an operator-only door off the
// agent-facing tool surface, so this test pins the intended exclusion set at the spec level.
//
// Derivation over duplication (AGENTS.md): we do NOT re-implement the exclusion rule or the
// path×method walk. We read the projection from the SAME `@nanobpm/urban` walker the runtime MCP
// module builds its live tool list from — `parseSpec` + `collectOperations`, whose `mcpExcluded`
// flag IS `isMcpExcluded` applied at parse time (openapi/spec.ts). This app-side test is therefore
// the authoring assertion that OUR operator doors carry the switch and that no agent-facing
// operation was excluded by accident, checked against the exact rule the runtime honours — no
// second source of truth to drift from it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectOperations, parseSpec } from "@nanobpm/urban/toolkit";
import { assert, assertEquals } from "#test-assert";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SPEC_PATH = join(REPO_ROOT, "openapi.yaml");

// Every operation the runtime projection enumerates, with its `x-mcp` exclusion flag — read from
// the framework walker so this test and the live tool surface can never diverge.
function projectedOperations() {
  return collectOperations(parseSpec(readFileSync(SPEC_PATH, "utf8")));
}

// The operator-only cockpit doors: the staged delivery-graph lifecycle (stage -> dispatch ->
// dismiss) whose approval is a human click in the cockpit (ADR 0005 Decision 7). These — and ONLY
// these — must be excluded from the projected MCP tool surface.
const EXPECTED_EXCLUDED = ["stageDeliveryGraph", "dispatchDeliveryGraph", "dismissProposal"];

// A representative set of agent-facing operations that MUST stay exposed as tools — the drive doors
// (submit PR / epic / delivery-graph set), the pure compile/preview doors, and the read/orientation
// surface an agent debugging a wedged instance relies on.
const EXPECTED_EXPOSED = [
  "startConvergenceLoop",
  "startPlanFanout",
  "startEpicSet",
  "compileDeliveryGraph",
  "previewDeliveryGraph",
  "listStagedProposals",
  "listActivePrs",
  "getAgentInstructions",
  "getVersion",
];

test("x-mcp excludes exactly the operator-only delivery-graph lifecycle doors", () => {
  const excluded = projectedOperations()
    .filter((op) => op.mcpExcluded)
    .map((op) => op.operationId)
    .sort();
  assertEquals(excluded, [...EXPECTED_EXCLUDED].sort());
});

test("x-mcp leaves the agent-facing drive/preview/read operations exposed", () => {
  const byId = new Map(projectedOperations().map((op) => [op.operationId, op]));
  for (const id of EXPECTED_EXPOSED) {
    const op = byId.get(id);
    assert(op, `expected operation ${id} to exist in openapi.yaml`);
    assertEquals(op.mcpExcluded, false, `operation ${id} must NOT be x-mcp excluded`);
  }
});

// The operator guide (workflow knowledge) is discoverable over MCP as the projected
// `getAgentInstructions` READ tool — a safe GET, so the runtime exposes it unguarded on loopback,
// instance-keyed by the same `resolveApiBase` rewriting as its HTTP route. This is how the guide's
// prose reaches an MCP agent; the framework separately serves its derived system brief as a
// resource. Pin the projection facts so an accidental exclusion (or a verb change that would flip
// it into a guarded mutation) fails CI.
test("the operator guide is projected as an unguarded read tool over MCP", () => {
  const op = projectedOperations().find((o) => o.operationId === "getAgentInstructions");
  assert(op, "getAgentInstructions must exist in openapi.yaml");
  assertEquals(op.mcpExcluded, false, "the operator guide must stay exposed over MCP");
  assertEquals(op.method, "get", "the operator guide must be a safe GET so it projects as a read tool");
});
