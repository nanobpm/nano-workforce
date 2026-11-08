// write-build-info — bake the release's build identity into `build-info.json` at the package root
// (issue #925).
//
// WHY: an npm-installed instance has no `.git` directory and no `NANO_WORKFORCE_GIT_SHA` env var,
// so `app/version.ts` reported `gitSha: null` on exactly the deploys an operator most needs to
// identify ("is the fix live on merlin?"). The release pipeline writes this file during
// semantic-release's `prepare` step — AFTER @semantic-release/npm bumps `package.json` to the
// release version and BEFORE it packs/publishes the tarball — so every published package carries
// its own identity and `app/version.ts` can fall back to it (env → .git → build-info.json).
//
// WHAT IT RECORDS (and why): `gitSha` is the SOURCE HEAD the release was cut from
// (`git rev-parse HEAD` in the release checkout), NOT the `chore(release): X.Y.Z` commit
// @semantic-release/git creates afterwards — that commit does not exist yet at prepare time, so it
// cannot be recorded here. The release TAG `vX.Y.Z` is later placed on that release commit, whose
// tree is identical to the source HEAD's tree except for the version-bump metadata (CHANGELOG.md,
// package.json, package-lock.json). `gitTag` carries the tag name so an operator can resolve the
// exact release commit (`git rev-list -1 <tag>`) when they need it; `gitSha` answers the
// day-to-day question "which source code is running".
//
// USAGE:
//   node --experimental-strip-types scripts/write-build-info.ts <version> [--sha <40-hex>]   # release pipeline
//   node --experimental-strip-types scripts/write-build-info.ts --check                      # test: validate on disk
//
// `<version>` alone records the current checkout HEAD — correct at semantic-release `prepare` time.
// The manual OIDC-recovery path runs from a fresh checkout of the release TAG, whose HEAD is the
// metadata-only `chore(release)` commit, NOT the source HEAD; it passes `--sha "$(git rev-parse
// v<version>^")"` so the recorded gitSha still names the source code (see release.yml's recovery
// instructions).
//
// `--check` validates the committed/generated `build-info.json` (present, well-formed, 40-hex
// gitSha) — used by the pack test to assert the release artifact contract without cutting a
// release.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_INFO_PATH = join(REPO_ROOT, "build-info.json");

export interface BuildInfo {
  version: string;
  gitSha: string;
  gitTag: string;
  builtAt: string;
}

// The ONE payload validator is shared with the reader (app/version.ts) so writer and reader can
// never disagree on what a valid build-info.json is.
export { buildInfoProblems } from "../app/version.ts";

import { buildInfoProblems, SHA_RE } from "../app/version.ts";

/**
 * Compose the build-info payload for a release of `version`. `gitSha` is the SOURCE HEAD the
 * release was cut from. By default it is read from the current checkout HEAD (`git rev-parse HEAD`)
 * — correct at semantic-release `prepare` time, when HEAD is still the source commit. Callers that
 * run LATER (the manual OIDC-recovery path, which checks out the release TAG) must pass `sha`
 * explicitly as the source HEAD (`git rev-parse v<version>^`): by then HEAD is the metadata-only
 * `chore(release)` commit, and recording it would mislabel the package with a commit whose only
 * change is the version bump. An explicit `sha` is validated against the 40-hex contract.
 */
export function composeBuildInfo(version: string, now: Date = new Date(), sha?: string): BuildInfo {
  const gitSha = (
    sha ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" })
  ).trim();
  if (!SHA_RE.test(gitSha)) throw new Error(`git rev-parse HEAD returned a non-SHA: ${JSON.stringify(gitSha)}`);
  return {
    version,
    gitSha,
    // The tag semantic-release will place on the release commit for this version.
    gitTag: `v${version}`,
    builtAt: now.toISOString(),
  };
}

function main(argv: string[]): void {
  const arg = argv[2];
  if (arg === "--check") {
    // Lazy import so the write path never needs fs/readFileSync beyond writeFileSync.
    import("node:fs").then(({ readFileSync }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(BUILD_INFO_PATH, "utf8"));
      } catch (err) {
        // biome-ignore lint/plugin: narrowing a caught unknown to Error for its message
        console.error(`build-info.json is missing or invalid JSON: ${(err as Error).message}`);
        process.exit(1);
      }
      const problems = buildInfoProblems(parsed);
      if (problems.length > 0) {
        console.error(`build-info.json failed validation:\n - ${problems.join("\n - ")}`);
        process.exit(1);
      }
      console.log(`build-info.json OK: ${JSON.stringify(parsed)}`);
    });
    return;
  }
  const version = arg?.trim();
  if (!version) {
    console.error("usage: write-build-info.ts <version> [--sha <40-hex>] | --check");
    process.exit(1);
  }
  // Optional explicit source SHA (see composeBuildInfo). The manual OIDC-recovery path checks out
  // the release TAG, whose HEAD is the release commit — so it passes the source HEAD
  // (`git rev-parse v<version>^`) explicitly to keep gitSha pointing at the source code.
  let sha: string | undefined;
  const shaIdx = argv.indexOf("--sha");
  if (shaIdx !== -1) {
    sha = argv[shaIdx + 1]?.trim();
    if (!sha || !SHA_RE.test(sha)) {
      console.error(`--sha must be a 40-hex commit SHA, got ${JSON.stringify(argv[shaIdx + 1])}`);
      process.exit(1);
    }
  }
  const info = composeBuildInfo(version, new Date(), sha);
  writeFileSync(BUILD_INFO_PATH, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`wrote build-info.json: version=${info.version} gitSha=${info.gitSha} gitTag=${info.gitTag}`);
}

// Run the CLI only when executed directly — importing this module (e.g. from the test) must not
// parse argv or write files.
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedAs === import.meta.url) {
  main(process.argv);
}
