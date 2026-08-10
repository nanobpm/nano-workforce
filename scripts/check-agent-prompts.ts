// check-agent-prompts — deploy-safety gate for the model-authored `{{template}}` agent prompts.
//
// Since #31 (v0.11.0) each agent's prompt is authored in the BPMN as a deploy-time template
// header, e.g. `<zeebe:header key="io.nanobpm.agentTask.task.prompt" value="{{review-round}}" />`.
// `@nanobpm/urban` substitutes `{{token}}` with `prompts/<token>.md` (nano.app.json
// `models.templates`) at deploy time; the harness (`c8ctl nano work`) does NO substitution and
// relays whatever header ships. So a token that resolves to a missing/blank template — or a blank
// agent-prompt header — runs the agent effectively prompt-less. For `senior:pr-review` that makes
// it improvise as a "reviewer" and escalate with no question (Magikcraft/nano-bpm #597/#599).
//
// urban's deploy only *warns* on an unresolved placeholder and ships the resource with the raw
// token in place — and this project does not tolerate warnings. This guard runs urban's OWN
// substitution (`applyTemplates`, the single source of truth for token scanning/escaping) exactly
// as deploy does and turns any surviving placeholder into a hard failure, plus flags a blank
// template or a blank agent-prompt header (which substitute to an empty prompt without being
// "unresolved"). Importing from `@nanobpm/urban/runtime` also asserts the installed urban is new
// enough to substitute at all (the capability was added in the 0.22 / nano-ide #106 release).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { applyTemplates } from "@nanobpm/urban/runtime";

// The reserved header carrying an agent's base prompt. A blank value here means the agent gets no
// instructions — the exact failure mode we guard against.
const AGENT_PROMPT_HEADER = "io.nanobpm.agentTask.task.prompt";

interface AppManifest {
  models?: { processes?: string[]; decisions?: string[]; forms?: string[]; templates?: string[] };
}

// Mirror urban deploy's `contentTypeFor`: only the escapable model types are substituted.
function contentTypeFor(path: string): string {
  if (path.endsWith(".bpmn") || path.endsWith(".dmn")) return "text/xml";
  if (path.endsWith(".form")) return "application/json";
  return "application/octet-stream";
}

// Minimal `dir/*.ext` glob — the only shape nano.app.json uses. Unknown patterns throw loudly
// rather than silently matching nothing.
function expandGlob(root: string, pattern: string): string[] {
  const m = /^(.*)\/\*\.([A-Za-z0-9]+)$/.exec(pattern);
  if (!m) throw new Error(`check-agent-prompts: unsupported glob pattern "${pattern}"`);
  const [, dir, ext] = m;
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith(`.${ext}`))
    .sort()
    .map((f) => join(dir, f));
}

// The `name -> content` template map urban substitutes from (array source: name = file stem).
function templateMap(root: string, patterns: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pattern of patterns) {
    for (const rel of expandGlob(root, pattern)) {
      const stem = basename(rel).replace(/\.[^.]+$/, "");
      map[stem] = readFileSync(join(root, rel), "utf8");
    }
  }
  return map;
}

// Blank reserved agent-prompt headers in a BPMN source — the one blank case urban's `unresolved`
// signal can't see (an empty value carries no `{{token}}` to be unresolved).
function hasBlankAgentPromptHeader(bpmn: string): boolean {
  const re = /<zeebe:header\s+key="([^"]*)"\s+value="([^"]*)"\s*\/?>/g;
let m = re.exec(bpmn);
while (m !== null) {
    if (m[1] === AGENT_PROMPT_HEADER && m[2].trim() === "") return true;
  m = re.exec(bpmn);
}
return false;
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  /** template names successfully substituted into a model — surfaced for the CLI summary line. */
  resolved: string[];
}

export function checkAgentPrompts(root: string): CheckResult {
  const errors: string[] = [];
  const resolved = new Set<string>();

  const manifestPath = join(root, "nano.app.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`nano.app.json not found under ${root}`], resolved: [] };
  }
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AppManifest;
  const models = manifest.models ?? {};
  const templates = templateMap(root, models.templates ?? []);

  // A declared-but-blank template substitutes to an empty prompt without being "unresolved" —
  // catch it up front (urban would silently produce a blank prompt).
  for (const [name, body] of Object.entries(templates)) {
    if (body.trim() === "") errors.push(`template {{${name}}} is empty — it would substitute to a blank prompt`);
  }

  const modelFiles = [
    ...(models.processes ?? []),
    ...(models.decisions ?? []),
    ...(models.forms ?? []),
  ].flatMap((p) => expandGlob(root, p));
  if (modelFiles.length === 0) {
    errors.push(`no model files matched ${JSON.stringify(models.processes ?? [])}`);
  }

  for (const rel of modelFiles) {
    const contentType = contentTypeFor(rel);
    if (contentType === "application/octet-stream") continue; // urban does not substitute these
    const content = readFileSync(join(root, rel), "utf8");

    // Run urban's canonical substitution — the same call deploy makes — and fail on any token it
    // leaves unresolved (deploy only warns, which we don't tolerate).
    const applied = applyTemplates(content, contentType, templates);
    for (const name of applied.unresolved) {
      errors.push(
        `${rel}: unresolved template {{${name}}} — no such template is declared in models.templates`,
      );
    }
    for (const name of Object.keys(templates)) {
      if (content.includes(`{{${name}}}`)) resolved.add(name);
    }

    if (hasBlankAgentPromptHeader(content)) {
      errors.push(`${rel}: a reserved "${AGENT_PROMPT_HEADER}" header is empty (agent would run prompt-less)`);
    }
  }

  return { ok: errors.length === 0, errors, resolved: [...resolved].sort() };
}

// CLI: check the repo rooted at cwd. Exit non-zero (fail CI) on any problem.
if (import.meta.main) {
  const root = process.cwd();
  const { ok, errors, resolved } = checkAgentPrompts(root);
  if (!ok) {
    console.error(`✖ agent prompt check failed (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✔ agent prompt templates resolve (${resolved.length}: ${resolved.join(", ")})`);
}
