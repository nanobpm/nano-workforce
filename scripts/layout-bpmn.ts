// npm run layout <file.bpmn ...> — (re)generate the
// bpmndi:BPMNDiagram for one or more BPMN models using the urban toolkit's `layoutBpmn`
// (bpmn-auto-layout). The semantic model stays authoritative: author the process elements
// (tasks, gateways, flows, zeebe extensions) and run this to derive an auto-laid-out diagram,
// rather than hand-editing DI. Works on DI-less or already-laid-out input; only the diagram is
// (re)written — the semantic model round-trips 1:1. Re-run whenever the flow changes.
//
// `--check` (npm run layout:check) regenerates the DI in memory and fails with a non-zero exit
// if any committed diagram is stale, WITHOUT rewriting files — the CI freshness gate that stops
// a BPMN flow change from merging with an un-regenerated diagram.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { layoutBpmn } from "@nanobpm/urban";

async function readText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}
async function writeText(path: string, text: string): Promise<void> {
  await writeFile(path, text, "utf8");
}
async function defaultProcessFiles(): Promise<string[]> {
  const dir = "resources/processes";
  return (await readdir(dir, { withFileTypes: true }))
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
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
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
