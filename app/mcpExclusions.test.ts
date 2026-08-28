// Authoring guard for the `x-mcp` MCP tool-exclusion switch (ADR 0067 §2, nano-ide#488 slice 3;
// adopted here as slice 4, issue #567).
//
// The runtime-served MCP surface (`/app/mcp`) projects every non-excluded `openapi.yaml` operation
// into an MCP tool. An operation opts OUT with the `x-mcp` extension — `x-mcp: false` or
// `x-mcp: { exclude: true }`; any other value (or its absence) leaves it exposed. That switch is
// security-relevant: it is the one authoring control that keeps an operator-only door off the
// agent-facing tool surface, so this test pins the intended exclusion set at the spec level.
//
// The runtime's own spec<->tool parity guard (`check:mcp`, ADR 0067) lives in `@nanobpm/urban` and
// honours the same extension from the same `collectOperations` walker; this app-side test is the
// authoring assertion that OUR operator doors carry the switch and that no agent-facing operation
// was excluded by accident. It reuses the exact ADR rule rather than re-deriving a second one.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { assert, assertEquals } from "#test-assert";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SPEC_PATH = join(REPO_ROOT, "openapi.yaml");

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);

// The ADR 0067 exclusion rule, applied to a single operation object's `x-mcp` value.
function isExcluded(operation: Record<string, unknown>): boolean {
  const marker = operation["x-mcp"];
  if (marker === false) return true;
  if (marker && typeof marker === "object" && "exclude" in marker) {
    return Reflect.get(marker, "exclude") === true;
  }
  return false;
}

// Every (operationId -> excluded?) pair in the spec, walking paths x methods exactly as the runtime
// projection enumerates operations.
function operationExclusions(): Map<string, boolean> {
  const spec = parse(readFileSync(SPEC_PATH, "utf8"));
  const paths = spec?.paths;
  assert(paths && typeof paths === "object", "openapi.yaml has no paths object");
  const result = new Map<string, boolean>();
  for (const item of Object.values(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== "object") continue;
      const operation: Record<string, unknown> = op;
      const operationId = operation.operationId;
      if (typeof operationId !== "string") continue;
      result.set(operationId, isExcluded(operation));
    }
  }
  return result;
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
  const exclusions = operationExclusions();
  const excluded = [...exclusions.entries()].filter(([, ex]) => ex).map(([id]) => id).sort();
  assertEquals(excluded, [...EXPECTED_EXCLUDED].sort());
});

test("x-mcp leaves the agent-facing drive/preview/read operations exposed", () => {
  const exclusions = operationExclusions();
  for (const id of EXPECTED_EXPOSED) {
    assert(exclusions.has(id), `expected operation ${id} to exist in openapi.yaml`);
    assertEquals(exclusions.get(id), false, `operation ${id} must NOT be x-mcp excluded`);
  }
});
