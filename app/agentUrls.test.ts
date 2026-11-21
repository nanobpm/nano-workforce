// Issue #981: every app URL handed to an agent is either display-only or advisory with a defined
// unreachable behaviour — no agent step may need an app URL (a LAN-only global base) to succeed.
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertEquals } from "#test-assert";
import { AGENT_FACING_URLS, abandonUrl, renderAbandonBrief } from "./abandon.ts";
import { blackboardUrl, renderCoordinationBrief } from "./blackboard.ts";
import { proposalReviewUrl } from "./deliveryGraphProposals.ts";
import { transcriptUrlBaseFor } from "./agentic/transcript-url.ts";

/** Each URL-producing SYMBOL (`file::function`) that builds from `publicBaseUrl()` and the registry
 * entry it feeds — keyed per producer, not per module, so a second producer in a listed module fails. */
const MINTERS: Record<string, string> = {
  "app/abandon.ts::abandonUrl": "abandonUrl",
  "app/blackboard.ts::blackboardUrl": "blackboardUrl",
  "app/deliveryGraphProposals.ts::proposalReviewUrl": "proposalReviewUrl",
  "app/agentic/transcript-url.ts::transcriptUrlBaseFor": "transcriptUrlBase",
  "app/agentic/transcript-url.ts::transcriptUrlForJob": "transcriptUrlBase",
};

/** Every `file::symbol` whose body calls `publicBaseUrl(` (the definition itself excluded). */
function producersIn(path: string, src: string): string[] {
  const out: string[] = [];
  const lines = src.split("\n");
  let current = "<module>";
  for (const line of lines) {
    const m = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/.exec(line);
    if (m) current = m[1] ?? m[2] ?? current;
    if (/\bpublicBaseUrl\(/.test(line) && !/function\s+publicBaseUrl\b/.test(line)) out.push(`${path}::${current}`);
  }
  return [...new Set(out)];
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("every module minting an app URL from publicBaseUrl() is a classified agent-facing URL", () => {
  const users = sources("app")
    .flatMap((p) => producersIn(p, readFileSync(p, "utf8")))
    .sort();
  assertEquals(users, Object.keys(MINTERS).sort(), "a new app-URL minter must be classified in AGENT_FACING_URLS");
  for (const key of Object.values(MINTERS)) {
    assertEquals(key in AGENT_FACING_URLS, true, `${key} is classified`);
  }
  assertEquals(Object.keys(AGENT_FACING_URLS).sort(), [...new Set(Object.values(MINTERS))].sort());
});

test("a second unclassified URL producer in an already-listed module is detected", () => {
  const src = "export function blackboardUrl(t: string, base = publicBaseUrl()) {}\nexport function sneakyUrl(base = publicBaseUrl()) {}\n";
  assertEquals(producersIn("app/blackboard.ts", src), ["app/blackboard.ts::blackboardUrl", "app/blackboard.ts::sneakyUrl"]);
});

test("app-URL curls are bounded and an inconclusive PR check requires the app check", () => {
  const ab = renderAbandonBrief(abandonUrl("t", "http://x"));
  const bb = renderCoordinationBrief(blackboardUrl("t", "http://x"));
  for (const brief of [ab, bb]) {
    for (const line of brief.split("\n").filter((l) => /\bcurl -s/.test(l))) {
      assertEquals(/--connect-timeout \d+ --max-time \d+/.test(line), true, line);
    }
  }
  assertEquals(/PR check was inconclusive →\s+\*\*abort\*\*/.test(ab), true);
});

test("every minted agent-facing URL is built on the single public base", () => {
  const base = "http://lan-only.local:3000";
  for (const u of [abandonUrl("t", base), blackboardUrl("t", base), proposalReviewUrl("d", base), transcriptUrlBaseFor(base)]) {
    assertEquals(u.startsWith(base), true, u);
  }
});

test("every advisory URL's brief defines its unreachable behaviour (no step needs the app URL)", () => {
  const briefs: Record<string, string> = {
    abandonUrl: renderAbandonBrief(abandonUrl("t", "http://x")),
    blackboardUrl: renderCoordinationBrief(blackboardUrl("t", "http://x")),
  };
  for (const [key, cls] of Object.entries(AGENT_FACING_URLS)) {
    if (cls !== "advisory") continue;
    const brief = briefs[key];
    assertEquals(typeof brief, "string", `${key} has a brief`);
    assertEquals(/unreachable|cannot connect/i.test(brief), true, `${key} brief covers an unreachable app`);
  }
  // The abandon check proceeds on an unreachable URL when the worker fence says held.
  assertEquals(/cannot connect[\s\S]*fence said\s+\*held\* → \*\*proceed\*\*/.test(briefs.abandonUrl), true);
  assertEquals(/carry on without it/.test(briefs.blackboardUrl), true);
});
