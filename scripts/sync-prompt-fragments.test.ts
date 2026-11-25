// Drift guard for the shared friction-notes paragraph (issue #1101): every agent prompt carries the
// ONE canonical block from app/frictionNotes.ts, exactly once. Run `npm run sync:prompt-fragments`.
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { FRICTION_NOTES_BEGIN, frictionNotesBlock, withFrictionNotes } from "../app/frictionNotes.ts";
import { PROMPTS_DIR, staleFragmentFiles } from "./sync-prompt-fragments.ts";

test("every resources/prompts/*.md carries the canonical friction-notes block exactly once", () => {
  assertEquals(staleFragmentFiles().map((s) => s.file), []);
  for (const name of readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"))) {
    const md = readFileSync(`${PROMPTS_DIR}/${name}`, "utf8");
    assertEquals(md.split(FRICTION_NOTES_BEGIN).length - 1, 1, name);
    assert(md.includes(frictionNotesBlock()), name);
  }
});

test("withFrictionNotes appends once, then replaces in place (idempotent)", () => {
  const once = withFrictionNotes("# P\n\nbody\n");
  assert(once.endsWith(`${frictionNotesBlock()}\n`));
  assertEquals(withFrictionNotes(once), once);
  const stale = once.replace("Empty is fine.", "OLD");
  assertEquals(withFrictionNotes(stale), once);
});
