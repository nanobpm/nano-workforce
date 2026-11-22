// Tests for scripts/upgrade-from-pack.ts — the dependency-reinstall behaviour added
// in issue #1008. After `--apply` overlays a release's files (preserving
// node_modules/), the script must run an incremental `npm install` whenever a
// dependency manifest changed, report it in the dry-run plan, honour --skip-install,
// and fail loudly when the install fails. The install runner is INJECTED so no test
// spawns a real npm.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "#test-assert";
import {
  changedDependencySpecs,
  dependencyFilesChanged,
  run,
  type Args,
} from "./upgrade-from-pack.ts";

/** Build a minimal app dir (nano.app.json + package.json) and a source pack dir. */
function makeAppAndSource(
  currentPkg: Record<string, unknown>,
  incomingPkg: Record<string, unknown>,
): { cwd: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), "upr-test-"));
  const cwd = join(root, "app");
  const src = join(root, "pack");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(cwd, "nano.app.json"), "{}");
  writeFileSync(join(cwd, "package.json"), JSON.stringify(currentPkg, null, 2));
  writeFileSync(join(src, "nano.app.json"), "{}");
  writeFileSync(join(src, "package.json"), JSON.stringify(incomingPkg, null, 2));
  return { cwd, src };
}

function args(overrides: Partial<Args>): Args {
  return {
    apply: false,
    version: "latest",
    pkg: "@nanobpm/nano-workforce",
    from: null,
    force: false,
    skipInstall: false,
    ...overrides,
  };
}

test("dependencyFilesChanged: identical package.json → false", () => {
  const pkg = { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } };
  const { cwd, src } = makeAppAndSource(pkg, pkg);
  try {
    assertEquals(dependencyFilesChanged(cwd, src), false);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("dependencyFilesChanged: changed dependency spec → true", () => {
  const { cwd, src } = makeAppAndSource(
    { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    { name: "x", version: "1.0.1", dependencies: { a: "^2.0.0" } },
  );
  try {
    assertEquals(dependencyFilesChanged(cwd, src), true);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("changedDependencySpecs lists added / removed / changed specs", () => {
  const before = JSON.stringify({ dependencies: { keep: "^1.0.0", drop: "^1.0.0", bump: "^1.0.0" } });
  const after = JSON.stringify({ dependencies: { keep: "^1.0.0", bump: "^2.0.0", add: "^3.0.0" } });
  const changes = changedDependencySpecs(before, after);
  assert(changes.some((l) => l.includes("add") && l.startsWith("+")), `expected an added line: ${changes}`);
  assert(changes.some((l) => l.includes("drop") && l.startsWith("-")), `expected a removed line: ${changes}`);
  assert(
    changes.some((l) => l.includes("bump") && l.includes("^1.0.0") && l.includes("^2.0.0")),
    `expected a changed line: ${changes}`,
  );
  // Unchanged dep must not be reported.
  assert(!changes.some((l) => l.startsWith("+ keep") || l.startsWith("- keep")), `keep must be unchanged: ${changes}`);
});

test("apply with a changed package.json runs the injected install", () => {
  const { cwd, src } = makeAppAndSource(
    { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    { name: "x", version: "1.0.1", dependencies: { a: "^2.0.0" } },
  );
  const installs: string[] = [];
  try {
    run(args({ apply: true, from: src }), cwd, {
      install: (dir) => {
        installs.push(dir);
      },
    });
    assertEquals(installs, [cwd]);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("apply with unchanged dependency files does NOT install", () => {
  const pkg = { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } };
  const { cwd, src } = makeAppAndSource(pkg, pkg);
  const installs: string[] = [];
  try {
    run(args({ apply: true, from: src }), cwd, {
      install: (dir) => {
        installs.push(dir);
      },
    });
    assertEquals(installs, []);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("--skip-install overlays a changed package.json WITHOUT installing", () => {
  const { cwd, src } = makeAppAndSource(
    { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    { name: "x", version: "1.0.1", dependencies: { a: "^2.0.0" } },
  );
  const installs: string[] = [];
  try {
    run(args({ apply: true, from: src, skipInstall: true }), cwd, {
      install: (dir) => {
        installs.push(dir);
      },
    });
    assertEquals(installs, []);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("an install failure aborts the upgrade loudly (non-zero, names the npm error)", () => {
  const { cwd, src } = makeAppAndSource(
    { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    { name: "x", version: "1.0.1", dependencies: { a: "^2.0.0" } },
  );
  try {
    const err = assertThrows(
      () =>
        run(args({ apply: true, from: src }), cwd, {
          install: () => {
            throw new Error("npm exited 1: ERESOLVE could not resolve");
          },
        }),
      Error,
      "dependency reinstall failed",
    );
    assertStringIncludes(err.message, "ERESOLVE could not resolve");
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("dry-run reports the reinstall plan but installs nothing", () => {
  const { cwd, src } = makeAppAndSource(
    { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    { name: "x", version: "1.0.1", dependencies: { a: "^2.0.0" } },
  );
  const installs: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  try {
    run(args({ apply: false, from: src }), cwd, {
      install: (dir) => {
        installs.push(dir);
      },
    });
  } finally {
    console.log = origLog;
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
  const out = logs.join("\n");
  assertEquals(installs, [], "a dry run must never install");
  assertStringIncludes(out, "will run npm install");
  assertStringIncludes(out, "DRY RUN");
});

test("dependencyFilesChanged: local lockfile with a lockless pack (npm pack omits it) → false", () => {
  const pkg = { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } };
  const { cwd, src } = makeAppAndSource(pkg, pkg);
  try {
    writeFileSync(join(cwd, "package-lock.json"), "{}");
    assertEquals(dependencyFilesChanged(cwd, src), false);
    writeFileSync(join(src, "package-lock.json"), '{"lockfileVersion":3}');
    assertEquals(dependencyFilesChanged(cwd, src), true);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("retry after a FAILED install still reinstalls (pending-install marker), then clears it", () => {
  const { cwd, src } = makeAppAndSource(
    { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    { name: "x", version: "1.0.1", dependencies: { a: "^2.0.0" } },
  );
  const installs: string[] = [];
  try {
    assertThrows(
      () =>
        run(args({ apply: true, from: src }), cwd, {
          install: () => {
            throw new Error("npm exited 1");
          },
        }),
      Error,
      "dependency reinstall failed",
    );
    // Manifests now match, but the install never succeeded — the retry must install.
    run(args({ apply: true, from: src }), cwd, { install: (dir) => installs.push(dir) });
    assertEquals(installs, [cwd]);
    // Marker cleared on success: a third run is a genuine no-op.
    run(args({ apply: true, from: src }), cwd, { install: (dir) => installs.push(dir) });
    assertEquals(installs, [cwd]);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

test("retry WITHOUT --skip-install after a skipped install still reinstalls", () => {
  const { cwd, src } = makeAppAndSource(
    { name: "x", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    { name: "x", version: "1.0.1", dependencies: { a: "^2.0.0" } },
  );
  const installs: string[] = [];
  try {
    run(args({ apply: true, from: src, skipInstall: true }), cwd, { install: (dir) => installs.push(dir) });
    assertEquals(installs, []);
    run(args({ apply: true, from: src }), cwd, { install: (dir) => installs.push(dir) });
    assertEquals(installs, [cwd]);
  } finally {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});
