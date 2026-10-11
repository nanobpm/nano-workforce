// check-agent-definitions — repo-wide CI gate (issue #884) for the engine-native AgentTask marker:
// EVERY `senior:*` agent service task the app deploys must carry
// `<zeebe:agentDefinition agentType="external" />` INSIDE its `<bpmn:extensionElements>`, as a sibling
// of its `<zeebe:taskDefinition type="senior:*"/>` dispatch verb. Without the marker the engine refuses
// to attach an AgentInstance to the element (`createAgentInstance failed — … has no agentDefinition`),
// so the agent run persists NO durable agentic transcript — the exact #884 failure (269 failed creates
// on omarchy across three compiled delivery-graph processes).
//
// The defect CLASS is "every agent service task the app generates", and there are TWO producers.
// Both are checked against the SAME union invariant `missingExternalMarkerAgentTaskTypes`
// (`app/agentic/vocab/job-types.ts`) — the union of the two marker scanners, each of which alone has
// a blind spot (PR #886 review):
//
//   • the prompt-keyed `agentTaskTypesMissingExternalMarker` keys a task as an AGENT by its
//     `<zeebe:linkedResource … linkName="prompt">` (the base-prompt link a fleet agent task carries),
//     so it cannot see a DELIBERATELY prompt-less agent cell; and
//   • the type-keyed `externalAgentTaskTypesMissingMarker` keys it by its `<rank>:<task>` colon-form
//     type ALONE, covering the prompt-less case.
//
// Scanning a corpus with only ONE leaves the other's blind spot open — a `senior:*` task that loses
// BOTH its prompt link and its marker would pass a prompt-keyed-only gate. The union closes that for
// every producer:
//
//   1. The HAND-AUTHORED corpus — `resources/processes/**.bpmn`. `checkAuthoredProcesses` runs the
//      union over every deployed model. This is the SAME invariant the `agent-marker.test.ts` unit
//      guard rests on — kept here as a standalone, fast CI gate (alongside `check:prompts`) so the
//      corpus invariant is visible as its own check, not only inside the test suite.
//
//   2. The delivery-graph COMPILER (`app/deliveryGraphCompiler.ts`) — the producer #884 caught. Its
//      compiled cells carried NO marker AND no prompt link, so they were invisible to the
//      prompt-link-keyed scanner. The compiler now emits the marker on EVERY `agent` cell — and, per
//      the resolved "Decide" half of #884 (Option (a), PR #886 review), NO base-prompt link: the
//      hand-authored process prompts are process-specific contracts (they require process variables
//      and a `feat/<task.id>` branch the generic compiled cell never supplies), so a compiled cell is
//      deliberately prompt-LESS and steered by its per-node `appendPrompt` alone. This gate compiles a
//      representative graph — including a prompt-less probe cell — and runs the SAME union over the
//      OUTPUT, so a marker regression on a prompt-less cell cannot hide behind the prompt-keyed scan's
//      blind spot.
//
// In the hand-authored corpus a `senior:*` task is identified by its prompt link OR its colon-form
// type; a plain host job (`pr.finalize`, dot-form, no prompt link) is correctly out of scope. The
// scanners are the ONE canonical implementations — this gate DERIVES all its halves from them rather
// than re-implementing a second, driftable regex.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  missingExternalMarkerAgentTaskTypes,
  promptBearingTaskTypes,
} from "../app/agentic/vocab/job-types.ts";
import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSES_DIR = join(ROOT, "resources/processes");

// The agent job type the compiled-output probe uses for a cell with NO base-prompt link (every
// compiled agent cell is prompt-less per the resolved #884 "Decide" — Option (a)). It is colon-form
// (`<rank>:<task>`) so the type-keyed marker scanner keys it as an agent — the exact prompt-less shape
// the prompt-keyed scanner cannot see (PR #886 review).
const PROMPTLESS_PROBE_JOB_TYPE = "senior:bespoke-promptless";

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

/** One hand-authored BPMN document to scan: its path (relative to `resources/processes`) and XML. */
export interface AuthoredDoc {
  file: string;
  xml: string;
}

/** Read the hand-authored deployed corpus (`resources/processes/**.bpmn`) off disk. */
function authoredDocs(): AuthoredDoc[] {
  return bpmnFiles().map((file) => ({ file, xml: readFileSync(join(PROCESSES_DIR, file), "utf8") }));
}

/**
 * Scan the HAND-AUTHORED deployed corpus (`resources/processes/**.bpmn`). `docs` is injectable so the
 * red-path test can feed a drifting document without writing to the corpus; it defaults to the real
 * on-disk corpus. Every agent task — prompt-bearing OR deliberately prompt-less — must carry the
 * external marker, so this holds the SAME union invariant as the compiled half (PR #886 review).
 */
export function checkAuthoredProcesses(docs: readonly AuthoredDoc[] = authoredDocs()): AgentDefinitionCheckResult {
  const errors: string[] = [];
  const agentTypes = new Set<string>();
  for (const { file, xml } of docs) {
    for (const t of promptBearingTaskTypes(xml)) agentTypes.add(t);
    const missing = missingExternalMarkerAgentTaskTypes(xml);
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
      // A prompt-LESS agent cell (every compiled agent cell is prompt-less per the resolved #884
      // "Decide" — Option (a)). The prompt-keyed scanner never sees it, so probe the shape to keep the
      // type-keyed marker scan below covering it (PR #886 review).
      { id: "bespoke", kind: "agent", agent: { jobType: PROMPTLESS_PROBE_JOB_TYPE } },
    ],
    edges: [
      { from: "impl", to: "review" },
      { from: "review", to: "bespoke" },
    ],
  });
  if (!r.ok) {
    return { ok: false, errors: [`delivery-graph compiler rejected the probe graph: ${JSON.stringify(r.errors)}`], agentTypes: [] };
  }
  // Inspect EVERY generated agent service task for the marker via the single union invariant
  // (`missingExternalMarkerAgentTaskTypes`). Every compiled agent cell is prompt-LESS (Option (a)), so
  // it is the type-keyed half of the union (keyed by the `<rank>:<task>` colon-form type alone) that
  // sees these cells — a compiler regression that drops the marker on a prompt-less cell cannot hide
  // behind the prompt-keyed scan's blind spot (PR #886 review).
  const missing = missingExternalMarkerAgentTaskTypes(r.bpmn);
  if (missing.length > 0) {
    errors.push(
      `compiled delivery-graph agent cell(s) missing <zeebe:agentDefinition agentType="external" /> — ` +
        `${missing.join(", ")} (the compiler must emit the marker on EVERY agent cell, including a ` +
        "prompt-less one, issue #884)",
    );
  }
  // Sanity: the prompt-less probe cell really compiled into the output (the type-keyed scan is not
  // vacuously green over a graph that lost its prompt-less cell).
  if (!r.bpmn.includes(`type="${PROMPTLESS_PROBE_JOB_TYPE}"`)) {
    errors.push(
      `the compiled probe graph lost its prompt-less agent cell ${PROMPTLESS_PROBE_JOB_TYPE} — ` +
        "the type-keyed marker scan would be vacuously green over it",
    );
  }
  // The agent job types this probe compiled (for the CLI summary) — derived by the SAME type-keyed
  // grammar the marker scanner uses, since the cells are prompt-less (a prompt-keyed list is empty).
  const agentTypes = [
    ...new Set(
      [...r.bpmn.matchAll(/<(?:\w+:)?taskDefinition\b[^>]*\btype="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((t) => t.startsWith("senior:")),
    ),
  ];
  return { ok: errors.length === 0, errors, agentTypes: agentTypes.sort() };
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
