// Red/green coverage for the agent-prompt deploy guard (scripts/check-agent-prompts.ts).
//
// Since #169 each agent's base prompt is a linked *resource*: `resources/prompts/<token>.md` is
// deployed as a generic resource and each service task links it with
// `<zeebe:linkedResource resourceId="<token>.md" bindingType="latest" linkName="prompt"/>`. Under
// ADR 0062 the app declares no `models`, so the guard discovers deployables by the `resources/`
// convention walk; a manifest with explicit `models` globs is still honoured as an override. The
// engine silently OMITS an unresolvable link — a typo'd or undeployed `resourceId` yields a blank
// base prompt at runtime (the prompt-less-agent root of the empty "(no question provided)"
// escalations, Magikcraft/nano-bpm #597/#599). These cases assert the guard fails on each broken
// shape and passes on a well-formed app.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkAgentPrompts } from "./check-agent-prompts.ts";

// A manifest that deploys BPMN and the prompt resources via an explicit `models` override (the
// escape hatch — exercised here to prove overrides still work alongside the ADR 0062 convention).
const MANIFEST = JSON.stringify({
  models: { processes: ["resources/processes/*.bpmn", "prompts/*.md"] },
});

// The blessed ADR 0062 shape: NO `models` block, so deployables are discovered by the `resources/`
// convention walk (prompts live at `resources/prompts/*.md`).
const MANIFEST_CONVENTION = JSON.stringify({ id: "app" });

function link(resourceId: string, bindingType = "latest"): string {
  return `<zeebe:linkedResource resourceId="${resourceId}" bindingType="${bindingType}" linkName="prompt" />`;
}

function serviceTask(inner: string): string {
  return `<bpmn:serviceTask id="t"><bpmn:extensionElements>${inner}</bpmn:extensionElements></bpmn:serviceTask>`;
}

// Build a throwaway app tree and return its root. Each entry maps a repo-relative path to content.
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agent-prompts-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test("passes when every prompt link resolves to a deployed, non-blank, result-emitting resource", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    "prompts/review-round.md": "# Round\nDo the thing, then write your result to `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assertEquals(res.errors, []);
  assert(res.ok);
  assertEquals(res.resolved, ["review-round"]);
});

test("discovers prompts by the resources/ convention when the manifest declares no models", () => {
  const root = fixture({
    "nano.app.json": MANIFEST_CONVENTION,
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    "resources/prompts/review-round.md": "# Round\nDo the thing, then write `$AGENT_RESULT_FILE`.",
    // Docs live OUTSIDE resources/ and must never be swept into the deploy set.
    "docs/agent-guide.md": "# Guide\nnot a deployable",
  });
  const res = checkAgentPrompts(root);
  assertEquals(res.errors, []);
  assert(res.ok);
  assertEquals(res.resolved, ["review-round"]);
});

test("convention walk flags a prompt link that has no deployed resource under resources/", () => {
  const root = fixture({
    "nano.app.json": MANIFEST_CONVENTION,
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    // The prompt lives OUTSIDE resources/ (old top-level prompts/ layout) so convention never
    // deploys it — the link would resolve to nothing at runtime.
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("no deployed resource has that name")));
});

test("fails when a prompt link references a resourceId with no deployed file", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(link("does-not-exist.md")),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("does-not-exist.md") && e.includes("no deployed resource")));
});

test("fails when the prompt exists on disk but is not wired into a deploy glob", () => {
  // The classic migration mistake: the prompt is left in the retired `models.templates` (which is
  // substituted, never deployed) instead of a deploy glob, so the engine never receives it.
  const root = fixture({
    "nano.app.json": JSON.stringify({
      models: { processes: ["resources/processes/*.bpmn"], templates: ["prompts/*.md"] },
    }),
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("review-round.md") && e.includes("no deployed resource")));
});

test("fails when the linked prompt resource is blank (would run prompt-less)", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    "prompts/review-round.md": "   \n  \n",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("empty") && e.includes("review-round.md")));
});

test("fails when a linkName=prompt link has an empty resourceId", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(link("")),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("empty resourceId")));
});

