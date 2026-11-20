// Drift guard for process START-event data envelopes (issue #975).
//
// Every process under `resources/processes/` with a top-level none start event declares its input
// contract as a `nano:shape` referenced by `<zeebe:property name="io.nanobpm.dataEnvelope.in">` on
// the start event, so Nano Studio can show what a process expects to be started with. That declared
// contract is a SECOND representation of a shape whose canonical source lives elsewhere:
//
//   • API-started processes — the `engine.createInstance({ processDefinitionId, variables })` seed
//     builders in the app (`app/service.ts`, `app/feature.ts`, `app/plan.ts`, `app/retro.ts`, …);
//   • called processes — the parent `callActivity`'s `zeebe:input` targets.
//
// This guard DERIVES the real field set from those canonical sources (a TypeScript-AST scan of every
// non-test `createInstance` call, and an XML scan of every callActivity input mapping) and fails if a
// declared start envelope's fields diverge from it — so the model contract can never drift from what
// the app actually seeds / the call activity actually maps (AGENTS.md "Derivation over duplication").
// A process with NO live starter (a standalone composable cell) is held to the weaker invariant that
// every declared field is actually read by the process body (no phantom inputs).
import { test } from "node:test";
import { assert } from "#test-assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const PROCESS_DIR = "resources/processes";
const SOURCE_ROOTS = ["app", "workers", "operations", "actions"];
/** Spread helpers that only emit the reserved `io.nanobpm.agentTask` harness envelope (app/repoEnvelope.ts). */
const RESERVED_ENVELOPE_BUILDERS: ReadonlySet<string> = new Set(["repoEnvelopeVars", "requireRepoEnvelopeVars"]);

interface StartEnvelope {
  readonly file: string;
  readonly processId: string;
  readonly shapeId: string | null;
  readonly fields: ReadonlySet<string> | null;
  /** The process XML with its own `nano:shapes` block removed (to look for real body reads). */
  readonly body: string;
}

function processFiles(): string[] {
  return readdirSync(PROCESS_DIR)
    .filter((f) => f.endsWith(".bpmn"))
    .sort();
}

/** Strip the DI and return the semantic `<bpmn:process>` block of a model. */
function processBlock(xml: string): { id: string; block: string } {
  const m = /<bpmn:process\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn:process>/.exec(xml);
  assert(m !== null, "model must contain a <bpmn:process>");
  return { id: m[1] ?? "", block: m[2] ?? "" };
}

/** Field names of a `nano:shape` (its `nano:extend` + `nano:reference` children). */
function shapeFields(block: string, shapeId: string): Set<string> | null {
  const empty = new RegExp(`<nano:shape\\b[^>]*\\bid="${shapeId}"[^>]*/>`).test(block);
  if (empty) return new Set<string>();
  const m = new RegExp(`<nano:shape\\b[^>]*\\bid="${shapeId}"[^>]*>([\\s\\S]*?)</nano:shape>`).exec(block);
  if (m === null) return null;
  const out = new Set<string>();
  for (const f of (m[1] ?? "").matchAll(/<nano:(?:extend|reference)\b[^>]*\bname="([^"]+)"/g)) out.add(f[1] ?? "");
  return out;
}

/** The top-level start event of a process block: the first `<bpmn:startEvent>` that is NOT nested in
 *  a subProcess. Sub-process bodies are cut out before matching. */
function topLevelStart(block: string): string | null {
  let flat = block;
  // Remove nested subProcess bodies (repeat until stable, innermost first).
  for (;;) {
    const next = flat.replace(/<bpmn:subProcess\b(?:(?!<bpmn:subProcess\b)[\s\S])*?<\/bpmn:subProcess>/g, "");
    if (next === flat) break;
    flat = next;
  }
  const m = /<bpmn:startEvent\b[^>]*?(?:\/>|>([\s\S]*?)<\/bpmn:startEvent>)/.exec(flat);
  if (m === null) return null;
  return m[0];
}

