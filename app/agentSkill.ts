// The Nano Workforce operator *skill* served by GET /app/api/agent/skill (operationId
// `getAgentSkill`). Companion to the agent guide (app/agentGuide.ts): where the guide is the full,
// instance-keyed playbook, the skill is a small, portable *bootstrap* an agent runtime (Copilot
// CLI, Claude) loads on demand — it resolves which instance to drive and then fetches the live
// guide. The user clicks "Agent Instructions" on the Overview tab, copies the prompt, and the agent
// loads THIS skill from THIS instance.
//
// The skill is authored as plain markdown in `skills/nano-workforce/SKILL.md` (kept OUT of
// `resources/` so the deploy-by-convention walk does NOT treat it as a deployable model, ADR 0062)
// and read from the checkout at module load — same approach as agentGuide.ts / version.ts. A
// `__BASE__` placeholder, if present, is substituted per request so any embedded example is
// copy-pasteable against THIS instance.
//
// Reading is best-effort: a missing file yields a short built-in fallback rather than throwing, so
// the endpoint never 500s just because the skill is absent from a stripped-down deploy.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_PATH = join(REPO_ROOT, "skills", "nano-workforce", "SKILL.md");

// Read the raw skill once, at module load. Frozen for the life of the process.
const RAW_SKILL: string = (() => {
  try {
    return readFileSync(SKILL_PATH, "utf8");
  } catch {
    return [
      "---",
      "name: nano-workforce",
      "description: Drive and debug a running Nano Workforce instance.",
      "---",
      "",
      "# Nano Workforce operator skill",
      "",
      "This skill could not be read from this deployment. Fetch the live operator guide and follow",
      "it instead — it is the authoritative, version-matched playbook:",
      "",
      "    curl -sS __BASE__/agent",
      "",
      "If the instance is secured with a shared secret (NANO_PR_WEBHOOK_SECRET), add its value as an",
      "`x-hook-secret` header. Confirm which instance you are driving before any side-effecting call.",
      "",
    ].join("\n");
  }
})();

/**
 * Render the skill for a given app control-API base (e.g. "https://host/app/api"). Substitutes every
 * `__BASE__` occurrence so any embedded example targets THIS instance.
 */
export function renderAgentSkill(apiBase: string): string {
  return RAW_SKILL.replaceAll("__BASE__", apiBase.replace(/\/+$/, ""));
}
