// #833 — every grid whose Status (or Phase) cell links a process instance to the explorer also offers
// an "Agent" cell linking the SAME process_key to the cockpit (which focuses that process: live
// terminal, else its latest transcript, plus the engine agent history). Guards the class: a new
// active-run grid can't ship with the explorer link but no way to reach its agent.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

type Col = { field?: string; header?: string; link?: { kind?: string; page?: string; keyField?: string } };

function grids(node: unknown, out: Col[][]): void {
  if (Array.isArray(node)) for (const n of node) grids(n, out);
  else if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.columns)) out.push(rec.columns as Col[]);
    for (const v of Object.values(rec)) grids(v, out);
  }
}

test("#833: each Status→explorer grid also links its process to the cockpit via an Agent column", () => {
  let checked = 0;
  for (const file of readdirSync("pages").filter((f) => f.endsWith(".page.json"))) {
    const all: Col[][] = [];
    grids(JSON.parse(readFileSync(`pages/${file}`, "utf8")), all);
    for (const cols of all) {
      const explorer = cols.some((c) => (c.header === "Status" || c.header === "Phase") && c.link?.kind === "processExplorer");
      if (!explorer) continue;
      checked++;
      const agent = cols.find((c) => c.header === "Agent");
      assert.deepEqual(agent?.link, { kind: "page", page: "cockpit", keyField: "process_key" }, `${file}: grid missing the Agent → cockpit link`);
    }
  }
  assert.ok(checked > 0, "found no Status→explorer grids to check");
});
