// Guard for issue #1049: @nanobpm/engine-wasm must be pinned EXACTLY.
//
// A caret range let engine-wasm 0.11.2 (a semantics change) slip in without a
// Renovate PR, so nwf's engine-backed tests never ran against the engine merlin
// used (#1045). renovate.json pins it (rangeStrategy "pin") so every engine
// release opens a PR whose CI is the compatibility check. This test keeps the
// devDependencies entry exact and the overrides entry equal to it.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const PKG = "@nanobpm/engine-wasm";
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(`${ROOT}${path}`, "utf8"));
}

function entry(section: unknown): string | undefined {
	if (typeof section !== "object" || section === null) return undefined;
	const v = Object.getOwnPropertyDescriptor(section, PKG)?.value;
	return typeof v === "string" ? v : undefined;
}

test("package.json pins @nanobpm/engine-wasm to an exact version", () => {
	const dep = entry(readJson("package.json").devDependencies);
	assert.ok(dep, `${PKG} must be a devDependency`);
	assert.match(dep, EXACT, `${PKG} must be an exact version, not a range`);
});

test("the overrides entry equals the dependency entry", () => {
	const pkg = readJson("package.json");
	assert.equal(entry(pkg.overrides), entry(pkg.devDependencies));
});

test("renovate.json pins @nanobpm/engine-wasm (rangeStrategy pin)", () => {
	const rules = readJson("renovate.json").packageRules;
	assert.ok(Array.isArray(rules));
	const pinned = rules.some(
		(r: { matchPackageNames?: string[]; rangeStrategy?: string }) =>
			r.matchPackageNames?.includes(PKG) && r.rangeStrategy === "pin",
	);
	assert.ok(pinned, `renovate.json needs a rangeStrategy:"pin" rule for ${PKG}`);
});
