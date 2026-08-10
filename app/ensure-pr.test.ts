// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// Tests for ensurePr — the idempotent, race-safe heal that reconstructs a missing
// `pull_requests` FK parent before a child (`rounds`/`escalations`/`merges`) insert, so an
// engine/app.db store desync never parks an opaque `FOREIGN KEY constraint failed` incident
// (observed on convergence-loop instance 94).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import { canonicalPrUrl, ensurePr } from "./service.ts";

// A tiny in-memory DataLayer backing only the `.get`/`.insert` surface ensurePr uses. `insert`
// can be made to throw to exercise the race guard, optionally after seeding the row so the
// post-throw `.get` sees it.
function memData(
	opts: { throwOnInsert?: boolean; seedOnThrow?: boolean } = {},
): {
	data: DataLayer;
	rows: Map<string, Record<string, unknown>>;
	insertCalls: number;
} {
	const rows = new Map<string, Record<string, unknown>>();
	let insertCalls = 0;
	function tbl(name: string, key: string) {
		return {
			// deno-lint-ignore require-await
			async get(id: string) {
				return rows.get(id);
			},
			// deno-lint-ignore no-explicit-any require-await
			async insert(row: any) {
				insertCalls++;
				if (opts.throwOnInsert) {
					if (opts.seedOnThrow) rows.set(row[key], { ...row });
					throw new Error("FOREIGN KEY constraint failed");
				}
				rows.set(row[key], { ...row });
				return row[key];
			},
		};
	}
	// deno-lint-ignore no-explicit-any
	const data = {
		table: (n: string, k: string) => tbl(n, k),
	} as any as DataLayer;
	return {
		data,
		rows,
		get insertCalls() {
			return insertCalls;
		},
	};
}

Deno.test("ensurePr is a no-op when the parent already exists", async () => {
	const mem = memData();
	const { data, rows } = mem;
	rows.set("o/r#1", { pr_key: "o/r#1", status: "converging" });
	const before = { ...rows.get("o/r#1") };
	await ensurePr(data, { prKey: "o/r#1", repo: "o/r", number: 1 });
	assertEquals(rows.size, 1, "no new row is written");
	assertEquals(rows.get("o/r#1"), before, "the existing row is untouched");
	assertEquals(
		mem.insertCalls,
		0,
		"insert is never attempted — the no-write guarantee holds",
	);
});

Deno.test("ensurePr reconstructs a minimal converging row when the parent is absent", async () => {
	const { data, rows } = memData();
	await ensurePr(data, { prKey: "o/r#2", repo: "o/r", number: 2, round: 3 });
	const row = rows.get("o/r#2")!;
	assertEquals(row.pr_key, "o/r#2");
	assertEquals(row.repo, "o/r");
	assertEquals(row.number, 2);
	assertEquals(row.status, "converging");
	assertEquals(
		row.current_round,
		3,
		"the round is carried through so the aggregate isn't behind",
	);
	assertEquals(
		row.url,
		canonicalPrUrl("o/r", 2),
		"URL is derived canonically when none is passed",
	);
	assert(
		typeof row.abandon_token === "string" &&
			(row.abandon_token as string).length > 0,
	);
});

Deno.test("ensurePr defaults current_round to 1 (rounds are 1-based) when none is passed", async () => {
	const { data, rows } = memData();
	await ensurePr(data, { prKey: "o/r#5", repo: "o/r", number: 5 });
	assertEquals(
		rows.get("o/r#5")!.current_round,
		1,
		"an unknown round heals to 1, not 0, matching submitPr's 1-based invariant",
	);
});

Deno.test("ensurePr reuses a supplied abandon token instead of minting a new one", async () => {
	const { data, rows } = memData();
	await ensurePr(data, {
		prKey: "o/r#7",
		repo: "o/r",
		number: 7,
		abandonToken: "TOK-en_123",
	});
	assertEquals(
		rows.get("o/r#7")!.abandon_token,
		"TOK-en_123",
		"the running agent's existing token is preserved so its abort check keeps resolving",
	);
});

Deno.test("ensurePr mints a token when none is supplied", async () => {
	const { data, rows } = memData();
	await ensurePr(data, { prKey: "o/r#8", repo: "o/r", number: 8 });
	const tok = rows.get("o/r#8")!.abandon_token;
	assert(
		typeof tok === "string" && (tok as string).length > 0,
		"a fresh token is minted as a fallback",
	);
});

Deno.test("ensurePr prefers an explicit url over the canonical one", async () => {
	const { data, rows } = memData();
	const url = "https://github.com/o/r/pull/9";
	await ensurePr(data, { prKey: "o/r#9", repo: "o/r", number: 9, url });
	assertEquals(rows.get("o/r#9")!.url, url);
});

Deno.test("ensurePr swallows an insert race when the row appears anyway", async () => {
	// insert throws (unique-violation / concurrent writer) but the row is now present → healed.
	const { data } = memData({ throwOnInsert: true, seedOnThrow: true });
	await ensurePr(data, { prKey: "o/r#3", repo: "o/r", number: 3 });
});

Deno.test("ensurePr rethrows when the insert fails and the row is still absent", async () => {
	const { data } = memData({ throwOnInsert: true, seedOnThrow: false });
	let threw = false;
	try {
		await ensurePr(data, { prKey: "o/r#4", repo: "o/r", number: 4 });
	} catch (_e) {
		threw = true;
	}
	assert(
		threw,
		"a genuine insert failure must surface, not be silently swallowed",
	);
});
