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

test("worldMarkerOf returns null when there is no marker or no commit SHA", () => {
  assertEquals(worldMarkerOf({}), null);
  assertEquals(worldMarkerOf({ worldMarker: { effects: [] } }), null);
  assertEquals(worldMarkerOf({ worldMarker: { commitSha: "   " } }), null);
});

test("worldMarkerOf trims a whitespace-tainted idempotencyKey so the fence key is canonical", () => {
  const m = worldMarkerOf({
    worldMarker: { commitSha: "  abc123  ", effects: [{ kind: "pr-comment", idempotencyKey: "  c-1\n" }] },
  });
  assertEquals(m, { commitSha: "abc123", effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }] });
});

test("worldMarkerOf drops an effect whose kind is not a known EffectKind", () => {
  const m = worldMarkerOf({
    worldMarker: {
      commitSha: "abc123",
      effects: [
        { kind: "push", idempotencyKey: "sha-a" },
        { kind: "delete-branch", idempotencyKey: "x-1" }, // unknown kind — must be rejected
        { kind: "merge", idempotencyKey: "  " }, // blank key — must be rejected
      ],
    },
  });
  assertEquals(m, { commitSha: "abc123", effects: [{ kind: "push", idempotencyKey: "sha-a" }] });
});

test("worldMarkerOf omits effects entirely when every effect is invalid", () => {
  const m = worldMarkerOf({
    worldMarker: { commitSha: "abc123", effects: [{ kind: "bogus", idempotencyKey: "y-1" }] },
  });
  assertEquals(m, { commitSha: "abc123" });
});

test("worldMarkerOf keeps a trimmed non-empty description and drops a blank one", () => {
  const m = worldMarkerOf({
    worldMarker: {
      commitSha: "abc123",
      effects: [
        { kind: "push", idempotencyKey: "sha-a", description: "  landed the fix  " },
        { kind: "merge", idempotencyKey: "m-1", description: "   " },
      ],
    },
  });
  assertEquals(m, {
    commitSha: "abc123",
    effects: [
      { kind: "push", idempotencyKey: "sha-a", description: "landed the fix" },
      { kind: "merge", idempotencyKey: "m-1" },
    ],
  });
});
