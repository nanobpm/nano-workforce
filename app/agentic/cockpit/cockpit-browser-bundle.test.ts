// #660 — the browser transcript bundle is DERIVED from the typed core, and it RENDERS (never dumps raw
// `nwfTranscriptEvent` JSON).
//
// Two guarantees:
//  1. Drift guard — the committed `pages/cockpit/generated/*.js` is byte-identical to a fresh transpile
//     of the `.ts` core, so the deployed browser render path can never silently drift from the typed,
//     tested source (the exact failure mode #660 was: a hand-copy that lost the render path).
//  2. Behaviour — importing the GENERATED module the browser actually loads and rendering it into the
//     DOM double proves a `nwfTranscriptEvent` chunk is surfaced as derived turns/tool/diff/permission
//     cards, and NEVER verbatim.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { cockpitBrowserBundle } from "../../../scripts/build-cockpit-browser.ts";
import { FakeDocument, FakeElement } from "../../../test/agentic-cockpit-doubles.ts";
import { TRANSCRIPT_EVENT_MARKER, TRANSCRIPT_EVENT_VERSION } from "../transcript-events.ts";
// The module under test is the GENERATED browser artifact the deployed cockpit imports — NOT the .ts
// source — so this exercises exactly the code path the browser runs.
import { renderDerivedTranscript } from "../../../pages/cockpit/generated/transcript-derive.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("the committed browser bundle is byte-identical to its typed source (no drift surface)", () => {
  for (const { out, content } of cockpitBrowserBundle()) {
    const committed = readFileSync(resolve(repoRoot, out), "utf8");
    assertEquals(
      committed,
      content,
      `${out} is stale — regenerate with: node --experimental-strip-types scripts/build-cockpit-browser.ts`,
    );
  }
});

const doc = new FakeDocument();

function env(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, kind, ...extra });
}

/** A page whose chunks are `nwfTranscriptEvent` envelopes: messages, a tool call/result diff, a permission prompt. */
function report(): {
  stream: string;
  from: number;
  gap: boolean;
  nextOffset: number;
  entries: Array<{ offset: number; chunk: string }>;
} {
  const chunks = [
    env("turn", { index: 0 }),
    env("message", { role: "user", text: "please build it" }),
    env("tool-call", { name: "edit", callId: "c1", args: { path: "a.txt", oldText: "one\n", newText: "two\n" } }),
    env("tool-result", { callId: "c1", ok: true, content: "done" }),
    env("message", { role: "assistant", text: "built it" }),
    env("permission", {
      phase: "request",
      callId: "p1",
      policy: "escalate",
      title: "Run shell?",
      toolName: "bash",
      options: [
        { optionId: "ok", name: "Allow", kind: "allow-once" },
        { optionId: "no", name: "Deny", kind: "reject-once" },
      ],
    }),
  ];
  return { stream: "job:1", from: 0, gap: false, nextOffset: chunks.length, entries: chunks.map((chunk, offset) => ({ offset, chunk })) };
}

test("regression: a nwfTranscriptEvent chunk is rendered as derived cards, NEVER surfaced verbatim", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(host as never, doc, report() as never);
  // The rendered structured view exists…
  assertEquals(host.byClass("cockpit-transcript-derived").length, 1);
  // …and the raw envelope marker is nowhere in the rendered text (the #660 bug: raw JSON echoed).
  assert(!host.text().includes(TRANSCRIPT_EVENT_MARKER), "rendered transcript must not contain the raw nwfTranscriptEvent marker");
});

test("feature: messages coalesce into one turn, tool/diff card renders, permission prompt renders", () => {
  const host = new FakeElement("div");
  renderDerivedTranscript(host as never, doc, report() as never);

  // Message coalescing: both the user and assistant messages fold under a SINGLE derived turn section.
  const turns = host.byClass("cockpit-transcript-turn");
  assertEquals(turns.length, 1);
  const roles = turns[0]?.byClass("cockpit-transcript-message").map((n) => n.getAttribute("data-role")) ?? [];
  assertEquals(roles, ["user", "assistant"]);

  // Tool card with a synthesized diff (structured edit args → add/del lines).
  const tool = host.byData("tool", "edit")[0];
  assert(tool !== undefined, "the tool card is rendered");
  assertEquals(tool?.getAttribute("data-tool-kind"), "diff");
  const diffKinds = host.byClass("cockpit-transcript-diff-line").map((n) => n.getAttribute("data-diff-line"));
  assert(diffKinds.includes("add") && diffKinds.includes("del"), "the diff shows add + del lines");

  // Permission prompt with interactive Allow/Deny options.
  const perm = host.byData("permission", "request")[0];
  assert(perm !== undefined, "the permission prompt is rendered");
  assertEquals(perm?.getAttribute("data-status"), "pending");
  assertEquals(host.byClass("cockpit-transcript-permission-option").length, 2);
});
