// Pure derivation tests for epic promotion (issue #299). `app/promotion.ts` is the I/O-free core of
// the "promote a landed epic's integration branch to the default branch" automation: the promotable
// predicate, the epic-card state derivation, and the promotion PR title/body rendering. The poller
// (`pollPromotion`) is exercised separately in `app/promotionPoll.test.ts`.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { derivePromotionState, isEpicIntegrationBranch, isPromotable, promotionPrBody, promotionPrTitle } from "./promotion.ts";

test("isPromotable: landed on an epic/* base is promotable", () => {
  assert(isPromotable({ delivery: "landed", base_branch: "epic/test-dsl" }));
});

test("isPromotable: a main-based epic has nothing to promote", () => {
  assert(!isPromotable({ delivery: "landed", base_branch: "main" }));
  assert(!isPromotable({ delivery: "landed", base_branch: null }));
});

test("isPromotable: a still-converging epic is never promoted, even on an epic/* base", () => {
  assert(!isPromotable({ delivery: "converging", base_branch: "epic/x" }));
  assert(!isPromotable({ delivery: null, base_branch: "epic/x" }));
});

test("isEpicIntegrationBranch: only epic/* branches match", () => {
  assert(isEpicIntegrationBranch("epic/foo"));
  assert(!isEpicIntegrationBranch("main"));
  assert(!isEpicIntegrationBranch("feat/epic-ish"));
  assert(!isEpicIntegrationBranch(null));
});

test("derivePromotionState: ready → open → promoted progression", () => {
  assertEquals(derivePromotionState(false, false), "ready");
  assertEquals(derivePromotionState(true, false), "open");
  assertEquals(derivePromotionState(true, true), "promoted");
});

test("promotionPrTitle: names branch, target, and epic identity", () => {
  assertEquals(
    promotionPrTitle("epic/test-dsl", "main", "Assertion DSL"),
    "Promote epic/test-dsl → main: Assertion DSL",
  );
});

test("promotionPrBody: closes the epic issue and lists the merged slices", () => {
  const body = promotionPrBody("epic/x", "main", "o/r#295", ["o/r#299", "o/r#304"]);
  assert(body.includes("epic/x"));
  assert(body.includes("main"));
  assert(body.includes("Closes o/r#295"));
  assert(body.includes("- o/r#299"));
  assert(body.includes("- o/r#304"));
});

test("promotionPrBody: omits the slice list when there are none", () => {
  const body = promotionPrBody("epic/x", "main", "o/r#295", []);
  assert(body.includes("Closes o/r#295"));
  assert(!body.includes("Merged slices:"));
});
