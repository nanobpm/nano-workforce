// Tests for scripts/write-build-info.ts — the release-time bake of `build-info.json` (issue #925).
//
// The acceptance criterion is end-to-end: an `npm pack` of a tree whose build-info.json was written
// by this script CONTAINS the file, with a 40-hex gitSha — i.e. the published tarball carries the
// identity an npm-installed instance falls back to. Plus unit coverage of the payload the script
// composes (source-HEAD sha, `v<version>` tag, ISO builtAt) and its validation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { buildInfoProblems, composeBuildInfo } from "./write-build-info.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_INFO = join(REPO_ROOT, "build-info.json");
const SHA_RE = /^[0-9a-f]{40}$/;

test("composeBuildInfo records the checkout HEAD (40-hex), the v<version> tag, and an ISO builtAt", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const info = composeBuildInfo("1.2.3", new Date("2026-01-02T03:04:05.000Z"));
  assertEquals(info.gitSha, head);
  assert(SHA_RE.test(info.gitSha));
  assertEquals(info.gitTag, "v1.2.3");
  assertEquals(info.builtAt, "2026-01-02T03:04:05.000Z");
  assertEquals(buildInfoProblems(info), []);
});

test("buildInfoProblems rejects malformed payloads", () => {
  assert(buildInfoProblems(null).length > 0);
  assert(buildInfoProblems({ version: "1.0.0", gitSha: "not-a-sha", gitTag: "v1.0.0", builtAt: "2026-01-02T03:04:05.000Z" }).length > 0);
  assert(buildInfoProblems({ version: "1.0.0", gitSha: "a".repeat(40), gitTag: "", builtAt: "2026-01-02T03:04:05.000Z" }).length > 0);
  assert(buildInfoProblems({ version: "1.0.0", gitSha: "a".repeat(40), gitTag: "v1.0.0", builtAt: "not-a-date" }).length > 0);
});

test("an npm pack of the package contains build-info.json with a 40-hex SHA", () => {
  // Write the file exactly as the release pipeline does (prepare step), pack, inspect, then clean
  // up — build-info.json is a build artifact and MUST NOT be committed (a stale committed copy
  // would mislabel every later dev checkout), so the test restores the prior state in `finally`.
  const prior = (() => {
    try {
      return readFileSync(BUILD_INFO, "utf8");
    } catch {
      return null;
    }
  })();
  const packDir = mkdtempSync(join(tmpdir(), "nwf-pack-"));
  try {
    execFileSync("node", ["--experimental-strip-types", "scripts/write-build-info.ts", "0.0.0-packtest"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    const out = execFileSync("npm", ["pack", "--pack-destination", packDir], { cwd: REPO_ROOT, encoding: "utf8" });
    const tarball = join(packDir, out.trim().split("\n").pop() ?? "");
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    assert(
      listing.split("\n").some((f) => f === "package/build-info.json" || f === "build-info.json"),
      `the tarball must contain build-info.json; got:\n${listing.split("\n").slice(0, 5).join("\n")}…`,
    );
    const raw = execFileSync("tar", ["-xzOf", tarball, "package/build-info.json"], { encoding: "utf8" });
    const packed: unknown = JSON.parse(raw);
    assertEquals(buildInfoProblems(packed), [], `packed build-info.json must be well-formed: ${raw}`);
    const gitSha = (packed as { gitSha: string }).gitSha;
    assert(SHA_RE.test(gitSha), `packed gitSha must be 40-hex, got ${gitSha}`);
  } finally {
    if (prior == null) rmSync(BUILD_INFO, { force: true });
    else writeFileSync(BUILD_INFO, prior);
    rmSync(packDir, { recursive: true, force: true });
  }
});