test("fails when the retired baked prompt header is still present", () => {
  // The deploy no longer substitutes {{token}} templates, so a surviving baked header ships a
  // literal placeholder as the prompt.
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(
      '<zeebe:taskHeaders><zeebe:header key="io.nanobpm.agentTask.task.prompt" value="{{review-round}}" /></zeebe:taskHeaders>',
    ),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("retired") && e.includes("linkedResource")));
});

test("fails when the retired baked prompt header survives with reordered attributes", () => {
  // XML attribute order is not significant: a retired header with `value` before `key` must still be
  // caught. The guard used to anchor `key` immediately after `<zeebe:header`, so a reordered header
  // would slip through and ship a literal placeholder as the prompt.
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(
      '<zeebe:taskHeaders><zeebe:header value="{{review-round}}" key="io.nanobpm.agentTask.task.prompt" /></zeebe:taskHeaders>',
    ),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("retired") && e.includes("linkedResource")));
});

test("fails when a linked prompt resource omits the machine-readable result mechanism", () => {
  // A prompt wired as an agent's base prompt must tell it to write $AGENT_RESULT_FILE (or use the
  // ::nano:result:: fallback). Without it the agent finishes with prose only, `status` comes back
  // blank, and the status gateway escalates/stalls — the fix-ci/rebase gap behind #746's stuck merge.
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    "prompts/review-round.md": "# Round\nReturn status: converged. (but never says how to emit it)",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("review-round.md") && e.includes("AGENT_RESULT_FILE")));
});

test("passes when a linked prompt resource emits via the ::nano:result:: fallback", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    "prompts/review-round.md": '# Round\nEmit `::nano:result:: {"status":"converged"}` at the end.',
  });
  const res = checkAgentPrompts(root);
  assertEquals(res.errors, []);
  assert(res.ok);
});

test("fails when a prompt link uses a bindingType other than latest", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md", "deployment")),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("review-round.md") && e.includes('bindingType="deployment"')));
});

test("fails when a prompt link omits bindingType entirely", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask(
      '<zeebe:linkedResource resourceId="review-round.md" linkName="prompt" />',
    ),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("review-round.md") && e.includes("(absent)")));
});

test("fails when no prompt link is wired at all", () => {
  const root = fixture({
    "nano.app.json": MANIFEST,
    "resources/processes/loop.bpmn": serviceTask('<zeebe:taskDefinition type="pr.noop" />'),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("unwired")));
});

test("fails when two deploy globs match files sharing a basename (ambiguous resource name)", () => {
  // Two deployed files with the same basename would silently overwrite in the resourceId lookup, so
  // a linkName="prompt" resourceId could resolve to the wrong file. The guard must fail fast.
  const root = fixture({
    "nano.app.json": JSON.stringify({
      models: { processes: ["resources/processes/*.bpmn", "prompts/*.md", "extra/*.md"] },
    }),
    "resources/processes/loop.bpmn": serviceTask(link("review-round.md")),
    "prompts/review-round.md": "# Round\nWrite `$AGENT_RESULT_FILE`.",
    "extra/review-round.md": "# Duplicate\nWrite `$AGENT_RESULT_FILE`.",
  });
  const res = checkAgentPrompts(root);
  assert(!res.ok);
  assert(res.errors.some((e) => e.includes("duplicate deployed resource name") && e.includes("review-round.md")));
});

test("checks the real repo: all committed agent prompts link to deployed resources", () => {
  // The guard must be green against the actual app it protects — this is the case CI relies on.
  const repoRoot = decodeURIComponent(new URL("../", import.meta.url).pathname);
  const res = checkAgentPrompts(repoRoot);
  assertEquals(res.errors, []);
  assert(res.ok);
  // Every senior:* agent prompt across the processes must resolve to a deployed prompt resource.
  for (const t of ["review-round", "fix-ci", "plan", "plan-review", "feature", "trial-merge", "rebase", "retro"]) {
    assert(res.resolved.includes(t), `expected prompt ${t} to resolve`);
  }
});
