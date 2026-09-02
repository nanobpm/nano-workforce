// Tests for the cooperative abandon-check helpers (issue #76).
import { test } from "node:test";
import { assertEquals, assertNotEquals, assertRejects } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { withTrackingViews } from "../test/trackingViews.ts";
import {
  abandonStatusForToken,
  abandonTokenFromUrl,
  abandonUrl,
  isAbandoned,
  mintAbandonToken,
  prKeyForAbandonToken,
  renderAbandonBrief,
} from "./abandon.ts";

function memData(): DataLayer {
  const stores: Record<string, any[]> = {};
  function tbl(name: string) {
    const rows = (stores[name] ??= [] as any[]);
    return {
      async insert(row: any) {
        rows.push({ ...row });
        return row.pr_key;
      },
      async findOne(where: any = {}) {
        return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
    };
  }
  return { table: withTrackingViews((n: string) => tbl(n)) } as any as DataLayer;
}

async function seedPr(data: DataLayer, pr_key: string, abandon_token: string, status: string) {
  await data.table("pull_requests", "pr_key").insert({ pr_key, abandon_token, status });
}

test("isAbandoned is true only for the 'abandoned' status", () => {
  assertEquals(isAbandoned("abandoned"), true);
  assertEquals(isAbandoned("converging"), false);
  assertEquals(isAbandoned("converged"), false);
  assertEquals(isAbandoned("merged"), false);
  assertEquals(isAbandoned(null), false);
  assertEquals(isAbandoned(undefined), false);
});

test("mintAbandonToken is url-safe, unpadded, and unique", () => {
  const a = mintAbandonToken();
  const b = mintAbandonToken();
  assertNotEquals(a, b);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(a), true, "base64url, no padding");
  assertEquals(a.includes("="), false);
});

test("abandonUrl carries the token on the query string (url-encoded)", () => {
  assertEquals(
    abandonUrl("tok+/=", "https://host"),
    "https://host/app/api/hooks/abandon?token=tok%2B%2F%3D",
  );
});

test("abandonTokenFromUrl round-trips the token minted into an abandonUrl", () => {
  const tok = mintAbandonToken();
  assertEquals(abandonTokenFromUrl(abandonUrl(tok, "https://host")), tok);
  // url-special tokens survive the encode/decode round-trip too.
  assertEquals(abandonTokenFromUrl(abandonUrl("tok+/=", "https://host")), "tok+/=");
});

test("abandonTokenFromUrl returns undefined for absent/tokenless/garbage input", () => {
  assertEquals(abandonTokenFromUrl(undefined), undefined);
  assertEquals(abandonTokenFromUrl(null), undefined);
  assertEquals(abandonTokenFromUrl(""), undefined);
  assertEquals(abandonTokenFromUrl("https://host/app/api/hooks/abandon"), undefined, "no token param");
  assertEquals(abandonTokenFromUrl("not a url"), undefined, "unparseable input never throws");
});

test("renderAbandonBrief embeds the concrete URL and the stop contract", () => {
  const brief = renderAbandonBrief("https://host/app/api/hooks/abandon?token=tok");
  assertEquals(brief.includes("https://host/app/api/hooks/abandon?token=tok"), true);
  assertEquals(brief.includes("abandoned"), true);
  assertEquals(brief.includes("Abort"), true);
  // Must use `curl -f` so a 404 (torn-down run) fails the command instead of exiting 0 with an
  // error body the agent would parse as "not abandoned".
  assertEquals(brief.includes("curl -fsS"), true);
});

test("renderAbandonBrief forbids delegating the check to a sub-agent (issue #678)", () => {
  // A non-Claude agent (e.g. qwen) that hands this shell command to a shell-less
  // `general-purpose` sub-agent deadlocks: the sub-agent has no shell, produces no
  // output, and the worker's idle timeout kills the round. The brief must steer the
  // agent to run the check inline with its OWN shell and never delegate it.
  const brief = renderAbandonBrief("https://host/app/api/hooks/abandon?token=tok");
  // Not merely that it *mentions* sub-agents/inline — it must explicitly PROHIBIT delegation, so a
  // future edit that softened the brief into *encouraging* delegation would fail this test.
  assertEquals(/do \*\*not\*\* delegate it to a\s+sub-?agent/i.test(brief), true, "explicitly forbids delegating to a sub-agent");
  assertEquals(/inline/i.test(brief), true, "tells the agent to run it inline");
});

test("renderAbandonBrief degrades gracefully when the agent has no shell (issue #678)", () => {
  // The check is ADVISORY over an airtight harness job-fence (issue #76 layer 2). An
  // agent that cannot run a shell command at all must be told to SKIP and proceed
  // rather than thrash/hang — the orchestrator independently enforces cancellation.
  const brief = renderAbandonBrief("https://host/app/api/hooks/abandon?token=tok");
  assertEquals(/skip this check/i.test(brief), true, "offers a skip path");
  // Assert the actual anti-deadlock contract, not an explanatory word: a shell-less agent must be
  // told its lack of a shell is NOT a failed check, and must be forbidden from stalling/hanging.
  assertEquals(/not (a )?failed check/i.test(brief), true, "no shell is not treated as a failed check");
  assertEquals(/never stall,.*hang/i.test(brief), true, "forbids stalling/hanging when it can't run curl");
});

test("prKeyForAbandonToken resolves a known token and rejects unknowns", async () => {
  const data = memData();
  await seedPr(data, "o/r#1", "tok", "converging");
  assertEquals(await prKeyForAbandonToken(data, "tok"), "o/r#1");
  assertEquals(await prKeyForAbandonToken(data, "nope"), undefined);
  assertEquals(await prKeyForAbandonToken(data, ""), undefined);
});

test("abandonStatusForToken derives abandoned from the row status", async () => {
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

test("abandonStatusForToken fails CLOSED on a non-string derived status", async () => {
  // A malformed/missing derived_status must never be reported as `abandoned:false`
  // (that would let a cancelled run proceed with irreversible side effects). It throws
  // instead, which the operation dispatcher maps to a 500 so the agent's `curl -f` aborts.
  const data = memData();
  await data.table("pull_requests", "pr_key").insert({
    pr_key: "o/r#3",
    abandon_token: "weird",
    status: 123,
  });
  await assertRejects(() => abandonStatusForToken(data, "weird"), Error, "is not a string");
});
