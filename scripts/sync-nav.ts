// Single source of truth for the pages' top nav (issue #306).
//
// The `nav` node was copy-pasted verbatim into all `pages/*.page.json` files — a
// classic drift surface (AGENTS.md: "Derivation over duplication"). Adding the
// live open-tasks count badge to the Tasks item would have meant editing it in
// eight places. Instead the nav node is authored ONCE in `pages/_nav.json` and
// materialised into every page by this script; `scripts/sync-nav.test.ts` (run
// under `npm test`) is the CI drift guard that fails if any page's nav node
// diverges from the canonical source.
//
//   node --experimental-strip-types scripts/sync-nav.ts          # write pages
//   node --experimental-strip-types scripts/sync-nav.ts --check  # verify (CI)
//
// Mirrors the repo's other derive/verify pairs (layout-bpmn --check,
// check-contracts / reconcile-contracts).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const PAGES_DIR = `${ROOT}pages`;
const CANON_PATH = `${PAGES_DIR}/_nav.json`;

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function isRecord(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deterministic, key-sorted serialization so two nav nodes are compared by value,
// not by authored key order or whitespace.
function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJson(path: string): JsonValue {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Locate the character span of the sole `nav` node object inside a page's raw
// text, so it can be replaced in place without reformatting the rest of the file.
function findNavSpan(text: string, file: string): { start: number; end: number } {
  const marker = text.indexOf('"type": "nav"');
  if (marker < 0) throw new Error(`${file}: no nav node found`);
  const start = text.lastIndexOf("{", marker);
  if (start < 0) throw new Error(`${file}: malformed nav node (no opening brace)`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`${file}: unbalanced nav node braces`);
}

// The canonical node rendered at the indentation a page's `nodes[]` element sits
// at (its opening brace is already indented by 4 spaces in the file, so only the
// following lines are prefixed).
function renderNavBlock(canon: JsonValue): string {
  const lines = JSON.stringify(canon, null, 2).split("\n");
  return lines.map((line, i) => (i === 0 ? line : `    ${line}`)).join("\n");
}

function pageFiles(): string[] {
  return readdirSync(PAGES_DIR)
    .filter((n) => n.endsWith(".page.json"))
    .sort();
}

function main(): void {
  const check = process.argv.includes("--check");
  const canon = readJson(CANON_PATH);
  const wantStable = stable(canon);
  const block = renderNavBlock(canon);

  const drifted: string[] = [];
  let changed = 0;

  for (const name of pageFiles()) {
    const path = `${PAGES_DIR}/${name}`;
    const text = readFileSync(path, "utf8");
    const span = findNavSpan(text, name);
    const currentText = text.slice(span.start, span.end);
    const current: JsonValue = JSON.parse(currentText);
    if (stable(current) === wantStable) continue;

    if (check) {
      drifted.push(name);
      continue;
    }
    const next = `${text.slice(0, span.start)}${block}${text.slice(span.end)}`;
    writeFileSync(path, next);
    changed++;
    process.stdout.write(`synced nav → pages/${name}\n`);
  }

  if (check) {
    if (drifted.length > 0) {
      process.stderr.write(
        `nav drift in: ${drifted.join(", ")}\nFix with: npm run sync:nav (source of truth: pages/_nav.json)\n`,
      );
      process.exit(1);
    }
    process.stdout.write("nav is in sync across all pages\n");
    return;
  }
  process.stdout.write(changed === 0 ? "nav already in sync\n" : `synced ${changed} page(s)\n`);
}

main();
