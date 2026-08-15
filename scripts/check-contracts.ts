// check-contracts — CI gate for the shared contract registry (issue #227, ADR 0004).
//
// The registry (`app/contracts.ts`) is the single source of truth for cross-cutting contracts. This
// gate enforces the invariants that make a duplicate/synonymous contract a BUILD failure rather than
// a silent runtime fallback (the #223 / nano-ide #234 failure mode):
//
//   1. EVERY config-family env key read anywhere in the app (`process.env.NANO_*`, `CAMUNDA_*`,
//      `NANOBPMN_BASE_URL`, `PR_REVIEW_PORT`) MUST be declared in the ONE typed schema
//      `ENV_CONTRACTS`. An undeclared config key is a second, unregistered source of truth — fail.
//      The scan recognises all three read patterns the app uses: dot-access (`process.env.KEY`),
//      string-literal bracket-access (`process.env["KEY"]`), and the `envVar("KEY")` helper
//      (`app/version.ts`) — a config key smuggled in through any of them must still be declared.
//   2. NO rejected synonym (a name we deliberately retired, e.g. `NANO_PR_BASE_URL`) may appear in
//      code. Its reappearance is the #223 phantom-fallback cascade — fail.
//   3. The registry must reconcile against itself: no two entries are synonyms, no rejected synonym
//      leaked back into the registry (`reconcileRegistry`).
//
// Scope note: the env-key scan targets the config family (below), NOT every env var — infra reads
// like `NODE_ENV` are not app contracts. `GITHUB_TOKEN`/`CAMUNDA_TOKEN` ARE declared (as secrets) so
// the schema documents them, but they need no fallback default.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileRegistry } from "../app/contractReconcile.ts";
import { ENV_CONTRACTS, rejectedEnvSynonyms } from "../app/contracts.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The directories that hold app code (mirrors the `lint` glob in package.json).
const CODE_DIRS = ["app", "operations", "workers", "pages", "components", "scripts", "e2e"];
const CODE_FILES = ["main.ts"];

// The config-family env-key prefixes/names that MUST be declared in ENV_CONTRACTS. Anything matching
// this and not declared is an unregistered config source of truth.
//
// A config key is read one of three ways in this app, and all three must be held to the registry
// invariant — otherwise a key smuggled in via `envVar("…")` or bracket-access silently bypasses the
// gate (the exact blind spot that let NANO_PR_WEBHOOK_SECRET / NANO_AGENTIC* go undeclared):
//   - dot-access:                 process.env.KEY
//   - string-literal bracket:     process.env["KEY"] / process.env['KEY']
//   - the envVar() helper:        envVar("KEY")  (app/version.ts)
const CONFIG_KEY_MATCHERS: readonly RegExp[] = [
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\benvVar\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
];
const CONFIG_FAMILY = /^(NANO_|NANOBPMN_|CAMUNDA_|PR_REVIEW_)/;
// `GITHUB_TOKEN` is the one production credential read outside the config families (app/service.ts,
// operations/startPlanFanout.ts). It is declared in ENV_CONTRACTS; enforce that declaration here so a
// future removal from the registry while code still reads it trips the gate (issue #227).
export const EXPLICIT_CONFIG_KEYS = new Set(["PR_REVIEW_PORT", "GITHUB_TOKEN"]);

/** Every env-key name read in `src` via any supported pattern (dot-access, string-literal
 * bracket-access, or the `envVar("KEY")` helper). Order-preserving, with duplicates, so a caller can
 * report each read site's key against the registry. */
export function envKeyReads(src: string): string[] {
  const keys: string[] = [];
  for (const matcher of CONFIG_KEY_MATCHERS) {
    for (const m of src.matchAll(matcher)) keys.push(m[1]);
  }
  return keys;
}

// The registry module declares the keys and (in comments/strings) names the rejected synonyms, this
// checker's own doc comment shows the read patterns it scans for, and this checker's test embeds
// literal `process.env[…]` / `envVar(…)` fixtures — all would self-trip the scan, so they are exempt.
const EXEMPT_FILES = new Set([
  "app/contracts.ts",
  "scripts/check-contracts.ts",
  "scripts/check-contracts.test.ts",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "nano-generated" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if ([".ts", ".mts", ".cts"].includes(extname(full))) {
      out.push(full);
    }
  }
}

/** Path of `file` relative to ROOT, normalised to POSIX separators so it matches the POSIX-style
 * `EXEMPT_FILES` entries on every platform (Windows `join` yields backslashes — issue #229 review). */
export function toPosixRel(file: string, root: string = ROOT): string {
  return file.slice(root.length + 1).replaceAll("\\", "/");
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const d of CODE_DIRS) {
    const full = join(ROOT, d);
    try {
      if (statSync(full).isDirectory()) walk(full, files);
    } catch {
      /* dir may not exist in every checkout */
    }
  }
  for (const f of CODE_FILES) {
    const full = join(ROOT, f);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      /* optional */
    }
  }
  return files;
}

function main(): void {
  const declared = new Set(Object.keys(ENV_CONTRACTS));
  const rejected = rejectedEnvSynonyms();
  const errors: string[] = [];

  for (const file of collectFiles()) {
    const rel = toPosixRel(file);
    if (EXEMPT_FILES.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    for (const key of envKeyReads(src)) {
      if (rejected.has(key)) {
        errors.push(
          `  ${rel}: reads retired synonym '${key}' — reuse the canonical key '${rejected.get(key)}'. ` +
            `A retired synonym must never come back as a silent fallback (issue #223).`,
        );
        continue;
      }
      if (!CONFIG_FAMILY.test(key) && !EXPLICIT_CONFIG_KEYS.has(key)) continue;
      if (!declared.has(key)) {
        errors.push(
          `  ${rel}: reads config env key '${key}' that is NOT declared in ENV_CONTRACTS ` +
            `(app/contracts.ts). Declare it in the ONE typed schema so it can't become a synonym.`,
        );
      }
    }
  }

  for (const finding of reconcileRegistry()) {
    errors.push(`  registry: [${finding.kind}] ${finding.detail}`);
  }

  if (errors.length > 0) {
    console.error(`check-contracts: contract-registry violations:\n${errors.join("\n")}`);
    process.exit(1);
  }

  console.log(`check-contracts: OK (${declared.size} declared env keys, registry reconciles clean).`);
}

if (import.meta.main) main();
