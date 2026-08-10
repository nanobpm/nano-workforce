// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// Unit tests for the epic coordination blackboard (Tier 1, issues #51 / #49 D4).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import {
	appendEntry,
	blackboardUrl,
	detectFileClaimConflicts,
	isUniqueViolation,
	mintBlackboardToken,
	normalizeKind,
	planKeyForToken,
	publicBaseUrl,
	readBlackboard,
	readBlackboardPage,
	renderCoordinationBrief,
} from "./blackboard.ts";

// A tiny in-memory stand-in for the record gateway, matching the subset of the Table<T> API the
// blackboard uses (insert/find/findOne). Mirrors the fake-app style used across the app tests.
// deno-lint-ignore no-explicit-any
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
	// deno-lint-ignore no-explicit-any
	const stores: Record<string, any[]> = {};
	const seq: Record<string, number> = {};
	function tbl(name: string, pk = "id") {
		// deno-lint-ignore no-explicit-any
		const rows = (stores[name] ??= [] as any[]);
		return {
			// deno-lint-ignore no-explicit-any require-await
			async insert(row: any) {
				if (pk === "id") {
					const id = (seq[name] = (seq[name] ?? 0) + 1);
					rows.push({ id, ...row });
					return id;
				}
				rows.push({ ...row });
				return row[pk];
			},
			// deno-lint-ignore no-explicit-any require-await
			async find(where: any = {}) {
				return rows.filter((r) =>
					Object.entries(where).every(([k, v]) => r[k] === v),
				);
			},
			// deno-lint-ignore no-explicit-any require-await
			async findOne(where: any = {}) {
				return rows.find((r) =>
					Object.entries(where).every(([k, v]) => r[k] === v),
				);
			},
		};
	}
	// deno-lint-ignore no-explicit-any
	const data = {
		table: (n: string, pk?: string) => tbl(n, pk),
	} as any as DataLayer;
	return { data, stores };
}

Deno.test("mintBlackboardToken: URL-safe, unguessable, unique", () => {
	const a = mintBlackboardToken();
	const b = mintBlackboardToken();
	assert(a !== b, "two mints must differ");
	assert(
		/^[A-Za-z0-9_-]+$/.test(a),
		`token must be URL-safe base64url, got ${a}`,
	);
	assert(a.length >= 32, "token should carry enough entropy");
});

Deno.test("publicBaseUrl: honours the env override and trims a trailing slash", () => {
	assertEquals(
		publicBaseUrl("https://pr.example.com/"),
		"https://pr.example.com",
	);
	assertEquals(
		publicBaseUrl("https://pr.example.com///"),
		"https://pr.example.com",
	);
});

Deno.test("publicBaseUrl: a blank/whitespace override falls back instead of yielding a bad URL", () => {
	const prev = process.env.NANO_PR_BASE_URL;
	delete process.env.NANO_PR_BASE_URL;
	try {
		assertEquals(publicBaseUrl(""), "http://localhost:3000");
		assertEquals(publicBaseUrl("   "), "http://localhost:3000");
		assertEquals(
			blackboardUrl("t", publicBaseUrl("")),
			"http://localhost:3000/hooks/blackboard?token=t",
		);
	} finally {
		if (prev === undefined) delete process.env.NANO_PR_BASE_URL;
		else process.env.NANO_PR_BASE_URL = prev;
	}
});

Deno.test("blackboardUrl: capability token rides the query string", () => {
	assertEquals(
		blackboardUrl("tok+en/x", "https://h"),
		"https://h/hooks/blackboard?token=tok%2Ben%2Fx",
	);
});

Deno.test("normalizeKind: valid passes through, anything else becomes note", () => {
	assertEquals(normalizeKind("file-claim"), "file-claim");
	assertEquals(normalizeKind("constraint-change"), "constraint-change");
	assertEquals(normalizeKind("learning"), "learning");
	assertEquals(normalizeKind("bogus"), "note");
	assertEquals(normalizeKind(undefined), "note");
});

