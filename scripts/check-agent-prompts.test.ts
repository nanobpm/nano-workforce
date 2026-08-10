// Red/green coverage for the agent-prompt deploy guard (scripts/check-agent-prompts.ts).
//
// The guard exists because a `{{token}}` header that resolves to a missing/blank template — or a
// blank agent-prompt header — ships an effectively prompt-less agent (the root of the empty
// "(no question provided)" escalations on Magikcraft/nano-bpm #597/#599). These cases assert it
// fails on each of those shapes and passes on a well-formed app.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkAgentPrompts } from "./check-agent-prompts.ts";

const MANIFEST = JSON.stringify({
  models: { processes: ["resources/processes/*.bpmn"], templates: ["prompts/*.md"] },
});

function header(value: string): string {
  return `<zeebe:header key="io.nanobpm.agentTask.task.prompt" value="${value}" />`;
}

// Build a throwaway app tree and return its root. Each entry maps a repo-relative path to content.
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "agent-prompts-" });
  for (const [rel, content] of Object.entries(files)) {
    const abs = `${root}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, content);
  }
  return root;
}

Deno.test("passes when every {{token}} resolves to a non-blank template", async () => {
  const root = await fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": header("{{review-round}}"),
    "prompts/review-round.md": "# Round\nDo the thing.",
  });
  const res = checkAgentPrompts(root);
  assertEquals(res.errors, []);
  assert(res.ok);
  assertEquals(res.resolved, ["review-round"]);
});

Deno.test("fails when a header references an undeclared template", async () => {
  const root = await fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": header("{{does-not-exist}}"),
    "prompts/review-round.md": "# Round",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("{{does-not-exist}}") && e.includes("no such template")));
});

Deno.test("fails when the referenced template file is blank (would substitute to nothing)", async () => {
  const root = await fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": header("{{review-round}}"),
    "prompts/review-round.md": "   \n  \n",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("empty") && e.includes("review-round")));
});

Deno.test("fails when a reserved agent-prompt header is blank", async () => {
  const root = await fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": header(""),
    "prompts/review-round.md": "# Round",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("is empty")));
});

Deno.test("checks the real repo: all committed agent prompts resolve", () => {
  // The guard must be green against the actual app it protects — this is the case CI relies on.
  const repoRoot = decodeURIComponent(new URL("../", import.meta.url).pathname);
  const res = checkAgentPrompts(repoRoot);
  assertEquals(res.errors, []);
  assert(res.ok);
  // Every senior:* agent prompt header in the three processes must have resolved.
  for (const t of ["review-round", "fix-ci", "plan", "plan-review", "feature", "trial-merge"]) {
    assert(res.resolved.includes(t), `expected template ${t} to resolve`);
  }
});
