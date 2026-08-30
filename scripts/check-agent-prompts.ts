// check-agent-prompts — deploy-safety gate for the agent prompts, now authored as *linked
// resources* (issue #169) rather than baked `{{token}}` templates.
//
// Since #169 each agent's base prompt is a generic resource: `resources/prompts/<token>.md` is
// deployed as an `application/octet-stream` resource (under the ADR 0062 `resources/` deploy-by-
// convention layout — see nano.app.json, which declares no `models`) and each agent service task
// links it at job-activation time:
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
//      deploys (a file under the `resources/` convention walk, or a manifest `models` override
//      glob). This catches both a typo'd `resourceId` and a prompt that exists on disk but is not
//      wired into the deploy set (so never reaches the engine — the link would resolve to nothing).
//   2. Each linked prompt file must be non-blank and must teach the agent to emit a machine-readable
//      result (`$AGENT_RESULT_FILE`, or the `::nano:result::` stdout fallback) — a prose-only agent
//      leaves `status` blank and the status gateway escalates/stalls (the fix-ci/rebase gap behind
//      Magikcraft/nano-bpm#746's stuck merge).
//   3. No service task may still carry the retired baked `io.nanobpm.agentTask.task.prompt` header:
//      the deploy no longer substitutes `{{token}}` templates, so such a header would ship a literal
//      `{{token}}` (or stale frozen text) as the prompt.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

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

// The convention directory (ADR 0062): deploy-only, walked one level deep when the manifest declares
// no `models`. Must stay in lock-step with urban's `RESOURCES_DIR`/`deployModels`.
const RESOURCES_DIR = "resources";

// Mirror urban's deploy-by-convention walk (ADR 0062): when the manifest declares no `models`, the
// deployables are every file directly under `resources/` PLUS every file one directory deeper
// (`resources/<subdir>/*`) — shallow, one level only. Deeper nesting is intentionally NOT swept in:
// the deploy dedupe key is the basename, so a deep walk would reintroduce cross-directory basename
// collision risk. Paths come back repo-relative (with `/`), matching `expandGlob`'s output so the
// two discovery modes are interchangeable downstream.
function discoverResources(root: string): string[] {
  const base = join(root, RESOURCES_DIR);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.isFile()) {
      out.push(join(RESOURCES_DIR, entry.name));
    } else if (entry.isDirectory()) {
      const sub = join(base, entry.name);
      for (const f of readdirSync(sub, { withFileTypes: true })) {
        if (f.isFile()) out.push(join(RESOURCES_DIR, entry.name, f.name));
      }
    }
  }
  return out.sort();
}

// The deployed `resourceId` a `linkName="prompt"` link must reference. Kept in lock-step with
// urban's deploy.js: a CONVENTION resource (no `models` block) is keyed by its path relative to
// `resources/` (POSIX) — `resources/prompts/plan.md` → `prompts/plan.md`; a `models` OVERRIDE
// resource is keyed by its basename. This is the exact string the engine matches a linkedResource
// `resourceId` against at activation, so the gate must reason about it (not the bare basename) —
// otherwise a prompt moved into a sub-directory deploys as `prompts/plan.md` while a stale bare
// `resourceId="plan.md"` link resolves to nothing and the agent runs prompt-less.
function deployResourceId(rel: string, byConvention: boolean): string {
  if (!byConvention) return basename(rel);
  const posix = rel.split(sep).join("/");
  const prefix = `${RESOURCES_DIR}/`;
  return posix.startsWith(prefix) ? posix.slice(prefix.length) : basename(rel);
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

// Escape a literal string for safe embedding in a RegExp — the header key contains dots that would
// otherwise act as wildcards and match unintended header keys.
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Any surviving retired baked-prompt header — a migration regression. XML attribute order is not
// significant, so match the `key` attribute anywhere within the opening `<zeebe:header …>` tag (not
// only immediately after the element name) — otherwise a reordered header would bypass the guard.
function hasRetiredPromptHeader(bpmn: string): boolean {
  return new RegExp(`<zeebe:header\\s[^>]*\\bkey="${escapeRegExp(RETIRED_PROMPT_HEADER)}"`).test(bpmn);
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

  // The resources the app actually DEPLOYS. Under ADR 0062 deploy-by-convention this is derived the
  // SAME way urban's deployModels derives it, so this gate reasons about exactly the file set that
  // ships to the engine:
  //   • no `models` block → discover by convention: every file under `resources/` (shallow, one
  //     level deep). This is nwf's blessed layout — prompts live at `resources/prompts/*.md`.
  //   • `models` globs present → explicit override, used verbatim (the escape hatch for a
  //     non-convention layout). A declared-but-empty `models` is still an override, NOT a fallback
  //     to the convention walk — mirror deployModels, which keys convention off the block's absence.
  // Either way a deployed resource's id is what a `linkedResource resourceId` must reference — for a
  // convention resource its path relative to `resources/` (`prompts/plan.md`), for a `models`
  // override its basename (see deployResourceId) — which is what catches a prompt that exists on
  // disk but is not actually deployed under the id the link names (so the link resolves to nothing).
  const byConvention = manifest.models === undefined;
  const deployedRels = byConvention
    ? discoverResources(root)
    : [
        ...(manifest.models?.processes ?? []),
        ...(manifest.models?.decisions ?? []),
        ...(manifest.models?.forms ?? []),
      ].flatMap((p) => expandGlob(root, p));

  // Keyed by the DEPLOYED resourceId a link references: the path relative to `resources/` for a
  // convention resource, or the basename for a `models` override (see deployResourceId). Two
  // deployables that would deploy under the same id clobber each other at the engine, so a
  // `resourceId` lookup could resolve to the wrong file (or mask a misconfiguration). Fail fast on
  // the collision so the lookup stays unambiguous.
  const deployedFiles = new Map<string, string>();
  for (const rel of deployedRels) {
    const name = deployResourceId(rel, byConvention);
    const prior = deployedFiles.get(name);
    if (prior != null && prior !== rel) {
      errors.push(
        `duplicate deployed resource id "${name}": both "${prior}" and "${rel}" deploy under the ` +
          `same id, so a linkName="prompt" resourceId="${name}" would resolve ambiguously — ` +
          `rename one so deployed resource ids stay unique`,
      );
      continue;
    }
    deployedFiles.set(name, rel);
  }

  // The model files whose XML we scan for `<zeebe:linkedResource>` links.
  const xmlModelFiles = deployedRels.filter((rel) => contentTypeFor(rel) === "text/xml");
  if (xmlModelFiles.length === 0) {
    errors.push(
      byConvention
        ? `no BPMN/DMN model files found under ${RESOURCES_DIR}/ by convention`
        : "no BPMN/DMN model files matched the manifest's models globs",
    );
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
            `no deployed resource has that name — no file under the app's deploy set (the ` +
            `resources/ convention walk, or the manifest's models globs) matches it, so the engine ` +
            `would omit the link and the agent would run prompt-less`,
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