Deno.test("renderCoordinationBrief: leads with a separator and teaches the protocol + URL", () => {
	const url = "https://h/hooks/blackboard?token=abc";
	const brief = renderCoordinationBrief(url);
	assert(
		brief.startsWith("\n\n---"),
		"must own a leading separator (appendPrompt adds none)",
	);
	assertStringIncludes(brief, url);
	// read + write halves of the protocol
	assertStringIncludes(brief, "curl -s");
	assertStringIncludes(brief, "-X POST");
	assertStringIncludes(brief, "author_task");
	assertStringIncludes(brief, "file-claim");
	assertStringIncludes(brief, "dedupe_key");
	// Tier 2: teaches incremental re-reading via the cursor and reacting to a claim conflict.
	assertStringIncludes(brief, "cursor");
	assertStringIncludes(brief, "&since=");
	assertStringIncludes(brief, "conflicts");
	// Learnings: teaches reading prior gotchas and posting a reusable `learning`.
	assertStringIncludes(brief, "learning");
	assertStringIncludes(brief, "Share what you learn");
});

Deno.test("planKeyForToken: resolves a token to its plan, undefined otherwise", async () => {
	const { data } = memData();
	await data
		.table("plans", "plan_key")
		.insert({ plan_key: "o/r#7", blackboard_token: "tok7" });
	assertEquals(await planKeyForToken(data, "tok7"), "o/r#7");
	assertEquals(await planKeyForToken(data, "nope"), undefined);
	assertEquals(await planKeyForToken(data, ""), undefined);
});

Deno.test("appendEntry + readBlackboard: append, encode files, read back in write order", async () => {
	const { data } = memData();
	await appendEntry(data, "o/r#1", {
		author_task: "gap-2",
		kind: "file-claim",
		files: ["a.rs"],
		body: "touches a.rs",
	});
	await appendEntry(data, "o/r#1", {
		author_task: "gap-8",
		kind: "note",
		body: "heads up",
	});
	await appendEntry(data, "o/r#2", { body: "other plan" }); // must not leak across plans

	const entries = await readBlackboard(data, "o/r#1");
	assertEquals(
		entries.map((e) => e.author_task),
		["gap-2", "gap-8"],
		"write order, scoped to plan",
	);
	assertEquals(entries[0].files, ["a.rs"], "files decoded to an array");
	assertEquals(entries[1].files, [], "no files → empty array");
	assertEquals(entries[1].author_task, "gap-8");
});

Deno.test("appendEntry: trims whitespace-padded file paths so stored/read values are clean", async () => {
	const { data } = memData();
	await appendEntry(data, "p", {
		kind: "file-claim",
		files: ["  engine/state.rs  ", "\tengine/mine.rs\n"],
		body: "claims",
	});
	const [e] = await readBlackboard(data, "p");
	assertEquals(
		e.files,
		["engine/state.rs", "engine/mine.rs"],
		"paths stored trimmed, not whitespace-padded",
	);
});

Deno.test("appendEntry: a missing author defaults to 'system' and kind is normalised", async () => {
	const { data } = memData();
	await appendEntry(data, "p", { body: "x", kind: "weird" as unknown });
	const [e] = await readBlackboard(data, "p");
	assertEquals(e.author_task, "system");
	assertEquals(e.kind, "note");
});

Deno.test("appendEntry: idempotent on dedupe_key (a job retry re-POST is a no-op)", async () => {
	const { data, stores } = memData();
	const first = await appendEntry(data, "p", {
		author_task: "t",
		body: "claim",
		dedupe_key: "t:claim:1",
	});
	const again = await appendEntry(data, "p", {
		author_task: "t",
		body: "claim",
		dedupe_key: "t:claim:1",
	});
	assertEquals(first.inserted, true);
	assertEquals(
		again.inserted,
		false,
		"second write with same dedupe_key is a no-op",
	);
	assertEquals(again.id, first.id, "returns the existing id");
	assertEquals(
		stores["plan_blackboard"].length,
		1,
		"exactly one row persisted",
	);
});

