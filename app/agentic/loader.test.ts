// Unit tests for the agentic family DISCOVERY loader (ADR 0056, H0 / #143).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { loadAgenticFamilies } from "./loader.ts";

/** A discovered family module's source: exports a named `family` with the given `name`. */
function familyModuleSource(name: string): string {
  return `export const family = { name: ${JSON.stringify(name)}, mount() {}, teardown() {} };\n`;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agentic-loader-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("discovers *.family.ts modules in sorted (deterministic) order", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "relay.family.ts"), familyModuleSource("relay"));
    await writeFile(join(dir, "presence.family.ts"), familyModuleSource("presence"));
    await writeFile(join(dir, "blackboard.family.ts"), familyModuleSource("blackboard"));
    const families = await loadAgenticFamilies(dir, noopLog());
    // Sorted by filename: blackboard.family.ts < presence.family.ts < relay.family.ts.
    assertEquals(families.map((f) => f.name), ["blackboard", "presence", "relay"]);
  });
});

test("ignores non-family files, test files, and READMEs", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "presence.family.ts"), familyModuleSource("presence"));
    await writeFile(join(dir, "presence.family.test.ts"), "export const nope = 1;\n");
    await writeFile(join(dir, "helper.ts"), "export const nope = 2;\n");
    await writeFile(join(dir, "README.md"), "# families\n");
    const families = await loadAgenticFamilies(dir, noopLog());
    assertEquals(families.map((f) => f.name), ["presence"]);
  });
});

test("a missing families directory yields no families (not an error)", async () => {
  const families = await loadAgenticFamilies(join(tmpdir(), "does-not-exist-agentic-xyz"), noopLog());
  assertEquals(families, []);
});

test("accepts a default export as well as a named `family` export", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "def.family.ts"),
      "export default { name: 'viaDefault', mount() {} };\n",
    );
    const families = await loadAgenticFamilies(dir, noopLog());
    assertEquals(families.map((f) => f.name), ["viaDefault"]);
  });
});

test("skips a module that exports no valid family, without crashing discovery", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "ok.family.ts"), familyModuleSource("ok"));
    // No `family`/`default`; and a malformed one (missing mount).
    await writeFile(join(dir, "empty.family.ts"), "export const something = 1;\n");
    await writeFile(join(dir, "bad.family.ts"), "export const family = { name: 'bad' };\n");
    const families = await loadAgenticFamilies(dir, noopLog());
    assertEquals(families.map((f) => f.name), ["ok"]);
  });
});

test("the real families/ directory discovers the copyable example no-op", async () => {
  const families = await loadAgenticFamilies(undefined, noopLog());
  assert(
    families.some((f) => f.name === "example"),
    "expected the shipped example family to be discovered",
  );
});
