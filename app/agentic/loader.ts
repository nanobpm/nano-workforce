// nano-workforce — the agentic family DISCOVERY loader (ADR 0056, H0 / #143).
//
// Siblings drop a `*.family.ts` module into `app/agentic/families/`; this loader finds it by
// convention and imports it. There is deliberately NO central registration array for siblings to
// append to (that would merely relocate the shared-file collision the plan review flagged): a family
// is discovered purely by living in the conventional directory with the conventional suffix.
//
// A discovered module contributes its family via a default export OR a named `family` export. Any
// `*.test.ts` file is ignored (test files never carry a family), and a module that exports no valid
// family is skipped with a warning rather than crashing boot.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "@nanobpm/urban";
import type { AgenticFamily } from "./registry.ts";

/** The conventional directory holding sibling family modules, resolved next to this loader. */
export const FAMILIES_DIR = join(import.meta.dirname, "families");

/** The filename suffix a family module must carry to be discovered. */
const FAMILY_SUFFIX = ".family.ts";

/** Read a property off an unknown object without an unsafe cast. */
function prop(obj: object, key: string): unknown {
  return Object.hasOwn(obj, key) ? Object.getOwnPropertyDescriptor(obj, key)?.value : undefined;
}

/** A type guard proving an unknown value structurally satisfies {@link AgenticFamily}. */
function isAgenticFamily(candidate: unknown): candidate is AgenticFamily {
  if (!candidate || typeof candidate !== "object") return false;
  const name = prop(candidate, "name");
  if (typeof name !== "string" || name.trim() === "") return false;
  if (typeof prop(candidate, "mount") !== "function") return false;
  const teardown = prop(candidate, "teardown");
  return teardown === undefined || typeof teardown === "function";
}

/** Structurally validate a discovered module's contribution as an {@link AgenticFamily}. */
function asFamily(mod: unknown): AgenticFamily | undefined {
  if (!mod || typeof mod !== "object") return undefined;
  const candidate = prop(mod, "family") ?? prop(mod, "default");
  return isAgenticFamily(candidate) ? candidate : undefined;
}

/**
 * Discover every family module under `dir` (default {@link FAMILIES_DIR}), imported in a stable
 * (sorted-by-filename) order so mount/teardown order is deterministic across hosts. A missing
 * directory yields no families (the epic's first slice ships before any sibling exists). A module
 * that fails to import or exports no valid family is logged and skipped, never fatal to boot.
 */
export async function loadAgenticFamilies(
  dir: string = FAMILIES_DIR,
  log?: Logger,
): Promise<AgenticFamily[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // A missing families directory is the expected steady state before any sibling lands.
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  const files = entries
    .filter((name) => name.endsWith(FAMILY_SUFFIX) && !name.endsWith(".test.ts"))
    .sort();
  const families: AgenticFamily[] = [];
  for (const name of files) {
    const href = pathToFileURL(join(dir, name)).href;
    let mod: unknown;
    try {
      mod = await import(href);
    } catch (err) {
      log?.error("agentic family module failed to import", { file: name, err: String(err) });
      continue;
    }
    const family = asFamily(mod);
    if (!family) {
      log?.warn("agentic family module exported no valid family; skipping", { file: name });
      continue;
    }
    families.push(family);
  }
  return families;
}