Deno.test("appendEntry: a lost UNIQUE race collapses to a no-op instead of a 500", async () => {
	// Simulate the concurrency window: two POSTs share a dedupe_key, both miss the findOne
	// pre-check, then insert loses the race on the UNIQUE (plan_key, dedupe_key) index. The
	// catch branch must re-read the winner's row and return it rather than propagate the throw.
	const winner = {
		id: 42,
		plan_key: "p",
		dedupe_key: "t:claim:1",
		author_task: "t",
		body: "claim",
	};
	let preCheckDone = false;
	// deno-lint-ignore no-explicit-any
	const table: any = {
		// deno-lint-ignore require-await
		async findOne() {
			// Pre-check misses (row not yet visible); the recovery read after the collision hits.
			if (!preCheckDone) {
				preCheckDone = true;
				return undefined;
			}
			return winner;
		},
		// deno-lint-ignore require-await
		async insert() {
			throw Object.assign(
				new Error("UNIQUE constraint failed: plan_blackboard.dedupe_key"),
				{
					code: "SQLITE_CONSTRAINT_UNIQUE",
				},
			);
		},
	};
	// deno-lint-ignore no-explicit-any
	const data = { table: () => table } as any as DataLayer;
	const res = await appendEntry(data, "p", {
		author_task: "t",
		body: "claim",
		dedupe_key: "t:claim:1",
	});
	assertEquals(res.inserted, false, "a lost race is not a fresh insert");
	assertEquals(res.id, 42, "returns the winning row's id");
});

Deno.test("appendEntry: a blank body is rejected", async () => {
	const { data } = memData();
	let threw = false;
	try {
		await appendEntry(data, "p", { body: "   " });
	} catch {
		threw = true;
	}
	assert(threw, "blank body must throw");
});

Deno.test("readBlackboard: since returns only newer entries (incremental poll)", async () => {
	const { data } = memData();
	await appendEntry(data, "p", { body: "one" });
	await appendEntry(data, "p", { body: "two" });
	await appendEntry(data, "p", { body: "three" });
	const all = await readBlackboard(data, "p");
	const tail = await readBlackboard(data, "p", { since: all[0].id });
	assertEquals(
		tail.map((e) => e.body),
		["two", "three"],
	);
});

Deno.test("readBlackboardPage: cursor is the plan head and lets an agent poll to caught-up (Tier 2)", async () => {
	const { data } = memData();
	await appendEntry(data, "p", { body: "one" });
	await appendEntry(data, "p", { body: "two" });

	const first = await readBlackboardPage(data, "p");
	assertEquals(
		first.entries.map((e) => e.body),
		["one", "two"],
	);
	assertEquals(first.cursor, first.entries[1].id, "cursor is the head id");

	// Poll again from the cursor: nothing new, and the cursor holds at the head (not reset to 0).
	const caughtUp = await readBlackboardPage(data, "p", { since: first.cursor });
	assertEquals(caughtUp.entries, []);
	assertEquals(
		caughtUp.cursor,
		first.cursor,
		"a caught-up poll keeps the head cursor",
	);

	// A sibling posts; the next poll from the cursor returns only the new entry and advances.
	await appendEntry(data, "p", { body: "three" });
	const next = await readBlackboardPage(data, "p", { since: first.cursor });
	assertEquals(
		next.entries.map((e) => e.body),
		["three"],
	);
	assertEquals(next.cursor, next.entries[0].id);
});

Deno.test("readBlackboardPage: an empty plan yields no entries and a zero cursor", async () => {
	const { data } = memData();
	const page = await readBlackboardPage(data, "empty");
	assertEquals(page.entries, []);
	assertEquals(page.cursor, 0);
});

