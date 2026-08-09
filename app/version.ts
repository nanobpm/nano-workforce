// Runtime version/identity of the running nano-workforce app.
//
// The app runs its TypeScript sources DIRECTLY from a checkout (`node --experimental-strip-types
// main.ts`) with no build/bundle step, so "which code is running" can only be answered by
// inspecting the working tree at runtime. This module gathers that identity — the app's package
// version, the resolved `@nanobpm/urban` version, the git commit (read from `.git`, with an env
// override for detached deploys), plus the Node/Deno runtime, pid and start time — so an operator
// debugging a stuck instance can confirm the process is on the code they think it is.
//
// Every probe is best-effort: a missing file or unavailable `.git` yields `null` for that field
// rather than throwing, so `/app/version` never fails just because one source is absent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Captured once, at module load — i.e. when the running process booted this code.
const STARTED_AT = new Date();

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text == null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The app's own version from its `package.json`. */
function appVersion(): string | null {
  const pkg = readJson(join(REPO_ROOT, "package.json"));
  return typeof pkg?.version === "string" ? pkg.version : null;
}

/** The installed `@nanobpm/urban` version (the runtime that materializes the whole app). */
function urbanVersion(): string | null {
  const pkg = readJson(join(REPO_ROOT, "node_modules", "@nanobpm", "urban", "package.json"));
  return typeof pkg?.version === "string" ? pkg.version : null;
}

/**
 * The git commit the working tree is on, read straight from `.git` so it reflects the ACTUAL
 * checked-out code — not a value baked at some earlier build. Resolves a symbolic `HEAD`
 * (`ref: refs/heads/…`) via the loose ref file, falling back to `packed-refs`. An explicit
 * `NANO_WORKFORCE_GIT_SHA` env var wins (for deploys that ship without a `.git` directory).
 */
function gitSha(): string | null {
  const env = globalThis.process?.env?.NANO_WORKFORCE_GIT_SHA;
  if (typeof env === "string" && env.trim()) return env.trim();

  const gitDir = join(REPO_ROOT, ".git");
  const head = readText(join(gitDir, "HEAD"));
  if (head == null) return null;

  const ref = head.trim();
  if (!ref.startsWith("ref:")) {
    // Detached HEAD — the file already holds the commit sha.
    return ref || null;
  }
  const refPath = ref.slice(4).trim(); // e.g. "refs/heads/main"
  const loose = readText(join(gitDir, refPath));
  if (loose != null && loose.trim()) return loose.trim();

  // Packed refs fallback: lines of "<sha> <refname>".
  const packed = readText(join(gitDir, "packed-refs"));
  if (packed != null) {
    for (const line of packed.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
      const [sha, name] = trimmed.split(/\s+/, 2);
      if (name === refPath) return sha;
    }
  }
  return null;
}

/** The current branch name from `.git/HEAD`, or `null` when detached / unavailable. */
function gitBranch(): string | null {
  const head = readText(join(REPO_ROOT, ".git", "HEAD"));
  if (head == null) return null;
  const ref = head.trim();
  if (!ref.startsWith("ref:")) return null;
  const refPath = ref.slice(4).trim();
  return refPath.startsWith("refs/heads/") ? refPath.slice("refs/heads/".length) : refPath;
}

function runtime(): string {
  const proc = globalThis.process;
  // Deno exposes `Deno.version.deno`; Node exposes `process.version` (e.g. "v24.15.0").
  const deno = (globalThis as { Deno?: { version?: { deno?: string } } }).Deno;
  if (deno?.version?.deno) return `deno ${deno.version.deno}`;
  if (proc?.version) return `node ${proc.version}`;
  return "unknown";
}

export interface VersionInfo {
  name: string;
  version: string | null;
  urbanVersion: string | null;
  gitSha: string | null;
  gitBranch: string | null;
  runtime: string;
  pid: number | null;
  startedAt: string;
  uptimeSeconds: number;
}

/** Gather the running app's identity. Cheap and side-effect-free — safe to call per request. */
export function buildVersionInfo(): VersionInfo {
  const proc = globalThis.process;
  return {
    name: "nano-workforce",
    version: appVersion(),
    urbanVersion: urbanVersion(),
    gitSha: gitSha(),
    gitBranch: gitBranch(),
    runtime: runtime(),
    pid: typeof proc?.pid === "number" ? proc.pid : null,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
  };
}
