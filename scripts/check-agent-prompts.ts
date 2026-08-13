// check-agent-prompts — deploy-safety gate for the agent prompts, now authored as *linked
// resources* (issue #169) rather than baked `{{token}}` templates.
//
// Since #169 each agent's base prompt is a generic resource: `prompts/<token>.md` is deployed as
// an `application/octet-stream` resource (via a `models` deploy glob — see nano.app.json) and each
// agent service task links it at job-activation time:
//
//   <zeebe:linkedResources>
//     <zeebe:linkedResource resourceId="review-round.md" bindingType="latest" linkName="prompt" />
//   </zeebe:linkedResources>
//
// The engine resolves the LATEST deployed key for that `resourceId` when the job activates and hands
// the content to the harness in the `linkedResources` activation header. Crucially, the engine
// *silently omits* an unresolvable link (a typo'd or undeployed `resourceId`) from the header — no
// incident — so a mistake yields a blank base prompt at runtime, exactly the prompt-less-agent
// failure that produced the empty "(no question provided)" escalations (Magikcraft/nano-bpm
// #597/#599). This guard turns that silent runtime failure into a hard build failure:
//
//   1. Every `linkName="prompt"` link's `resourceId` MUST match a prompt file that the app actually
//      deploys (a file matched by a `models` deploy glob). This catches both a typo'd `resourceId`
//      and a prompt that exists on disk but is not wired into a deploy glob (so never reaches the
//      engine — the link would resolve to nothing).
//   2. Each linked prompt file must be non-blank and must teach the agent to emit a machine-readable
//      result (`$AGENT_RESULT_FILE`, or the `::nano:result::` stdout fallback) — a prose-only agent
//      leaves `status` blank and the status gateway escalates/stalls (the fix-ci/rebase gap behind
//      Magikcraft/nano-bpm#746's stuck merge).
//   3. No service task may still carry the retired baked `io.nanobpm.agentTask.task.prompt` header:
//      the deploy no longer substitutes `{{token}}` templates, so such a header would ship a literal
//      `{{token}}` (or stale frozen text) as the prompt.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// The retired header that used to carry an agent's baked base prompt. Its continued presence is a
// migration regression (the deploy no longer substitutes templates), so we flag it.
const RETIRED_PROMPT_HEADER = "io.nanobpm.agentTask.task.prompt";

// The `linkName` that designates a linked resource as an agent's base prompt. Other link names (if
// any are ever added) are not agent prompts and are ignored by this guard.
const PROMPT_LINK_NAME = "prompt";

// A prompt link MUST bind `latest` — this whole migration (#169) is about live mid-epic prompt
// updates, which only work when the engine resolves the latest deployed key at activation. A
// missing or different `bindingType` would silently pin/omit the prompt, so the guard fails it.
const PROMPT_BINDING_TYPE = "latest";

interface AppManifest {
  models?: { processes?: string[]; decisions?: string[]; forms?: string[]; templates?: string[] };
}

// Only the escapable model types are XML we scan for `<zeebe:linkedResource>` links.
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

interface PromptLink {
  resourceId: string;
  bindingType: string | null;
}

// Extract the `<zeebe:linkedResource linkName="prompt" …>` links from a BPMN source. Each agent
// service task carries exactly one; a process may host several tasks.
function promptLinks(bpmn: string): PromptLink[] {
  const links: PromptLink[] = [];
  const re = /<zeebe:linkedResource\b([^>]*?)\/?>/g;
  let m = re.exec(bpmn);
  while (m !== null) {
    const attrs = m[1];
    const linkName = /\blinkName="([^"]*)"/.exec(attrs)?.[1];
    if (linkName === PROMPT_LINK_NAME) {
      const resourceId = /\bresourceId="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const bindingType = /\bbindingType="([^"]*)"/.exec(attrs)?.[1] ?? null;
      links.push({ resourceId, bindingType });
    }
    m = re.exec(bpmn);
  }
  return links;
}

// Any surviving retired baked-prompt header — a migration regression.
function hasRetiredPromptHeader(bpmn: string): boolean {
  return new RegExp(`<zeebe:header\\s+key="${RETIRED_PROMPT_HEADER}"`).test(bpmn);
}