Deno.test("detectFileClaimConflicts: a sibling's prior claim on the same file is surfaced", async () => {
	const { data } = memData();
	await appendEntry(data, "p", {
		author_task: "gap-2",
		kind: "file-claim",
		files: ["engine/state.rs"],
		body: "owns state.rs",
	});

	const conflicts = await detectFileClaimConflicts(data, "p", {
		author_task: "gap-8",
		files: ["engine/state.rs", "engine/mine.rs"],
	});
	assertEquals(conflicts.length, 1, "only the overlapping file is a conflict");
	assertEquals(conflicts[0].file, "engine/state.rs");
	assertEquals(
		conflicts[0].author_task,
		"gap-2",
		"reports the first (winning) claimer",
	);
});

Deno.test("detectFileClaimConflicts: your own prior claim and non-file-claim entries are not conflicts", async () => {
	const { data } = memData();
	await appendEntry(data, "p", {
		author_task: "gap-2",
		kind: "file-claim",
		files: ["a.rs"],
		body: "my earlier claim",
	});
	await appendEntry(data, "p", {
		author_task: "gap-8",
		kind: "note",
		files: ["a.rs"],
		body: "just a note about a.rs",
	});

	// Re-claiming my own file: no self-conflict, and the sibling's note (not a file-claim) is ignored.
	assertEquals(
		await detectFileClaimConflicts(data, "p", {
			author_task: "gap-2",
			files: ["a.rs"],
		}),
		[],
	);
	// No files to claim → nothing to conflict on.
	assertEquals(
		await detectFileClaimConflicts(data, "p", {
			author_task: "gap-9",
			files: [],
		}),
		[],
	);
});

Deno.test("detectFileClaimConflicts: beforeId restricts to strictly prior claims (insertion order wins)", async () => {
	const { data } = memData();
	const prior = await appendEntry(data, "p", {
		author_task: "gap-2",
		kind: "file-claim",
		files: ["a.rs"],
		body: "prior sibling claim",
	});
	const mine = await appendEntry(data, "p", {
		author_task: "gap-8",
		kind: "file-claim",
		files: ["a.rs"],
		body: "my claim",
	});
	const later = await appendEntry(data, "p", {
		author_task: "gap-9",
		kind: "file-claim",
		files: ["a.rs"],
		body: "sibling that claimed after me",
	});

	// Computed after my insert, filtered to id < mine: only the strictly-prior sibling is a conflict —
	// my own row and the later sibling's row are excluded even though both overlap the file.
	const conflicts = await detectFileClaimConflicts(data, "p", {
		author_task: "gap-8",
		files: ["a.rs"],
		beforeId: Number(mine.id),
	});
	assertEquals(conflicts.length, 1);
	assertEquals(conflicts[0].id, Number(prior.id));
	assertEquals(conflicts[0].author_task, "gap-2");
	assert(Number(later.id) > Number(mine.id));
});

Deno.test("isUniqueViolation: true for UNIQUE/PK, false for FOREIGN KEY and unrelated errors", () => {
	// Extended SQLite codes.
	assert(
		isUniqueViolation(
			Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
		),
	);
	assert(
		isUniqueViolation(
			Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" }),
		),
	);
	// Message-only (driver surfaced no code).
	assert(
		isUniqueViolation(
			new Error("UNIQUE constraint failed: plan_retros.plan_key"),
		),
	);
	assert(isUniqueViolation(new Error("PRIMARY KEY constraint failed")));
	// The bug this guards: a bare "constraint" match would swallow an FK failure.
	assert(!isUniqueViolation(new Error("FOREIGN KEY constraint failed")));
	assert(
		!isUniqueViolation(
			Object.assign(new Error("fk"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }),
		),
	);
	// Unrelated / non-errors.
	assert(!isUniqueViolation(new Error("network down")));
	assert(!isUniqueViolation(null));
	assert(!isUniqueViolation("nope"));
});
