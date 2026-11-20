// Authoring guard for the `x-cli` CLI command-projection extension (issue #961, nano-ide#617).
//
// `d8ctl nwf …` projects every `openapi.yaml` operation into a CLI command from its `x-cli`. The
// spec is parsed by the SAME `@nanobpm/urban` walker the runtime uses (`parseSpec` +
// `collectOperations`), which validates `x-cli` (unknown keys, kebab-case words, duplicate command
// paths) and exposes it as `op.cli` — no second parser to drift from it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectOperations, parseSpec } from "@nanobpm/urban/toolkit";
import { assert } from "#test-assert";

const SPEC_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), "openapi.yaml");
const ops = () => collectOperations(parseSpec(readFileSync(SPEC_PATH, "utf8")));

test("every operation declares x-cli (a deliberate command or an explicit exclude)", () => {
  const missing = ops().filter((op) => op.cli === undefined).map((op) => op.operationId);
  assert(missing.length === 0, `operations without x-cli: ${missing.join(", ")}`);
});

test("every x-mcp-excluded operation is operator-audience or CLI-excluded", () => {
  const leaked = ops()
    .filter((op) => op.mcpExcluded && !(op.cli?.exclude === true || op.cli?.audience === "operator"))
    .map((op) => op.operationId);
  assert(leaked.length === 0, `x-mcp-excluded but CLI-visible to agents: ${leaked.join(", ")}`);
});

test("the /hooks/* side channels are excluded from the CLI", () => {
  const hooks = ops().filter((op) => op.path.startsWith("/hooks/"));
  assert(hooks.length > 0, "expected /hooks/* operations");
  const exposed = hooks.filter((op) => op.cli?.exclude !== true).map((op) => op.operationId);
  assert(exposed.length === 0, `hook side channels exposed as CLI commands: ${exposed.join(", ")}`);
});

test("dispatchDeliveryGraph is an operator-audience command", () => {
  const op = ops().find((o) => o.operationId === "dispatchDeliveryGraph");
  assert(op?.cli?.audience === "operator", "dispatchDeliveryGraph must be audience: operator");
  assert(op?.cli?.command.join(" ") === "graph dispatch", "dispatchDeliveryGraph command");
});

// Issue #970: an unquoted plain YAML scalar containing ` #` is truncated at the `#` (YAML comment),
// silently cutting summaries/descriptions in the served spec. Reject the pattern at the source.
test("openapi.yaml has no unquoted summary/description scalar containing ' #' (issue #970)", () => {
	const offenders = readFileSync(SPEC_PATH, "utf8")
		.split("\n")
		.map((line, i) => ({ line, n: i + 1 }))
		.filter(({ line }) => /^\s+(summary|description): [^"'|>].* #/.test(line));
	assert(
		offenders.length === 0,
		`quote these scalars — YAML treats ' #' as a comment and truncates them: ${offenders.map(({ n, line }) => `${n}: ${line.trim()}`).join("; ")}`,
	);
});

test("openapi.yaml graph compile summary is served in full (issue #970)", () => {
	const spec: { paths?: Record<string, Record<string, { operationId?: string; summary?: string }>> } =
		parseSpec(readFileSync(SPEC_PATH, "utf8"));
	const op = Object.values(spec.paths ?? {})
		.flatMap((item) => Object.values(item))
		.find((o) => o?.operationId === "compileDeliveryGraph");
	assert(
		op?.summary ===
			"Validate + compile a delivery graph and STAGE it for operator review (never dispatches). (ADR 0005 Decision 7 / #460)",
		`compileDeliveryGraph summary truncated: ${op?.summary}`,
	);
});
