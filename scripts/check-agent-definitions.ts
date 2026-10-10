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
//      prompt-link-keyed scanner. The compiler now emits the marker on EVERY `agent` cell and links
//      the job type's base prompt via `AGENT_JOB_TYPE_PROMPT` for a MAPPED job type (a bespoke
//      `senior:<task>` with no deployed prompt is deliberately prompt-LESS). This gate compiles a
//      representative graph — including an UNMAPPED, prompt-less probe cell — and runs BOTH scanners
//      over the OUTPUT: the prompt-keyed one (mapped cells) and the type-keyed
//      `externalAgentTaskTypesMissingMarker`, which keys a task as an agent by its `<rank>:<task>`
//      colon-form type ALONE, so a marker regression on a prompt-less cell cannot hide behind the
//      prompt-keyed scan's blind spot (PR #886 review). It also resolves EVERY
//      `AGENT_JOB_TYPE_PROMPT` entry against the deployed `resources/` prompt set, so a mapping
//      cannot drift to an undeployed resourceId while CI stays green (the engine silently omits an
//      unresolvable link — the agent would run prompt-less).
//
// In the hand-authored corpus a `senior:*` task is identified by its prompt link (not the `senior:`
// prefix alone) because that is what makes it a fleet AGENT task the harness serves; a plain host job
// (`pr.finalize`) carries no prompt link and is correctly out of scope there. The scanners are the
// ONE canonical implementations — this gate DERIVES all its halves from them rather than
// re-implementing a second, driftable regex.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentTaskTypesMissingExternalMarker,
  externalAgentTaskTypesMissingMarker,
  promptBearingTaskTypes,
} from "../app/agentic/vocab/job-types.ts";
import { AGENT_JOB_TYPE_PROMPT, compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSES_DIR = join(ROOT, "resources/processes");
const RESOURCES_DIR = join(ROOT, "resources");

// The agent job type the compiled-output probe uses for a cell with NO deployed base prompt: absent
// from `AGENT_JOB_TYPE_PROMPT`, so the compiler deliberately emits NO prompt link for it — the exact
// shape the prompt-keyed scanner cannot see (PR #886 review).
const UNMAPPED_PROBE_JOB_TYPE = "senior:bespoke-unmapped";

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
      // An agent cell with NO deployed base prompt (absent from `AGENT_JOB_TYPE_PROMPT`): the compiler
      // deliberately emits NO prompt link for it, so the prompt-keyed scanner never sees the cell —
      // the false-negative path the PR #886 review cited. Probe the shape so the type-keyed marker
      // scan below covers it.
      { id: "bespoke", kind: "agent", agent: { jobType: UNMAPPED_PROBE_JOB_TYPE } },
    ],
    edges: [
      { from: "impl", to: "review" },
      { from: "review", to: "bespoke" },
    ],
  });
  if (!r.ok) {
    return { ok: false, errors: [`delivery-graph compiler rejected the probe graph: ${JSON.stringify(r.errors)}`], agentTypes: [] };
  }
  const agentTypes = promptBearingTaskTypes(r.bpmn);
  // The compiled MAPPED agent cells must be prompt-bearing (the linked base prompt) — that is what
  // makes them VISIBLE to the prompt-keyed marker scanner. If a regression drops the prompt link,
  // those cells go invisible and the prompt-keyed scan would pass vacuously, so assert the link
  // presence explicitly first.
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
  // … then inspect EVERY generated agent service task for the marker INDEPENDENTLY of prompt-bearing
  // status (PR #886 review): the type-keyed scan sees the prompt-less unmapped probe cell too, so a
  // compiler regression that drops the marker on a cell whose prompt link is absent (or was dropped
  // with it) can no longer hide behind the prompt-keyed scan's blind spot.
  const missingTypeKeyed = externalAgentTaskTypesMissingMarker(r.bpmn);
  if (missingTypeKeyed.length > 0) {
    errors.push(
      `compiled delivery-graph agent cell(s) missing <zeebe:agentDefinition agentType="external" /> ` +
        `(type-keyed scan, prompt-link-independent) — ${missingTypeKeyed.join(", ")} (the compiler must ` +
        "emit the marker on EVERY agent cell, including a prompt-less unmapped one, issue #884)",
    );
  }
  // Sanity: the unmapped probe cell really compiled into the output (the type-keyed scan is not
  // vacuously green over a graph that lost its prompt-less cell).
  if (!r.bpmn.includes(`type="${UNMAPPED_PROBE_JOB_TYPE}"`)) {
    errors.push(
      `the compiled probe graph lost its unmapped (prompt-less) agent cell ${UNMAPPED_PROBE_JOB_TYPE} — ` +
        "the type-keyed marker scan would be vacuously green over it",
    );
  }
  return { ok: errors.length === 0, errors, agentTypes: [...agentTypes, UNMAPPED_PROBE_JOB_TYPE].sort() };
}

