// The agent operator guide served by GET /app/api/agent (operationId `getAgentInstructions`).
//
// The guide itself is authored as plain markdown in `resources/agent-guide.md` (kept out of
// `prompts/` so it is NOT treated as a deployable agent template) and read from the checkout at
// module load — same "run the .ts sources directly, inspect the working tree at runtime" approach
// as version.ts. Two placeholders are substituted per request/deployment so the embedded examples
// are copy-pasteable against THIS instance:
//   • __BASE__   → the app control-API base the caller reached us on (e.g. https://host/app/api)
//   • __ENGINE__ → the engine's Camunda-8 v2 REST base this app is configured to talk to
//
// Reading is best-effort: a missing file yields a short built-in fallback rather than throwing, so
// the endpoint never 500s just because the doc is absent from a stripped-down deploy.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUIDE_PATH = join(REPO_ROOT, "resources", "agent-guide.md");

// Read the raw guide once, at module load. Frozen for the life of the process.
const RAW_GUIDE: string = (() => {
  try {
    return readFileSync(GUIDE_PATH, "utf8");
  } catch {
    return [
      "# Nano Workforce — agent operator guide",
      "",
      "The full guide document could not be read from this deployment.",
      "",
      "Key endpoints (under the app control-API base `__BASE__`):",
      "- `GET /status` — every PR in flight, with its engine `processKey` and any open escalation.",
      "- `GET /version` — which code is live.",
      "- `POST /actions/start/convergence-loop` — submit a PR (`{ pr, convergeOnly?, maxRounds?, dependsOn? }`).",
      "- `POST /actions/start/plan-fanout` — submit an epic (`{ issue }`).",
      "- `POST /actions/message` — answer an escalation (`escalation-answered`, correlate by PR key).",
      "",
      "Engine (Camunda-8 v2 REST) base for debugging: `__ENGINE__`.",
      "Source repository: `nanobpm/nano-workforce`.",
      "",
    ].join("\n");
  }
})();

/**
 * The engine's Camunda-8 v2 REST base this app talks to, resolved exactly as `main.ts` does:
 * an explicit `CAMUNDA_REST_ADDRESS` wins, else `${NANOBPMN_BASE_URL}/v2` (default localhost:8080).
 * Trailing slashes are trimmed so the guide's `__ENGINE__/jobs/search` examples are well-formed.
 */
export function resolveEngineBase(): string {
  const explicit = process.env.CAMUNDA_REST_ADDRESS;
  const base = explicit?.trim()
    ? explicit.trim()
    : `${(process.env.NANOBPMN_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "")}/v2`;
  return base.replace(/\/+$/, "");
}

/**
 * Render the guide for a given app control-API base (e.g. "https://host/app/api"). The engine base
 * is resolved from the environment. Substitutes every `__BASE__`/`__ENGINE__` occurrence.
 */
export function renderAgentGuide(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return RAW_GUIDE.replaceAll("__BASE__", base).replaceAll("__ENGINE__", resolveEngineBase());
}