function startEnvelopes(): StartEnvelope[] {
  return processFiles().map((file) => {
    const xml = readFileSync(join(PROCESS_DIR, file), "utf8");
    const { id, block } = processBlock(xml);
    const start = topLevelStart(block);
    assert(start !== null, `${file}: process ${id} must have a top-level start event`);
    const prop = /<zeebe:property\s+name="io\.nanobpm\.dataEnvelope\.in"\s+value="([^"]+)"/.exec(start);
    const shapeId = prop === null ? null : (prop[1] ?? null);
    const fields = shapeId === null ? null : shapeFields(block, shapeId);
    // Exclude the start event itself: its own `dataEnvelope.in` property would otherwise count every
    // declared field as a body "read", making the no-phantom-inputs check vacuous.
    const body = block.replace(/<nano:shapes>[\s\S]*?<\/nano:shapes>/, "").replace(start, "");
    return { file, processId: id, shapeId, fields, body };
  });
}

// ── Canonical source 1: the app-side `createInstance` seed builders (TypeScript AST) ─────────────

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".e2e.ts")) out.push(p);
    }
  };
  for (const r of SOURCE_ROOTS) walk(r);
  out.push("main.ts");
  return out.sort();
}

/** Module-scope `const NAME = "literal"` declarations of a file. */
function stringConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer)) {
      out.set(n.name.text, n.initializer.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every module-scope string constant across the app (resolves imported ids like `FEATURE_PROCESS_ID`). */
function allStringConsts(files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    for (const [k, v] of stringConsts(sf)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

function propName(name: ts.PropertyName, consts: ReadonlyMap<string, string>, where: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression)) {
    const v = consts.get(name.expression.text);
    assert(v !== undefined, `${where}: cannot resolve computed seed key [${name.expression.text}]`);
    return v;
  }
  throw new Error(`${where}: unsupported seed key ${name.getText()}`);
}

/** Collect the keys of an object-literal seed, descending into `...(cond ? {..} : {..})` / `...{..}`
 *  spreads. An unanalysable spread (e.g. `...someVar`) fails loudly — keep seeds explicit. */
function seedKeys(obj: ts.ObjectLiteralExpression, consts: ReadonlyMap<string, string>, where: string, out: Set<string>): void {
  const spread = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return spread(e.expression);
    if (ts.isObjectLiteralExpression(e)) return seedKeys(e, consts, where, out);
    // The harness's reserved `io.nanobpm.agentTask` repository envelope is a runtime channel, not a
    // business start input, so its builders are excluded from the start contract.
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && RESERVED_ENVELOPE_BUILDERS.has(e.expression.text)) return;
    if (ts.isConditionalExpression(e)) {
      spread(e.whenTrue);
      spread(e.whenFalse);
      return;
    }
    throw new Error(`${where}: unanalysable seed spread \`...${e.getText()}\` — spell the keys out`);
  };
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
      out.add(propName(p.name, consts, where));
    } else if (ts.isSpreadAssignment(p)) {
      spread(p.expression);
    }
  }
}

/** processId → union of every key any `createInstance` call seeds it with. Calls whose process id is
 *  not a static string (the content-addressed compiled delivery graph) are skipped. */
function appSeeds(): Map<string, Set<string>> {
  const files = sourceFiles();
  const consts = allStringConsts(files);
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!text.includes("createInstance")) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "createInstance" &&
        n.arguments.length === 1
      ) {
        const arg = n.arguments[0];
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          const where = `${f}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
          let pid: string | undefined;
          let vars: ts.ObjectLiteralExpression | undefined;
          for (const p of arg.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
            if (p.name.text === "processDefinitionId") {
              if (ts.isStringLiteralLike(p.initializer)) pid = p.initializer.text;
              else if (ts.isIdentifier(p.initializer)) pid = consts.get(p.initializer.text);
            } else if (p.name.text === "variables" && ts.isObjectLiteralExpression(p.initializer)) {
              vars = p.initializer;
            }
          }
          if (pid !== undefined) {
            assert(vars !== undefined, `${where}: createInstance(${pid}) must seed an inline object literal`);
            const set = out.get(pid) ?? new Set<string>();
            seedKeys(vars, consts, where, set);
            out.set(pid, set);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// ── Canonical source 2: parent callActivity `zeebe:input` targets ────────────────────────────────

function callActivityInputs(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of processFiles()) {
    const xml = readFileSync(join(PROCESS_DIR, file), "utf8");
    for (const ca of xml.matchAll(/<bpmn:callActivity\b[\s\S]*?<\/bpmn:callActivity>/g)) {
      const called = /<zeebe:calledElement\b[^>]*\bprocessId="([^"]+)"/.exec(ca[0]);
      if (called === null) continue;
      const set = out.get(called[1] ?? "") ?? new Set<string>();
      for (const i of ca[0].matchAll(/<zeebe:input\b[^>]*\btarget="([^"]+)"/g)) set.add(i[1] ?? "");
      out.set(called[1] ?? "", set);
    }
  }
  return out;
}

function diff(declared: ReadonlySet<string>, actual: ReadonlySet<string>): string {
  const missing = [...actual].filter((k) => !declared.has(k)).sort();
  const extra = [...declared].filter((k) => !actual.has(k)).sort();
  return `missing from the envelope: [${missing.join(", ")}]; declared but never supplied: [${extra.join(", ")}]`;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((k) => b.has(k));
}

const ENVELOPES = startEnvelopes();
const SEEDS = appSeeds();
const CALLS = callActivityInputs();

test("every process's top-level start event declares a resolvable start data envelope", () => {
  for (const e of ENVELOPES) {
    assert(e.shapeId !== null, `${e.file}: start event of ${e.processId} must declare io.nanobpm.dataEnvelope.in`);
    assert(e.fields !== null, `${e.file}: start envelope shape ${e.shapeId} must be declared in the process's nano:shapes`);
  }
});

