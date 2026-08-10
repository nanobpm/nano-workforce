// Runtime version/identity of the running nano-workforce app.
//
// The app runs its TypeScript sources DIRECTLY from a checkout (`node --experimental-strip-types
// main.ts`) with no build/bundle step, so "which code is running" can only be answered by
// inspecting the working tree at runtime. This module gathers that identity — the app's package
// version, the resolved `@nanobpm/urban` version, the git commit (read from `.git`, handling both
// an ordinary `.git` directory and the `gitdir:` file pointer used by worktrees/submodules, with
// an env override for detached deploys), plus the Node/Deno runtime, pid and start time — so an operator
// debugging a stuck instance can confirm the process is on the code they think it is.
//
// Every probe is best-effort: a missing file or unavailable `.git` yields `null` for that field
// rather than throwing, so `/app/version` never fails just because one source is absent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";

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

/**
 * Read an env var across runtimes: Node exposes `process.env`; Deno may not populate it, so fall
 * back to `Deno.env.get` (guarded — reading env can throw without `--allow-env`).
 */
export function envVar(name: string): string | null {
  const fromProcess = globalThis.process?.env?.[name];
  if (typeof fromProcess === "string" && fromProcess.trim()) return fromProcess.trim();
  const deno = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno;
  try {
    const fromDeno = deno?.env?.get?.(name);
    if (typeof fromDeno === "string" && fromDeno.trim()) return fromDeno.trim();
  } catch {
    // Env access denied — treat as unset.
  }
  return null;
}

/**
 * Locate the repo's git directories. `.git` is usually a directory, but in a `git worktree` (this
 * app is often run from one) or a submodule it is a FILE containing `gitdir: <path>`, so a naive
 * `${REPO_ROOT}/.git/HEAD` read returns null even on a live checkout. Resolve both the (possibly
 * per-worktree) git dir that holds `HEAD` and the COMMON dir that holds loose refs / `packed-refs`.
 */
function resolveGitDirs(): { gitDir: string; commonDir: string } | null {
  const dotGit = join(REPO_ROOT, ".git");
  // Ordinary checkout: `.git` is a directory and `HEAD` sits directly inside.
  if (readText(join(dotGit, "HEAD")) != null) {
    return { gitDir: dotGit, commonDir: dotGit };
  }
  // Linked worktree / submodule: `.git` is a file pointing at the real git dir.
  const pointer = readText(dotGit);
  const match = pointer ? /^gitdir:\s*(.+?)\s*$/m.exec(pointer) : null;
  if (!match) return null;
  const target = match[1].trim();
  const gitDir = isAbsolute(target) ? target : resolve(REPO_ROOT, target);
  // A linked worktree keeps its own HEAD in `gitDir` but shares refs via the common dir, named by
  // the `commondir` file (e.g. "../..").
  const common = readText(join(gitDir, "commondir"));
  const commonDir = common?.trim()
    ? (isAbsolute(common.trim()) ? common.trim() : resolve(gitDir, common.trim()))
    : gitDir;
  return { gitDir, commonDir };
}

/** The app's own `package.json` (read once, reused by name + version). */
function appPackage(): Record<string, unknown> | null {
  return readJson(join(REPO_ROOT, "package.json"));
}

/** The app's name from `package.json`, scope-stripped (e.g. "@foo/bar" → "bar"). */
function appName(pkg: Record<string, unknown> | null): string {
  const raw = typeof pkg?.name === "string" ? pkg.name.trim() : "";
  if (!raw) return "nano-workforce";
  const unscoped = raw.startsWith("@") ? raw.slice(raw.indexOf("/") + 1) : raw;
  return unscoped || "nano-workforce";
}

/** The app's own version from its `package.json`. */
function appVersion(pkg: Record<string, unknown> | null): string | null {
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
 * (`ref: refs/heads/…`) via the loose ref file (checking both the per-worktree and common dirs),
 * falling back to `packed-refs`. An explicit `NANO_WORKFORCE_GIT_SHA` env var wins (for deploys
 * that ship without a `.git` directory).
 */
function gitSha(): string | null {
  const env = envVar("NANO_WORKFORCE_GIT_SHA");
  if (env) return env;

  const dirs = resolveGitDirs();
  if (dirs == null) return null;
  const head = readText(join(dirs.gitDir, "HEAD"));
  if (head == null) return null;

  const ref = head.trim();
  if (!ref.startsWith("ref:")) {
    // Detached HEAD — the file already holds the commit sha.
    return ref || null;
  }
  const refPath = ref.slice(4).trim(); // e.g. "refs/heads/main"
  // A loose ref may live in the per-worktree dir or the common dir; check both.
  const loose = readText(join(dirs.gitDir, refPath)) ?? readText(join(dirs.commonDir, refPath));
  if (loose != null && loose.trim()) return loose.trim();

  // Packed refs fallback (always in the common dir): lines of "<sha> <refname>".
  const packed = readText(join(dirs.commonDir, "packed-refs"));
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

/** The current branch name from `HEAD`, or `null` when detached / unavailable. */
function gitBranch(): string | null {
  const dirs = resolveGitDirs();
  if (dirs == null) return null;
  const head = readText(join(dirs.gitDir, "HEAD"));
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

/**
 * Everything except `uptimeSeconds` is fixed for the life of the process, so probe the working
 * tree ONCE at module load rather than re-reading files (`.git`, package.jsons) on every request.
 */
const STATIC: Omit<VersionInfo, "uptimeSeconds"> = (() => {
  const proc = globalThis.process;
  const pkg = appPackage();
  return Object.freeze({
    name: appName(pkg),
    version: appVersion(pkg),
    urbanVersion: urbanVersion(),
    gitSha: gitSha(),
    gitBranch: gitBranch(),
    runtime: runtime(),
    pid: typeof proc?.pid === "number" ? proc.pid : null,
    startedAt: STARTED_AT.toISOString(),
  });
})();

/** Gather the running app's identity. Cheap and side-effect-free — safe to call per request. */
export function buildVersionInfo(): VersionInfo {
  return {
    ...STATIC,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
  };
}
