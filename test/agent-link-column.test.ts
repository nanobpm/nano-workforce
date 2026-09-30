// #833 — every grid whose cell links a process instance to the explorer also offers an "Agent" cell
// linking the SAME process_key to the cockpit (which focuses that process: live terminal, else its
// latest transcript, plus the engine agent history). Guards the class: a new active-run grid can't
// ship with a process-explorer link but no way to reach its agent — regardless of which column
// carries the explorer link (Status, Phase, Stage, Process, …).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The `link` object of a column, if it has one (no `as`: narrowed through type guards).
function columnLink(column: unknown): Record<string, unknown> | undefined {
  if (!isObject(column)) return undefined;
  return isObject(column.link) ? column.link : undefined;
}

// Collect every `columns` array anywhere in the page tree (top-level grids, tab grids, detail
// children, …) without asserting the parsed JSON's shape.
function grids(node: unknown, out: unknown[][]): void {
  if (Array.isArray(node)) {
    for (const n of node) grids(n, out);
    return;
  }
  if (!isObject(node)) return;
  if (Array.isArray(node.columns)) out.push(node.columns);
  for (const v of Object.values(node)) grids(v, out);
}

test("#833: every process-explorer grid also links its process to the cockpit via an Agent column", () => {
  let checked = 0;
  for (const file of readdirSync("pages").filter((f) => f.endsWith(".page.json"))) {
    const all: unknown[][] = [];
    grids(JSON.parse(readFileSync(`pages/${file}`, "utf8")), all);
    for (const cols of all) {
      // A grid qualifies whenever ANY of its columns links to the process explorer — not just a
      // Status/Phase header — so a Stage/Process (or any future) explorer link is guarded too.
      const explorer = cols.some((c) => columnLink(c)?.kind === "processExplorer");
      if (!explorer) continue;
      checked++;
      const agent = cols.find((c) => isObject(c) && c.header === "Agent");
      assert.deepEqual(
        columnLink(agent),
        { kind: "page", page: "cockpit", keyField: "process_key" },
        `${file}: grid missing the Agent → cockpit link`,
      );
    }
  }
  assert.ok(checked > 0, "found no process-explorer grids to check");
});
