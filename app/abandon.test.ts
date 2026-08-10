// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// Tests for the cooperative abandon-check helpers (issue #76).
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import {
	abandonStatusForToken,
	abandonTokenFromUrl,
	abandonUrl,
	isAbandoned,
	mintAbandonToken,
	prKeyForAbandonToken,
	renderAbandonBrief,
} from "./abandon.ts";

// deno-lint-ignore no-explicit-any
function memData(): DataLayer {
	// deno-lint-ignore no-explicit-any
	const stores: Record<string, any[]> = {};
	function tbl(name: string) {
		// deno-lint-ignore no-explicit-any
		const rows = (stores[name] ??= [] as any[]);
		return {
			// deno-lint-ignore no-explicit-any require-await
			async insert(row: any) {
				rows.push({ ...row });
				return row.pr_key;
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
	return { table: (n: string) => tbl(n) } as any as DataLayer;
}

async function seedPr(
	data: DataLayer,
	pr_key: string,
	abandon_token: string,
	status: string,
) {
	await data
		.table("pull_requests", "pr_key")
		.insert({ pr_key, abandon_token, status });
}

Deno.test("isAbandoned is true only for the 'abandoned' status", () => {
	assertEquals(isAbandoned("abandoned"), true);
	assertEquals(isAbandoned("converging"), false);
	assertEquals(isAbandoned("converged"), false);
	assertEquals(isAbandoned("merged"), false);
	assertEquals(isAbandoned(null), false);
	assertEquals(isAbandoned(undefined), false);
});

Deno.test("mintAbandonToken is url-safe, unpadded, and unique", () => {
	const a = mintAbandonToken();
	const b = mintAbandonToken();
	assertNotEquals(a, b);
	assertEquals(/^[A-Za-z0-9_-]+$/.test(a), true, "base64url, no padding");
	assertEquals(a.includes("="), false);
});

Deno.test("abandonUrl carries the token on the query string (url-encoded)", () => {
	assertEquals(
		abandonUrl("tok+/=", "https://host"),
		"https://host/hooks/abandon?token=tok%2B%2F%3D",
	);
});

Deno.test("abandonTokenFromUrl round-trips the token minted into an abandonUrl", () => {
	const tok = mintAbandonToken();
	assertEquals(abandonTokenFromUrl(abandonUrl(tok, "https://host")), tok);
	// url-special tokens survive the encode/decode round-trip too.
	assertEquals(
		abandonTokenFromUrl(abandonUrl("tok+/=", "https://host")),
		"tok+/=",
	);
});

Deno.test("abandonTokenFromUrl returns undefined for absent/tokenless/garbage input", () => {
	assertEquals(abandonTokenFromUrl(undefined), undefined);
	assertEquals(abandonTokenFromUrl(null), undefined);
	assertEquals(abandonTokenFromUrl(""), undefined);
	assertEquals(
		abandonTokenFromUrl("https://host/hooks/abandon"),
		undefined,
		"no token param",
	);
	assertEquals(
		abandonTokenFromUrl("not a url"),
		undefined,
		"unparseable input never throws",
	);
});

Deno.test("renderAbandonBrief embeds the concrete URL and the stop contract", () => {
	const brief = renderAbandonBrief("https://host/hooks/abandon?token=tok");
	assertEquals(brief.includes("https://host/hooks/abandon?token=tok"), true);
	assertEquals(brief.includes("abandoned"), true);
	assertEquals(brief.includes("Abort"), true);
	// Must use `curl -f` so a 404 (torn-down run) fails the command instead of exiting 0 with an
	// error body the agent would parse as "not abandoned".
	assertEquals(brief.includes("curl -fsS"), true);
});

Deno.test("prKeyForAbandonToken resolves a known token and rejects unknowns", async () => {
	const data = memData();
	await seedPr(data, "o/r#1", "tok", "converging");
	assertEquals(await prKeyForAbandonToken(data, "tok"), "o/r#1");
	assertEquals(await prKeyForAbandonToken(data, "nope"), undefined);
	assertEquals(await prKeyForAbandonToken(data, ""), undefined);
});

Deno.test("abandonStatusForToken derives abandoned from the row status", async () => {
	const data = memData();
	await seedPr(data, "o/r#1", "live", "converging");
	await seedPr(data, "o/r#2", "dead", "abandoned");
	assertEquals(await abandonStatusForToken(data, "live"), {
		prKey: "o/r#1",
		status: "converging",
		abandoned: false,
	});
	assertEquals(await abandonStatusForToken(data, "dead"), {
		prKey: "o/r#2",
		status: "abandoned",
		abandoned: true,
	});
	assertEquals(await abandonStatusForToken(data, "nope"), undefined);
});
