// Red/green for the persist-round world-marker contract boundary (issue #324, ADR 0062 Slice 4/5).
//
// `worldMarker` arrives from the c8ctl harness OUT-OF-PROCESS, so both the fence key and the effect
// kind are untrusted. `worldMarkerOf` must (a) TRIM `idempotencyKey` so whitespace variants of one
// real effect collapse to a single fence key (not distinct ledger rows that defeat the fence) and
// (b) reject an effect whose `kind` is not one of the canonical `EFFECT_KINDS`, so an unexpected kind
// can never enter the durable ledger.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { worldMarkerOf } from "../workers/persist-round/worker.ts";

// A well-formed 40-hex commit SHA — the ONLY shape `worldMarkerOf` now accepts for `commitSha`,
// since it is used as an EXACT checkout target on restore.
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

test("worldMarkerOf returns null when there is no marker or no commit SHA", () => {
  assertEquals(worldMarkerOf({}), null);
  assertEquals(worldMarkerOf({ worldMarker: { effects: [] } }), null);
  assertEquals(worldMarkerOf({ worldMarker: { commitSha: "   " } }), null);
});

test("worldMarkerOf rejects a commitSha that is not a well-formed 40-hex SHA", () => {
  // A branch name / arbitrary ref — would reconstruct to a moved tip, not an exact tree.
  assertEquals(worldMarkerOf({ worldMarker: { commitSha: "main" } }), null);
  // An abbreviated / short SHA — ambiguous, not a full object name.
  assertEquals(worldMarkerOf({ worldMarker: { commitSha: "a1b2c3d" } }), null);
  // 39 hex (one short) and 41 hex (one long) — length must be exactly 40.
  assertEquals(worldMarkerOf({ worldMarker: { commitSha: "a".repeat(39) } }), null);
  assertEquals(worldMarkerOf({ worldMarker: { commitSha: "a".repeat(41) } }), null);
  // A non-hex character in an otherwise 40-char string.
  assertEquals(worldMarkerOf({ worldMarker: { commitSha: `g${"a".repeat(39)}` } }), null);
});

test("worldMarkerOf trims a whitespace-tainted idempotencyKey so the fence key is canonical", () => {
  const m = worldMarkerOf({
    worldMarker: { commitSha: `  ${SHA}  `, effects: [{ kind: "pr-comment", idempotencyKey: "  c-1\n" }] },
  });
  assertEquals(m, { commitSha: SHA, effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }] });
});

test("worldMarkerOf drops an effect whose kind is not a known EffectKind", () => {
  const m = worldMarkerOf({
    worldMarker: {
      commitSha: SHA,
      effects: [
        { kind: "push", idempotencyKey: "sha-a" },
        { kind: "delete-branch", idempotencyKey: "x-1" }, // unknown kind — must be rejected
        { kind: "merge", idempotencyKey: "  " }, // blank key — must be rejected
      ],
    },
  });
  assertEquals(m, { commitSha: SHA, effects: [{ kind: "push", idempotencyKey: "sha-a" }] });
});

test("worldMarkerOf omits effects entirely when every effect is invalid", () => {
  const m = worldMarkerOf({
    worldMarker: { commitSha: SHA, effects: [{ kind: "bogus", idempotencyKey: "y-1" }] },
  });
  assertEquals(m, { commitSha: SHA });
});

test("worldMarkerOf keeps a trimmed non-empty description and drops a blank one", () => {
  const m = worldMarkerOf({
    worldMarker: {
      commitSha: SHA,
      effects: [
        { kind: "push", idempotencyKey: "sha-a", description: "  landed the fix  " },
        { kind: "merge", idempotencyKey: "m-1", description: "   " },
      ],
    },
  });
  assertEquals(m, {
    commitSha: SHA,
    effects: [
      { kind: "push", idempotencyKey: "sha-a", description: "landed the fix" },
      { kind: "merge", idempotencyKey: "m-1" },
    ],
  });
});