// A prompt that drives an agent must tell it how to return a machine-readable result — the
// `$AGENT_RESULT_FILE` write (or the `::nano:result::` stdout fallback). Without it the agent can
// finish with prose only, its `status` variable comes back empty, the status gateway falls through
// to its default escalation arm, and the run parks a human escalation / stalls the merge.
function agentPromptEmitsResult(body: string): boolean {
  return body.includes("AGENT_RESULT_FILE") || body.includes("::nano:result::");
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  /** prompt resource ids (file stems) successfully linked — surfaced for the CLI summary line. */
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

  // The resources the app actually DEPLOYS: every file matched by a deploy glob (processes,
  // decisions, forms). Its deployed resource name is the file's basename — the same string a
  // `linkedResource resourceId` must reference. Building this from the deploy globs (not from the
  // prompts/ directory) is what catches a prompt that exists on disk but is wired only into a
  // non-deploying key (e.g. the retired `models.templates`), so it never reaches the engine.
  const deployGlobs = [
    ...(models.processes ?? []),
    ...(models.decisions ?? []),
    ...(models.forms ?? []),
  ];
  // Keyed by basename (the deployed resource name a `resourceId` references). Two deploy globs
  // matching files with the same basename would silently overwrite here, so a `resourceId` lookup
  // could resolve to the wrong file (or mask a misconfiguration). Fail fast on the collision so the
  // lookup stays unambiguous.
  const deployedFiles = new Map<string, string>();
  for (const rel of deployGlobs.flatMap((p) => expandGlob(root, p))) {
    const name = basename(rel);
    const prior = deployedFiles.get(name);
    if (prior != null && prior !== rel) {
      errors.push(
        `duplicate deployed resource name "${name}": both "${prior}" and "${rel}" deploy under the ` +
          `same basename, so a linkName="prompt" resourceId="${name}" would resolve ambiguously — ` +
          `rename one so deployed resource names stay unique`,
      );
      continue;
    }
    deployedFiles.set(name, rel);
  }

  // The model files whose XML we scan for `<zeebe:linkedResource>` links.
  const xmlModelFiles = deployGlobs
    .flatMap((p) => expandGlob(root, p))
    .filter((rel) => contentTypeFor(rel) === "text/xml");
  if (xmlModelFiles.length === 0) {
    errors.push(`no BPMN/DMN model files matched ${JSON.stringify(deployGlobs)}`);
  }

  let linkCount = 0;
  for (const rel of xmlModelFiles) {
    const content = readFileSync(join(root, rel), "utf8");

    if (hasRetiredPromptHeader(content)) {
      errors.push(
        `${rel}: a retired "${RETIRED_PROMPT_HEADER}" header is still present — migrate it to a ` +
          `<zeebe:linkedResource … linkName="prompt"/> (the deploy no longer substitutes {{token}} templates)`,
      );
    }

    for (const link of promptLinks(content)) {
      linkCount++;
      if (link.resourceId.trim() === "") {
        errors.push(`${rel}: a linkName="prompt" linkedResource has an empty resourceId`);
        continue;
      }
      if (link.bindingType !== PROMPT_BINDING_TYPE) {
        errors.push(
          `${rel}: linkName="prompt" resourceId="${link.resourceId}" has ` +
            `bindingType=${link.bindingType == null ? "(absent)" : `"${link.bindingType}"`} — it must be ` +
            `bindingType="${PROMPT_BINDING_TYPE}" so the engine resolves the latest deployed prompt at ` +
            `activation (mid-epic prompt updates rely on it); any other value silently alters runtime ` +
            `prompt resolution`,
        );
      }
      const deployedRel = deployedFiles.get(link.resourceId);
      if (deployedRel == null) {
        errors.push(
          `${rel}: linkName="prompt" resourceId="${link.resourceId}" has no deployed resource — ` +
            `no file matched by a models deploy glob has that name, so the engine would omit the ` +
            `link and the agent would run prompt-less`,
        );
        continue;
      }
      const body = readFileSync(join(root, deployedRel), "utf8");
      const stem = basename(deployedRel).replace(/\.[^.]+$/, "");
      if (body.trim() === "") {
        errors.push(`prompt resource "${link.resourceId}" is empty — the agent would run prompt-less`);
      } else if (!agentPromptEmitsResult(body)) {
        errors.push(
          `prompt resource "${link.resourceId}" drives an agent but never tells it to write ` +
            `$AGENT_RESULT_FILE (or the ::nano:result:: fallback) — the agent can finish with prose ` +
            `only, leaving its status blank so the process escalates/stalls`,
        );
      }
      resolved.add(stem);
    }
  }

  if (linkCount === 0 && errors.length === 0) {
    errors.push("no linkName=\"prompt\" linkedResource found in any model — agent prompts are unwired");
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
  console.log(`✔ agent prompts link to deployed resources (${resolved.length}: ${resolved.join(", ")})`);
}
