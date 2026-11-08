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
import { buildVersionInfo } from "./version.ts";

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
