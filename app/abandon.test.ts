// Tests for the cooperative abandon-check helpers (issue #76).
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import { abandonStatusForToken, abandonTokenFromUrl, abandonUrl, isAbandoned, mintAbandonToken, prKeyForAbandonToken, renderAbandonBrief, } from "./abandon.ts";
import { testBoundary } from "./test-support.ts";

function memData(): DataLayer {
    const stores: Record<string, Record<string, unknown>[]> = {};
    function tbl(name: string) {
        const rows = stores[name] ?? [];
        stores[name] = rows;
        return {
            async insert(row: Record<string, unknown>) {
                rows.push({ ...row });
                return row.pr_key;
            },
            async findOne(where: Record<string, unknown> = {}) {
                return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
            },
        };
    }
    return testBoundary<DataLayer>(testBoundary({ table: (n: string) => tbl(n) }));
}
async function seedPr(data: DataLayer, pr_key: string, abandon_token: string, status: string) {
    await data.table("pull_requests", "pr_key").insert({ pr_key, abandon_token, status });
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
    assertEquals(abandonUrl("tok+/=", "https://host"), "https://host/hooks/abandon?token=tok%2B%2F%3D");
});
Deno.test("abandonTokenFromUrl round-trips the token minted into an abandonUrl", () => {
    const tok = mintAbandonToken();
    assertEquals(abandonTokenFromUrl(abandonUrl(tok, "https://host")), tok);
    // url-special tokens survive the encode/decode round-trip too.
    assertEquals(abandonTokenFromUrl(abandonUrl("tok+/=", "https://host")), "tok+/=");
});
Deno.test("abandonTokenFromUrl returns undefined for absent/tokenless/garbage input", () => {
    assertEquals(abandonTokenFromUrl(undefined), undefined);
    assertEquals(abandonTokenFromUrl(null), undefined);
    assertEquals(abandonTokenFromUrl(""), undefined);
    assertEquals(abandonTokenFromUrl("https://host/hooks/abandon"), undefined, "no token param");
    assertEquals(abandonTokenFromUrl("not a url"), undefined, "unparseable input never throws");
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
