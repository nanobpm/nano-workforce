// Guard (issue #1087): no prompt/guide/agent-facing text may tell an agent to run a bare
// `gh pr checks --watch`. `--watch` waits for EVERY check, and a merge-queue check (e.g.
// `Mergify Merge Queue`) stays pending until merge — so after a failure it never returns and the
// agent hangs until its SLA expires. Any instruction to watch checks must carry `--fail-fast`;
// the only allowed bare mention is an explicit prohibition (a line containing "bare").
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderCiWaitContract } from "../app/deliveryRunner.ts";

const ROOTS = ["resources", "docs", "app", "workers", "actions", "skills", "README.md", "AGENTS.md", "SPEC.md"];
const SELF = join("scripts", "no-bare-checks-watch.test.ts");

function walk(p: string, out: string[]): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) if (e !== "node_modules") walk(join(p, e), out);
  } else if (/\.(md|ts|bpmn|json)$/.test(p) && p !== SELF) out.push(p);
}

/** Offending lines: mention `gh pr checks` with `--watch` but no `--fail-fast`, outside a prohibition. */
export function bareWatchViolations(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /gh pr checks[^\n]*--watch/.test(l) && !l.includes("--fail-fast") && !/\bbare\b/i.test(l));
}

test("bareWatchViolations flags an unbounded watch and accepts --fail-fast / prohibitions", () => {
  assert.equal(bareWatchViolations("run `gh pr checks 1 --watch --interval 60`").length, 1);
  assert.equal(bareWatchViolations("run `gh pr checks 1 --required --watch --fail-fast`").length, 0);
  assert.equal(bareWatchViolations("never a bare `gh pr checks --watch`").length, 0);
});

test("#1087: no repo prompt/guide text tells an agent to run a bare `gh pr checks --watch`", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(r, files);
  assert.ok(files.length > 10);
  const bad = files.flatMap((f) => bareWatchViolations(readFileSync(f, "utf8")).map((l) => `${f}: ${l.trim()}`));
  assert.deepEqual(bad, []);
});

test("#1087: every delivery-graph agent prompt carries the bounded CI-wait contract", () => {
  const c = renderCiWaitContract();
  assert.match(c, /--fail-fast/);
  assert.deepEqual(bareWatchViolations(c), []);
});