test("an API-started process's start envelope matches exactly what the app seeds via createInstance", () => {
  let checked = 0;
  for (const e of ENVELOPES) {
    const seed = SEEDS.get(e.processId);
    if (seed === undefined || e.fields === null) continue;
    checked++;
    assert(sameSet(e.fields, seed), `${e.file}: start envelope ${e.shapeId} drifted from the app seed — ${diff(e.fields, seed)}`);
  }
  assert(checked >= 6, `expected the API-started processes to be checked, got ${checked}`);
});

test("a called process's start envelope matches exactly what its parent callActivities map", () => {
  let checked = 0;
  for (const e of ENVELOPES) {
    const inputs = CALLS.get(e.processId);
    if (inputs === undefined || e.fields === null) continue;
    assert(!SEEDS.has(e.processId), `${e.processId} is both API-started and called — extend this guard to union both sources`);
    checked++;
    assert(
      sameSet(e.fields, inputs),
      `${e.file}: start envelope ${e.shapeId} drifted from the parent callActivity inputs — ${diff(e.fields, inputs)}`,
    );
  }
  assert(checked >= 3, `expected the called cells to be checked, got ${checked}`);
});

/** Every shape id → its field names, across all models (task envelopes reference shapes cross-file). */
function allShapes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of processFiles()) {
    const xml = readFileSync(join(PROCESS_DIR, file), "utf8");
    for (const m of xml.matchAll(/<nano:shape\b[^>]*\bid="([^"]+)"/g)) {
      const fields = shapeFields(xml, m[1] ?? "");
      if (fields !== null) out.set(m[1] ?? "", fields);
    }
  }
  return out;
}

test("a process with no live starter declares only fields its body actually reads", () => {
  const shapes = allShapes();
  let checked = 0;
  for (const e of ENVELOPES) {
    if (SEEDS.has(e.processId) || CALLS.has(e.processId) || e.fields === null) continue;
    checked++;
    // A body "read" is a FEEL/expression reference to the name, or the name being a field of a task
    // input envelope (`io.nanobpm.dataEnvelope.in`) the body declares — the engine fills those by name.
    const envelopeReads = new Set<string>();
    for (const m of e.body.matchAll(/name="io\.nanobpm\.dataEnvelope\.in"\s+value="([^"]+)"/g)) {
      for (const f of shapes.get(m[1] ?? "") ?? []) envelopeReads.add(f);
    }
    const expressions = [...e.body.matchAll(/(?:="=|>=)[^"<]*/g)].map((m) => m[0]).join("\n");
    for (const f of e.fields) {
      assert(
        envelopeReads.has(f) || new RegExp(`\\b${f}\\b`).test(expressions),
        `${e.file}: start envelope field "${f}" is never read by ${e.processId}`,
      );
    }
  }
  assert(checked >= 3, `expected the standalone cells to be checked, got ${checked}`);
});

test("every app createInstance seed targets a process that exists in resources/processes", () => {
  const ids = new Set(ENVELOPES.map((e) => e.processId));
  for (const pid of SEEDS.keys()) assert(ids.has(pid), `createInstance seeds unknown process "${pid}"`);
});
