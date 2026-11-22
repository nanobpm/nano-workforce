// Runtime version/identity of the running nano-workforce app.
//
// The app runs its TypeScript sources DIRECTLY from a checkout (`node --experimental-strip-types
// main.ts`) with no build/bundle step, so "which code is running" can only be answered by
// inspecting the working tree at runtime. This module gathers that identity — the app's package
// version, the resolved `@nanobpm/urban` version, the git commit (read from `.git`, handling both
// an ordinary `.git` directory and the `gitdir:` file pointer used by worktrees/submodules, with
// an env override for detached deploys AND a `build-info.json` fallback baked into the release
// package — an npm install has neither `.git` nor the env var, issue #925), plus the Node runtime,
// pid and start time — so an operator debugging a stuck instance can confirm the process is on the
// code they think it is.
//
// Every probe is best-effort: a missing file or unavailable `.git` yields `null` for that field
// rather than throwing, so `/app/api/version` never fails just because one source is absent.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read an env var from `process.env`, trimmed; returns null when unset or blank.
 */
export function envVar(name: string): string | null {
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.trim()) return fromProcess.trim();
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
 * Dependency-drift hardening (issue #1008, optional). After an upgrade overlays a new
 * release's files WITHOUT reinstalling deps (a `--skip-install`, or a pre-#1008
 * upgrade), `package.json` names the new specs while `node_modules/` still holds the
 * old tree — so `/version` reports the new release while loading stale code. This is a
 * cheap boot-time tripwire: for each DIRECT dependency it reads
 * `node_modules/<dep>/package.json` and reports any whose installed version does not
 * satisfy the declared spec. It never throws and never blocks boot — drift surfaces as
 * a WARN the operator can act on (run `npm install`).
 *
 * Satisfaction is a SMALL semver subset — enough for the common registry range forms
 * (`^x.y.z`, `~x.y.z`, `x.y.z`, `>=x.y.z`) without shipping a full semver parser:
 *   - `^x.y.z`  — same major (for x≥1), installed >= declared.
 *   - `~x.y.z`  — same major.minor, installed >= declared.
 *   - `x.y.z` / `=x.y.z` — exact match.
 *   - `>=x.y.z` — installed >= declared.
 * Non-registry / non-semver specs (git, file:, workspace:, URLs, dist-tags like
 * `latest`, `*`) are skipped — their installed version string is not comparable to the
 * spec, and the git fork (bpmn-auto-layout) is exactly such a case.
 */