/**
 * Resolve EVERY `AGENT_JOB_TYPE_PROMPT` job-type→prompt mapping against the prompt resources the app
 * actually deploys (PR #886 review). The registry duplicates the job-type→prompt relationship the
 * hand-authored BPMN corpus authors per task, but `check:prompts` scans only the corpus's XML
 * links — it never sees the compiler's map — so an entry could drift to an undeployed/typo'd
 * resourceId while CI stays green, and the engine would silently omit the link (the compiled agent
 * runs prompt-less). This gate derives the deployed prompt-resource ids the SAME way urban's
 * convention walk does (every file under `resources/`, id = path relative to `resources/`) and
 * fails on any mapping that names a resource id outside that set. `mappings` is injectable so the
 * red-path test can exercise a drifting entry without touching the real registry.
 */
export function checkJobTypePromptMappings(
  mappings: Readonly<Record<string, string>> = AGENT_JOB_TYPE_PROMPT,
): AgentDefinitionCheckResult {
  const errors: string[] = [];
  // The deployed resource ids, derived the SAME way urban's convention walk deploys them: every
  // FILE under `resources/` at any depth, id = path relative to `resources/` (POSIX separators).
  // Walk with dirents (mirroring check-agent-prompts' discoverResources) so a DIRECTORY entry is
  // never mistaken for a deployable file on a Node version whose recursive readdir emits one.
  const deployed = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isFile()) {
        deployed.add(relative(RESOURCES_DIR, abs).split("\\").join("/"));
      } else if (entry.isDirectory()) {
        walk(abs);
      }
    }
  };
  walk(RESOURCES_DIR);
  const agentTypes: string[] = [];
  for (const [jobType, resourceId] of Object.entries(mappings).sort(([a], [b]) => a.localeCompare(b))) {
    agentTypes.push(jobType);
    if (!deployed.has(resourceId)) {
      errors.push(
        `AGENT_JOB_TYPE_PROMPT maps ${jobType} → "${resourceId}", which is NOT a deployed resource ` +
          `(no resources/${resourceId} file) — the engine silently omits an unresolvable link, so a ` +
          "compiled cell of this job type would run prompt-less. Point the mapping at a deployed " +
          "resources/prompts/*.md file (or add the prompt), and keep it in lock-step with the " +
          "hand-authored corpus's link for the same job type",
      );
    }
  }
  if (agentTypes.length === 0) {
    errors.push("AGENT_JOB_TYPE_PROMPT is empty — the compiled-cell prompt-link guard would be vacuously green");
  }
  return { ok: errors.length === 0, errors, agentTypes };
}

async function main(): Promise<void> {
  const authored = checkAuthoredProcesses();
  const compiled = await checkCompiledOutput();
  const mappings = checkJobTypePromptMappings();
  const errors = [...authored.errors, ...compiled.errors, ...mappings.errors];
  if (errors.length > 0) {
    console.error(`✖ agent-definition check failed (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `✔ every senior:* agent service task carries <zeebe:agentDefinition agentType="external" /> ` +
      `(authored: ${authored.agentTypes.length} type(s) [${authored.agentTypes.join(", ")}]; ` +
      `compiled: ${compiled.agentTypes.length} type(s) [${compiled.agentTypes.join(", ")}]); ` +
      `all ${mappings.agentTypes.length} job-type→prompt mapping(s) resolve to deployed resources`,
  );
}

// CLI: check the repo rooted at the package root. Exit non-zero (fail CI) on any problem.
if (import.meta.main) {
  await main();
}
