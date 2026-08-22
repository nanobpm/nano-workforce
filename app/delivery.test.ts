// Read-model derivation test for the epic delivery signal (issue #171). `deriveDelivery` is the
// single source of truth the `plan_delivery` VIEW (061) encodes and the pollers derive at READ TIME
// (epic #412 retired the stored `plans.delivery` / `plans.delivery_label` columns). It must cleanly
// distinguish an epic whose fan-out is `done` but whose slices are still CONVERGING from one where
// every slice PR has LANDED, and count abandoned/converged PRs as resolved-not-landed (never
// `landed`). The delivery-aware `list_bucket`/`ack_open` bucket derivation now lives in the
// `plan_read_model` VIEW (074), cross-checked against the pure helpers in app/plansReadModel.test.ts.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { deriveDelivery, TERMINAL_STATUSES } from "./delivery.ts";

test("all slice PRs merged -> landed", () => {
  const r = deriveDelivery("done", ["merged", "merged", "merged"]);
  assertEquals(r.delivery, "landed");
  assertEquals(r.prsOpened, 3);
  assertEquals(r.prsMerged, 3);
  assertEquals(r.prsInFlight, 0);
  assertEquals(r.label, "3/3 slices merged");
});

test("one slice PR still in flight -> converging", () => {
  const r = deriveDelivery("done", ["merged", "converging", "merged"]);
  assertEquals(r.delivery, "converging");
  assertEquals(r.prsOpened, 3);
  assertEquals(r.prsMerged, 2);
  assertEquals(r.prsInFlight, 1);
  assertEquals(r.label, "2/3 slices merged, 1 converging");
});

test("mixed merged/abandoned (all terminal, not all merged) -> resolved-not-landed (null)", () => {
  const r = deriveDelivery("done", ["merged", "abandoned", "merged"]);
  assertEquals(r.delivery, null);
  assertEquals(r.label, null);
  assertEquals(r.prsOpened, 3);
  assertEquals(r.prsMerged, 2);
  // abandoned is terminal, so it is NOT counted as in flight.
  assertEquals(r.prsInFlight, 0);
});

test("a converged (review-only, unmerged) slice keeps the epic out of landed", () => {
  // `converged` is terminal but not `merged`: resolved-not-landed, like abandoned.
  const r = deriveDelivery("done", ["merged", "converged"]);
  assertEquals(r.delivery, null);
  assertEquals(r.prsInFlight, 0);
  assertEquals(r.prsMerged, 1);
});

test("plan not yet done -> no delivery signal even with slice PRs", () => {
  for (const status of ["planning", "dispatched"]) {
    const r = deriveDelivery(status, ["merged", "converging"]);
    assertEquals(r.delivery, null, `status=${status}`);
    assertEquals(r.label, null, `status=${status}`);
  }
});

test("done but zero slice PRs -> no delivery signal", () => {
  const r = deriveDelivery("done", []);
  assertEquals(r.delivery, null);
  assertEquals(r.prsOpened, 0);
});

test("a single in-flight slice on a done plan is converging, not landed", () => {
  const r = deriveDelivery("done", ["waiting_review"]);
  assertEquals(r.delivery, "converging");
  assertEquals(r.label, "0/1 slices merged, 1 converging");
});

test("every non-terminal status counts as in flight", () => {
  const inFlight = ["converging", "waiting_review", "escalated", "queued", "open", "opened"];
  for (const s of inFlight) {
    assert(!TERMINAL_STATUSES.includes(s), `${s} must not be terminal`);
    const r = deriveDelivery("done", [s]);
    assertEquals(r.delivery, "converging", `status ${s}`);
    assertEquals(r.prsInFlight, 1, `status ${s}`);
  }
});