export interface DependencyDrift {
  name: string;
  declared: string;
  installed: string | null;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** True when `installed` satisfies the declared registry range `spec`. Returns null
 *  when the spec is not a comparable registry semver range (git/file/URL/tag) — the
 *  caller skips those. */
function satisfies(spec: string, installed: string): boolean | null {
  const s = spec.trim();
  if (!s) return null;
  if (/^(git|file:|workspace:|https?:|npm:|link:)/i.test(s)) return null;
  const inst = parseSemver(installed);
  if (inst == null) return null;

  const caret = s.startsWith("^");
  const tilde = s.startsWith("~");
  const gte = s.startsWith(">=");
  const bare = s.replace(/^[<>=~^=\s]+/, "");
  const decl = parseSemver(bare);
  if (decl == null) return null; // "*", "latest", unparseable — not comparable

  if (caret) {
    // ^x.y.z: for x≥1, same major and installed >= declared. For 0.y.z, caret pins
    // major.minor (0.y is treated as breaking per semver), so require both.
    if (decl.major === 0) return inst.major === 0 && inst.minor === decl.minor && cmp(inst, decl) >= 0;
    return inst.major === decl.major && cmp(inst, decl) >= 0;
  }
  if (tilde) {
    return inst.major === decl.major && inst.minor === decl.minor && cmp(inst, decl) >= 0;
  }
  if (gte) return cmp(inst, decl) >= 0;
  // Exact (optionally `=`-prefixed).
  return cmp(inst, decl) === 0;
}

/** The direct-dependency drift between package.json and node_modules. Pure and
 *  side-effect-free apart from reads; missing node_modules entries report
 *  `installed: null`. */
export function dependencyDrift(): DependencyDrift[] {
  const pkg = appPackage();
  if (pkg == null) return [];
  const out: DependencyDrift[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const section = pkg[field];
    if (typeof section !== "object" || section == null) continue;
    for (const [name, spec] of Object.entries(section)) {
      if (typeof spec !== "string") continue;
      const installedPkg = readJson(join(REPO_ROOT, "node_modules", ...name.split("/"), "package.json"));
      const installed =
        installedPkg && typeof installedPkg.version === "string" ? installedPkg.version : null;
      if (installed == null) {
        // Only flag a MISSING dep when the spec is a comparable registry range — a
        // git/file dep absent from node_modules is a different (and rarer) signal.
        if (satisfies(spec, "0.0.0") !== null) out.push({ name, declared: spec, installed: null });
        continue;
      }
      const ok = satisfies(spec, installed);
      if (ok === false) out.push({ name, declared: spec, installed });
    }
  }
  return out;
}

/**
 * The build identity baked into the release package (`build-info.json` at the package root) by
 * `scripts/write-build-info.ts` during semantic-release's `prepare` step (issue #925). An npm
 * install ships this file but no `.git`, so it is the ONLY source of `gitSha` there. Its `gitSha`
 * is the SOURCE HEAD the release was cut from (the tag commit does not exist yet at prepare time);
 * its `gitTag` names the tag placed on the release commit, whose tree matches that source HEAD
 * except for the version-bump metadata. Returns null on a dev checkout, which has no such file.
 */
export const SHA_RE = /^[0-9a-f]{40}$/;

/** Validate a parsed build-info payload; returns a list of problems (empty = valid). The single
 * validator shared by the writer (scripts/write-build-info.ts) and the reader below. */
export function buildInfoProblems(info: unknown): string[] {
  const problems: string[] = [];
  if (typeof info !== "object" || info == null) return ["build-info.json is not a JSON object"];
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape (parsed JSON)
  const bi = info as Record<string, unknown>;
  if (typeof bi.version !== "string" || !bi.version.trim()) problems.push("version must be a non-blank string");
  if (typeof bi.gitSha !== "string" || !SHA_RE.test(bi.gitSha)) problems.push("gitSha must be a 40-hex string");
  if (typeof bi.gitTag !== "string" || !bi.gitTag.trim()) problems.push("gitTag must be a non-blank string");
  if (typeof bi.builtAt !== "string" || Number.isNaN(Date.parse(bi.builtAt)))
    problems.push("builtAt must be an ISO-8601 timestamp");
  return problems;
}


function buildInfo(): { version: string; gitSha: string; gitTag: string; builtAt: string } | null {
  const raw = readJson(join(REPO_ROOT, "build-info.json"));
  if (raw == null) return null;
  // Fail closed on ANY malformed field (bad SHA, unparseable builtAt, blank tag/version): a corrupt
  // or tampered build-info.json is ignored wholesale rather than partially surfaced. Uses the SAME
  // validator the writer's --check uses, so reader and writer can never drift.
  if (buildInfoProblems(raw).length > 0) return null;
  return {
    version: String(raw.version),
    gitSha: String(raw.gitSha),
    gitTag: String(raw.gitTag),
    builtAt: String(raw.builtAt),
  };
}

/**
 * The git commit the working tree is on, read straight from `.git` so it reflects the ACTUAL
 * checked-out code — not a value baked at some earlier build. Resolves a symbolic `HEAD`
 * (`ref: refs/heads/…`) via the loose ref file (checking both the per-worktree and common dirs),
 * falling back to `packed-refs`. Resolution order (issue #925): an explicit
 * `NANO_WORKFORCE_GIT_SHA` env var wins (for deploys that ship without a `.git` directory), then
 * the live `.git` checkout, then the release-baked `build-info.json` (the only source available to
 * an npm-installed instance).
 */
function gitSha(): string | null {
  const env = envVar("NANO_WORKFORCE_GIT_SHA");
  if (env) return env;

  const fromCheckout = gitShaFromCheckout();
  if (fromCheckout != null) return fromCheckout;

  return buildInfo()?.gitSha ?? null;
}

/** The commit SHA read from the live `.git` checkout, or null when there is none (npm install). */
function gitShaFromCheckout(): string | null {
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
  if (loose?.trim()) return loose.trim();

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
  // Node exposes `process.version` (e.g. "v24.15.0").
  return process.version ? `node ${process.version}` : "unknown";
}

export interface VersionInfo {
  name: string;
  version: string | null;
  urbanVersion: string | null;
  gitSha: string | null;
  gitBranch: string | null;
  /** The release tag (e.g. "v0.206.0") from the baked `build-info.json`; null on a dev checkout. */
  gitTag: string | null;
  /** ISO-8601 time the release package was built (from `build-info.json`); null on a dev checkout. */
  builtAt: string | null;
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
  const pkg = appPackage();
  const build = buildInfo();
  return Object.freeze({
    name: appName(pkg),
    version: appVersion(pkg),
    urbanVersion: urbanVersion(),
    gitSha: gitSha(),
    gitBranch: gitBranch(),
    gitTag: build?.gitTag || null,
    builtAt: build?.builtAt || null,
    runtime: runtime(),
    pid: typeof process.pid === "number" ? process.pid : null,
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
