// npm run layout <file.bpmn ...> (or `deno task layout <file.bpmn ...>`) — (re)generate the
// bpmndi:BPMNDiagram for one or more BPMN models using the urban toolkit's `layoutBpmn`
// (bpmn-auto-layout). The semantic model stays authoritative: author the process elements
// (tasks, gateways, flows, zeebe extensions) and run this to derive an auto-laid-out diagram,
// rather than hand-editing DI. Works on DI-less or already-laid-out input; only the diagram is
// (re)written — the semantic model round-trips 1:1. Re-run whenever the flow changes.
//
// `--check` (npm run layout:check) regenerates the DI in memory and fails with a non-zero exit
// if any committed diagram is stale, WITHOUT rewriting files — the CI freshness gate that stops
// a BPMN flow change from merging with an un-regenerated diagram.
import { layoutBpmn } from "@nanobpm/urban";

// Host-agnostic file I/O: Deno inside a compiled binary, else node:fs under Node — mirrors
// app/plan.ts's readAsset seam so this runs the same under `npm run` and `deno task`.
// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
const g = globalThis as {
  Deno?: {
    args: string[];
    exit(c: number): never;
    readDir(p: string): AsyncIterable<{ name: string; isFile: boolean }>;
    readTextFile(p: string): Promise<string>;
    writeTextFile(p: string, s: string): Promise<void>;
  };
};

async function readText(path: string): Promise<string> {
  return g.Deno?.readTextFile
    ? await g.Deno.readTextFile(path)
    : await (await import("node:fs/promises")).readFile(path, "utf8");
}
async function writeText(path: string, text: string): Promise<void> {
  if (g.Deno?.writeTextFile) return await g.Deno.writeTextFile(path, text);
  await (await import("node:fs/promises")).writeFile(path, text, "utf8");
}
async function defaultProcessFiles(): Promise<string[]> {
  const dir = "resources/processes";
  if (g.Deno?.readDir) {
    const files: string[] = [];
    for await (const e of g.Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".bpmn")) files.push(`${dir}/${e.name}`);
    return files.sort();
  }
  const fs = await import("node:fs/promises");
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".bpmn"))
    .map((e) => `${dir}/${e.name}`)
    .sort();
}

// Count the shapes/edges the layout produced, so the run reports what it drew (matches the
// "N shapes + M edges" accounting used when merge-loop's DI was first generated, #18).
const countDi = (xml: string) => ({
  shapes: (xml.match(/<bpmndi:BPMNShape\b/g) ?? []).length,
  edges: (xml.match(/<bpmndi:BPMNEdge\b/g) ?? []).length,
});

function exit(code: number): never {
  if (g.Deno) return g.Deno.exit(code);
  process.exit(code);
}

async function main() {
  const argv = g.Deno?.args ?? process.argv.slice(2);
  // `--check` mode: regenerate the DI in memory and fail (non-zero) if it differs from what's
  // committed, WITHOUT rewriting any file. This is the CI freshness gate — it catches a BPMN
  // flow change whose author forgot to re-run `npm run layout`, so a stale diagram can't merge.
  const check = argv.includes("--check");
  const files = (() => {
    const named = argv.filter((a) => a !== "--check");
    return named.length ? named : undefined;
  })() ?? await defaultProcessFiles();
  if (files.length === 0) {
    console.error("usage: layout-bpmn [--check] [file.bpmn ...] (default: resources/processes/*.bpmn)");
    exit(2);
  }
  const stale: string[] = [];
  for (const file of files) {
    const current = await readText(file);
    const laid = await layoutBpmn(current);
    const { shapes, edges } = countDi(laid);
    if (check) {
      if (laid !== current) {
        stale.push(file);
        console.error(`[layout:check] ${file}: DI is STALE — re-run \`npm run layout ${file}\` and commit`);
      } else {
        console.log(`[layout:check] ${file}: DI fresh (${shapes} shapes + ${edges} edges)`);
      }
      continue;
    }
    await writeText(file, laid);
    console.log(`[layout] ${file}: ${shapes} shapes + ${edges} edges`);
  }
  if (check && stale.length) {
    console.error(
      `\n${stale.length} BPMN model(s) have stale diagram interchange. The semantic model is ` +
        `authoritative; regenerate the DI with \`npm run layout\` and commit the result.`,
    );
    exit(1);
  }
}

await main();
