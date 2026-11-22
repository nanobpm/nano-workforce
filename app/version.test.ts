// Tests for app/version.ts identity resolution (issue #925).
//
// The module probes the working tree ONCE at import time (STATIC), so each scenario imports a
// cache-busted copy (`?scenario=…`) to re-run the probe under a controlled environment:
//   - env override (NANO_WORKFORCE_GIT_SHA) always wins;
//   - a live .git checkout beats the baked build-info.json;
//   - with neither env nor .git, the release-baked build-info.json is the fallback (the npm-install
//     case — the whole point of #925);
//   - gitTag/builtAt are exposed from build-info.json when known, null on a plain checkout.
//
// The "no .git" scenarios copy the app's identity inputs (package.json + build-info.json) into a
// temp dir WITHOUT a .git directory and load a thin re-export fixture from there — the fixture's
// own location is what `version.ts` derives REPO_ROOT from, so loading it via the temp path
// reproduces an npm-installed layout faithfully.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { buildVersionInfo, dependencyDrift } from "./version.ts";

const SHA_RE = /^[0-9a-f]{40}$/;
// A build-info.json the release pipeline would have baked (scripts/write-build-info.ts shape).
const BAKED = {
  version: "9.9.9",
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  gitTag: "v9.9.9",
  builtAt: "2026-01-02T03:04:05.000Z",
};

/** Materialise an npm-install-like layout (package.json + build-info.json, NO .git) in a temp dir. */
function npmInstallLayout(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nwf-version-"));
  writeFileSync(
    join(dir, "package.json"),
    // "type": "module" so the copied version.ts loads as ESM without a MODULE_TYPELESS_PACKAGE_JSON warning.
    JSON.stringify({ name: "@nanobpm/nano-workforce", version: BAKED.version, type: "module" }),
  );
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(BAKED));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Import version.ts AS IF it lived under `dir` (a copy whose REPO_ROOT resolves to `dir`).
 * version.ts derives REPO_ROOT as dirname(dirname(import.meta.url)) — it lives in `app/` — so the
 * copy must sit at the SAME depth (`<dir>/app/version-copy.ts`) for the derivation to land on `dir`.
 */
