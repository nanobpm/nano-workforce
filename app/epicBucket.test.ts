// Read-model derivation test for the EPIC Active/History bucket (issue #298). `deriveEpicBucket` is
// the single source of truth for `plans.list_bucket`, and `epicIsAcknowledgeable` gates the Dismiss
// affordance (`plans.ack_open` + the acknowledge-epic 409 guard). The defect this guards: any epic
// list that buckets on RAW terminal `status` (`done`) instead of the derived `delivery` rollup makes
// an epic vanish from Active the instant `status=done` — while its slices are still converging, or
// while it has landed but still needs its integration→main promotion PR.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { deriveEpicBucket, EPIC_LIVE_STATUSES, epicIsAcknowledgeable } from "./delivery.ts";

test("a live epic (planning/dispatched) is always Active, whatever the delivery", () => {
  for (const status of EPIC_LIVE_STATUSES) {
    assertEquals(deriveEpicBucket(status, null, null), "active", `status=${status}`);
    // delivery is always null pre-`done`, but guard the predicate anyway.
    assertEquals(deriveEpicBucket(status, "converging", null), "active", `status=${status}`);
  }
});

// The core regression (red before the fix): a `done` epic whose slices are still converging must NOT
// fall to History just because `status=done`.
test("done + converging -> Active (the epic must not vanish while slices converge)", () => {
  assertEquals(deriveEpicBucket("done", "converging", null), "active");
  // An operator has no way to acknowledge a converging epic away either.
  assert(!epicIsAcknowledgeable("done", "converging"));
});

test("done + landed + unacknowledged -> Active (stays actionable until dismissed)", () => {
  assertEquals(deriveEpicBucket("done", "landed", null), "active");
  assert(epicIsAcknowledgeable("done", "landed"));
});

test("done + landed + acknowledged -> History", () => {
  assertEquals(deriveEpicBucket("done", "landed", "2024-01-01T00:00:00Z"), "history");
});

// A `done` epic with no positive delivery signal is either just-`done` (the poller has not projected
// `delivery` yet) or resolved-not-landed (every PR terminal, not all merged). Either way it must NOT
// flicker into History on `status=done` alone — it stays Active and acknowledgeable until dismissed.
test("done + delivery=null (poller-pending / resolved-not-landed) -> Active, acknowledgeable", () => {
  assertEquals(deriveEpicBucket("done", null, null), "active");
  assert(epicIsAcknowledgeable("done", null));
  // Once the operator dismisses it (acknowledged), it settles to History.
  assertEquals(deriveEpicBucket("done", null, "2024-01-01T00:00:00Z"), "history");
});

test("terminal non-done statuses (failed/abandoned) -> History, not acknowledgeable", () => {
  for (const status of ["failed", "abandoned"]) {
    assertEquals(deriveEpicBucket(status, null, null), "history", `status=${status}`);
    assert(!epicIsAcknowledgeable(status, null), `status=${status}`);
  }
});

// Fail-closed: an acknowledged timestamp on a still-converging epic must NOT drag it to History (only
// a LANDED epic is acknowledgeable; a stale/premature stamp is ignored by the bucket).
test("acknowledged_at on a converging epic is ignored -> still Active", () => {
  assertEquals(deriveEpicBucket("done", "converging", "2024-01-01T00:00:00Z"), "active");
});
