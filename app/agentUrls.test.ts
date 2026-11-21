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

/** Each URL minter that builds from `publicBaseUrl()` and the registry entry it feeds. */
const MINTERS: Record<string, string> = {
  "app/abandon.ts": "abandonUrl",
  "app/blackboard.ts": "blackboardUrl",
  "app/deliveryGraphProposals.ts": "proposalReviewUrl",
  "app/agentic/transcript-url.ts": "transcriptUrlBase",
};

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
    .filter((p) => /\bpublicBaseUrl\(/.test(readFileSync(p, "utf8")))
    .sort();
  assertEquals(users, Object.keys(MINTERS).sort(), "a new app-URL minter must be classified in AGENT_FACING_URLS");
  for (const key of Object.values(MINTERS)) {
    assertEquals(key in AGENT_FACING_URLS, true, `${key} is classified`);
  }
  assertEquals(Object.keys(AGENT_FACING_URLS).sort(), Object.values(MINTERS).sort());
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