async function importFrom(dir: string) {
  const { mkdirSync, readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./version.ts", import.meta.url), "utf8");
  mkdirSync(join(dir, "app"), { recursive: true });
  const dest = join(dir, "app", `version-copy-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(dest, src);
  return (await import(dest)) as typeof import("./version.ts");
}

async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("a live .git checkout resolves gitSha from HEAD (the dev-clone case)", () => {
  // This test itself runs from a real checkout, so the plain import sees .git.
  const info = buildVersionInfo();
  assert(info.gitSha == null || SHA_RE.test(info.gitSha), `gitSha is null or 40-hex, got ${info.gitSha}`);
});

test("a live .git checkout WINS over a competing baked build-info.json (checkout > baked)", async () => {
  // Precedence guard (issue #925): env > .git checkout > build-info.json. Lay out BOTH a live
  // (detached) .git whose HEAD SHA differs from the baked one AND a build-info.json, with no env
  // override, and assert HEAD wins. Without a competing baked file this could not catch the baked
  // fallback incorrectly taking precedence over the checkout.
  const dir = mkdtempSync(join(tmpdir(), "nwf-version-precedence-"));
  try {
    const checkoutSha = "cccccccccccccccccccccccccccccccccccccccc";
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@nanobpm/nano-workforce", version: BAKED.version, type: "module" }),
    );
    // A live checkout: .git is a directory whose HEAD is a detached commit SHA distinct from the baked one.
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), `${checkoutSha}\n`);
    // A competing baked file whose gitSha must LOSE to the checkout above.
    writeFileSync(join(dir, "build-info.json"), JSON.stringify(BAKED));
    await withEnv("NANO_WORKFORCE_GIT_SHA", undefined, async () => {
      const mod = await importFrom(dir);
      const info = mod.buildVersionInfo();
      assertEquals(info.gitSha, checkoutSha, "the live .git checkout beats the baked build-info.json");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env override NANO_WORKFORCE_GIT_SHA wins over .git and build-info.json", async () => {
  const envSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await withEnv("NANO_WORKFORCE_GIT_SHA", envSha, async () => {
    const mod = (await import(`./version.ts?env-wins=${Date.now()}`)) as typeof import("./version.ts");
    assertEquals(mod.buildVersionInfo().gitSha, envSha);
  });
});

test("env override wins even in an npm-install layout (env > build-info.json)", async () => {
  const { dir, cleanup } = npmInstallLayout();
  try {
    const envSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await withEnv("NANO_WORKFORCE_GIT_SHA", envSha, async () => {
      const mod = await importFrom(dir);
      assertEquals(mod.buildVersionInfo().gitSha, envSha, "env beats the baked build-info.json");
    });
  } finally {
    cleanup();
  }
});

test("with no env and no .git, gitSha falls back to the baked build-info.json (the npm-install case)", async () => {
  const { dir, cleanup } = npmInstallLayout();
  try {
    await withEnv("NANO_WORKFORCE_GIT_SHA", undefined, async () => {
      const mod = await importFrom(dir);
      const info = mod.buildVersionInfo();
      assertEquals(info.gitSha, BAKED.gitSha, "build-info.json is the fallback source of gitSha");
      assertEquals(info.gitTag, BAKED.gitTag, "gitTag is exposed from build-info.json");
      assertEquals(info.builtAt, BAKED.builtAt, "builtAt is exposed from build-info.json");
      assertEquals(info.gitBranch, null, "no .git → no branch");
      assertEquals(info.version, BAKED.version, "version still comes from package.json");
    });
  } finally {
    cleanup();
  }
});

test("a malformed build-info.json (non-string gitSha) is ignored, not fatal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nwf-version-bad-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@nanobpm/nano-workforce", version: "1.0.0", type: "module" }));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ version: "1.0.0", gitSha: 42 }));
    await withEnv("NANO_WORKFORCE_GIT_SHA", undefined, async () => {
      const mod = await importFrom(dir);
      const info = mod.buildVersionInfo();
      assertEquals(info.gitSha, null);
      assertEquals(info.gitTag, null);
      assertEquals(info.builtAt, null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a build-info.json whose gitSha is a non-blank but non-40-hex string is rejected (fail closed)", async () => {
  // Regression for the malformed-baked-SHA finding: a payload like `gitSha: "not-a-sha"` must NOT
  // be reported as the commit — the getter fails closed and reports null rather than surfacing an
  // invalid commit on the identity endpoints.
  const dir = mkdtempSync(join(tmpdir(), "nwf-version-badsha-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@nanobpm/nano-workforce", version: "1.0.0", type: "module" }));
    writeFileSync(
      join(dir, "build-info.json"),
      JSON.stringify({ version: "1.0.0", gitSha: "not-a-sha", gitTag: "v1.0.0", builtAt: "2026-01-02T03:04:05.000Z" }),
    );
    await withEnv("NANO_WORKFORCE_GIT_SHA", undefined, async () => {
      const mod = await importFrom(dir);
      const info = mod.buildVersionInfo();
      assertEquals(info.gitSha, null, "a malformed baked SHA is ignored, not reported");
      assertEquals(info.gitTag, null, "the whole baked payload is dropped when its gitSha is invalid");
      assertEquals(info.builtAt, null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitTag/builtAt are always present in the payload (null on a plain checkout)", () => {
  // The committed repo carries no build-info.json, so a dev checkout reports the release-only
  // fields as null; the assertion keys off the SAME getter the endpoint uses, so it documents the
  // contract either way.
  const info = buildVersionInfo();
  assert("gitTag" in info && "builtAt" in info, "the fields are always present in the payload");
});

test("a build-info.json with a valid SHA but an unparseable builtAt is rejected (shared validator)", async () => {
  // Regression: the reader once validated only gitSha, so `builtAt: "not-a-date"` reached /version
  // even though the writer's buildInfoProblems() rejects it. Reader + writer now share one validator.
  const dir = mkdtempSync(join(tmpdir(), "nwf-version-baddate-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@nanobpm/nano-workforce", version: "1.0.0", type: "module" }));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ ...BAKED, builtAt: "not-a-date" }));
    await withEnv("NANO_WORKFORCE_GIT_SHA", undefined, async () => {
      const mod = await importFrom(dir);
      const info = mod.buildVersionInfo();
      assertEquals(info.gitSha, null, "the whole baked payload is dropped when builtAt is invalid");
      assertEquals(info.builtAt, null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependencyDrift reports no drift for the repo's own satisfied, comparable specs", () => {
  // The repo just ran `npm install`, so every comparable direct-dependency spec (the ^x.y.z
  // registry deps) resolves to an installed version satisfying it. Non-registry specs (the git
  // fork of bpmn-auto-layout) are skipped by the satisfies() guard. Any drift reported here would
  // mean a genuinely stale node_modules — exactly what the tripwire exists to name — so an empty
  // result is the correct, non-flaky assertion on a freshly-installed tree.
  const drift = dependencyDrift();
  assertEquals(drift, [], `a freshly-installed tree must show no drift, got: ${JSON.stringify(drift)}`);
});

/** Lay out a controlled app dir (package.json + a fake node_modules) and import a
 *  version.ts copy rooted there, so dependencyDrift reads the fixture, not the repo. */
async function driftFixture(
  declared: Record<string, string>,
  installed: Record<string, string>,
  devDeclared: Record<string, string> = {},
): Promise<{ drift: import("./version.ts").DependencyDrift[]; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-drift-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", type: "module", dependencies: declared, devDependencies: devDeclared }),
  );
  for (const [name, version] of Object.entries(installed)) {
    const depDir = join(dir, "node_modules", ...name.split("/"));
    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(depDir, "package.json"), JSON.stringify({ name, version }));
  }
  const mod = await importFrom(dir);
  return { drift: mod.dependencyDrift(), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("dependencyDrift flags a stale installed version that violates a caret range", async () => {
  // The #1008 case: package.json bumped to ^2.0.0 but node_modules still holds 1.x.
  const { drift, cleanup } = await driftFixture({ a: "^2.0.0" }, { a: "1.4.0" });
  try {
    assertEquals(drift, [{ name: "a", declared: "^2.0.0", installed: "1.4.0" }]);
  } finally {
    cleanup();
  }
});

test("dependencyDrift accepts a newer minor within a caret range (no false positive)", async () => {
  // ^2.4.11 must be satisfied by 2.5.10 — the regression my first major.minor compare tripped on.
  const { drift, cleanup } = await driftFixture({ a: "^2.4.11" }, { a: "2.5.10" });
  try {
    assertEquals(drift, []);
  } finally {
    cleanup();
  }
});

test("dependencyDrift respects tilde (same major.minor) and exact pins", async () => {
  const okTilde = await driftFixture({ a: "~1.2.0" }, { a: "1.2.9" });
  try {
    assertEquals(okTilde.drift, [], "~1.2.0 is satisfied by 1.2.9");
  } finally {
    okTilde.cleanup();
  }
  const badTilde = await driftFixture({ a: "~1.2.0" }, { a: "1.3.0" });
  try {
    assertEquals(badTilde.drift.length, 1, "~1.2.0 is NOT satisfied by 1.3.0 (minor moved)");
  } finally {
    badTilde.cleanup();
  }
  const badExact = await driftFixture({ a: "1.2.3" }, { a: "1.2.4" });
  try {
    assertEquals(badExact.drift.length, 1, "an exact 1.2.3 pin is not satisfied by 1.2.4");
  } finally {
    badExact.cleanup();
  }
});

test("dependencyDrift skips non-registry specs and flags a missing comparable dep", async () => {
  // A git spec (the bpmn-auto-layout fork) is not comparable — never flagged even when absent.
  const git = await driftFixture({ a: "git+https://github.com/x/y.git#abc" }, {});
  try {
    assertEquals(git.drift, [], "a git spec is skipped, not flagged missing");
  } finally {
    git.cleanup();
  }
  // A comparable registry dep absent from node_modules is drift (installed: null).
  const missing = await driftFixture({ a: "^2.0.0" }, {});
  try {
    assertEquals(missing.drift, [{ name: "a", declared: "^2.0.0", installed: null }]);
  } finally {
    missing.cleanup();
  }
});

test("dependencyDrift ignores devDependencies absent from an --omit=dev install, but flags stale ones", async () => {
  const omitted = await driftFixture({}, {}, { d: "^1.0.0" });
  try {
    assertEquals(omitted.drift, [], "a missing devDependency is expected under --omit=dev");
  } finally {
    omitted.cleanup();
  }
  const stale = await driftFixture({}, { d: "1.0.0" }, { d: "^2.0.0" });
  try {
    assertEquals(stale.drift, [{ name: "d", declared: "^2.0.0", installed: "1.0.0" }]);
  } finally {
    stale.cleanup();
  }
});

// Review #1009: the satisfaction subset must fail closed on unsupported ranges and
// honour prerelease + ^0.0.z boundaries.
test("satisfies: ^0.0.z pins the patch", async () => {
  const { satisfies } = await import("./version.ts");
  assertEquals(satisfies("^0.0.3", "0.0.3"), true);
  assertEquals(satisfies("^0.0.3", "0.0.4"), false);
  assertEquals(satisfies("^0.2.3", "0.2.9"), true);
  assertEquals(satisfies("^0.2.3", "0.3.0"), false);
});

test("satisfies: prerelease installs never satisfy a stable spec", async () => {
  const { satisfies } = await import("./version.ts");
  assertEquals(satisfies("1.2.3", "1.2.3-beta.1"), false);
  assertEquals(satisfies("^1.2.0", "1.3.0-beta.1"), false);
  assertEquals(satisfies(">=1.0.0", "2.0.0-rc.1"), false);
  assertEquals(satisfies("^1.2.3-beta.1", "1.2.3-beta.2"), true);
  assertEquals(satisfies("^1.2.3-beta.2", "1.2.3-beta.1"), false);
  assertEquals(satisfies("^1.2.3-beta.1", "1.2.3"), true);
});

test("satisfies: unsupported range syntax is skipped (null), not partially read", async () => {
  const { satisfies } = await import("./version.ts");
  assertEquals(satisfies("^1.2.3 || ^2.0.0", "2.1.0"), null);
  assertEquals(satisfies("<1.2.3", "1.2.3"), null);
  assertEquals(satisfies("<=1.2.3", "1.0.0"), null);
  assertEquals(satisfies(">1.2.3", "1.0.0"), null);
  assertEquals(satisfies("1.2.3 - 2.0.0", "1.5.0"), null);
  assertEquals(satisfies(">=1.0.0 <2.0.0", "1.5.0"), null);
  assertEquals(satisfies("1.x", "1.5.0"), null);
  assertEquals(satisfies("latest", "1.5.0"), null);
  assertEquals(satisfies("github:foo/bar", "1.5.0"), null);
  assertEquals(satisfies("=1.2.3", "1.2.3"), true);
});
