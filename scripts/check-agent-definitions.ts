// check-agent-definitions — repo-wide CI gate (issue #884) for the engine-native AgentTask marker:
// EVERY `senior:*` agent service task the app deploys must carry
// `<zeebe:agentDefinition agentType="external" />` INSIDE its `<bpmn:extensionElements>`, as a sibling
// of its `<zeebe:taskDefinition type="senior:*"/>` dispatch verb. Without the marker the engine refuses
// to attach an AgentInstance to the element (`createAgentInstance failed — … has no agentDefinition`),
// so the agent run persists NO durable agentic transcript — the exact #884 failure (269 failed creates
// on omarchy across three compiled delivery-graph processes).
//
// The defect CLASS is "every agent service task the app generates", and there are TWO producers:
//
//   1. The HAND-AUTHORED corpus — `resources/processes/*.bpmn`. The canonical scanner
//      (`agentTaskTypesMissingExternalMarker`, `app/agentic/vocab/job-types.ts`) keys a service task as
//      an AGENT by its `<zeebe:linkedResource … linkName="prompt">` (the base-prompt link every fleet
//      agent task carries) and fails any such task with no external marker. This is the SAME scan the
//      `agent-marker.test.ts` unit guard runs — kept here as a standalone, fast CI gate (alongside
//      `check:prompts`) so the corpus invariant is visible as its own check, not only inside the test
//      suite.
//
//   2. The delivery-graph COMPILER (`app/deliveryGraphCompiler.ts`) — the producer #884 caught. Its
//      compiled cells carried NO marker AND no prompt link, so they were invisible to the
//      prompt-link-keyed scanner. The compiler now emits BOTH on every `agent` cell (the marker, and
//      the job type's base-prompt link via `AGENT_JOB_TYPE_PROMPT`), so a compiled cell IS
//      prompt-bearing and the SAME scanner sees it. This gate compiles a representative graph and runs
//      the scanner over the OUTPUT, so a compiler regression that drops the marker (or the link that
//      makes the cell visible) fails the build — not silently at runtime.
//
// A `senior:*` task is identified by its prompt link (not the `senior:` prefix alone) because that is
// what makes it a fleet AGENT task the harness serves; a plain host job (`pr.finalize`) carries no
// prompt link and is correctly out of scope. The scanner is the ONE canonical implementation — this
// gate DERIVES both halves from it rather than re-implementing a second, driftable regex.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { agentTaskTypesMissingExternalMarker, promptBearingTaskTypes } from "../app/agentic/vocab/job-types.ts";
import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSES_DIR = join(ROOT, "resources/processes");

// urban deploys `resources/` recursively (every file at any depth), so a process model added under a
// subdirectory would still deploy — walk recursively here too, or the guard would miss it and let an
// unmarked agent task slip through. Mirrors `agent-marker.test.ts`'s `bpmnFiles()`.
function bpmnFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".bpmn") ? [relative(PROCESSES_DIR, full)] : [];
    });
  return walk(PROCESSES_DIR).sort();
}

export interface AgentDefinitionCheckResult {
  ok: boolean;
  errors: string[];
  /** prompt-bearing agent job types found across the hand-authored corpus (for the CLI summary). */
  agentTypes: string[];
}

/** Scan the HAND-AUTHORED deployed corpus (`resources/processes/*.bpmn`). */
export function checkAuthoredProcesses(): AgentDefinitionCheckResult {
  const errors: string[] = [];
  const agentTypes = new Set<string>();
  for (const file of bpmnFiles()) {
    const xml = readFileSync(join(PROCESSES_DIR, file), "utf8");
    for (const t of promptBearingTaskTypes(xml)) agentTypes.add(t);
    const missing = agentTaskTypesMissingExternalMarker(xml);
    if (missing.length > 0) {
      errors.push(
        `resources/processes/${file}: agent task(s) missing <zeebe:agentDefinition agentType="external" /> — ` +
          `${missing.join(", ")} (every senior:* agent task must carry the marker so the engine mints a ` +
          `durable AgentInstance/transcript for it, issue #745/#884)`,
      );
    }
  }
  if (agentTypes.size === 0) {
    errors.push("no prompt-bearing agent task found in resources/processes — the guard would be vacuously green");
  }
  return { ok: errors.length === 0, errors, agentTypes: [...agentTypes].sort() };
}

/** Scan the delivery-graph COMPILER's output — the second producer of agent service tasks (#884). */
export async function checkCompiledOutput(): Promise<AgentDefinitionCheckResult> {
  const errors: string[] = [];
  const r = await compileDeliveryGraph({
    nodes: [
      { id: "impl", kind: "agent", agent: { jobType: "senior:feature", prompt: "implement #1" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "review", kind: "agent", agent: { jobType: "senior:pr-review" } },
    ],
    edges: [{ from: "impl", to: "review" }],
  });
  if (!r.ok) {
    return { ok: false, errors: [`delivery-graph compiler rejected the probe graph: ${JSON.stringify(r.errors)}`], agentTypes: [] };
  }
  const agentTypes = promptBearingTaskTypes(r.bpmn);
  // The compiled agent cells must be prompt-bearing (the linked base prompt) — that is what makes them
  // VISIBLE to the marker scanner. If a regression drops the prompt link, the cells go invisible and the
  // marker scan would pass vacuously, so assert the link presence explicitly first.
  if (agentTypes.length === 0) {
    errors.push(
      "compiled delivery-graph agent cells are NOT prompt-bearing — the compiler no longer links a base " +
        "prompt (linkName=\"prompt\"), so the agentDefinition scan cannot see them (issue #884)",
    );
  }
  const missing = agentTaskTypesMissingExternalMarker(r.bpmn);
  if (missing.length > 0) {
    errors.push(
      `compiled delivery-graph agent cell(s) missing <zeebe:agentDefinition agentType="external" /> — ` +
        `${missing.join(", ")} (the compiler must emit the marker on every agent cell, issue #884)`,
    );
  }
  return { ok: errors.length === 0, errors, agentTypes };
}

async function main(): Promise<void> {
  const authored = checkAuthoredProcesses();
  const compiled = await checkCompiledOutput();
  const errors = [...authored.errors, ...compiled.errors];
  if (errors.length > 0) {
    console.error(`✖ agent-definition check failed (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `✔ every senior:* agent service task carries <zeebe:agentDefinition agentType="external" /> ` +
      `(authored: ${authored.agentTypes.length} type(s) [${authored.agentTypes.join(", ")}]; ` +
      `compiled: ${compiled.agentTypes.length} type(s) [${compiled.agentTypes.join(", ")}])`,
  );
}

// CLI: check the repo rooted at the package root. Exit non-zero (fail CI) on any problem.
if (import.meta.main) {
  await main();
}
