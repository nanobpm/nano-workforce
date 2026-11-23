// Issue #1034: /status must name a review wait — `waiting_review(<sha7>)` — instead of the generic
// `waiting_merge` that read identically to "waiting for CI".
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { parseReviewHead, reviewHeadToken, reviewWaitReason } from "./reviewWait.ts";

const HEAD = "51c424c0123456789abcdef0123456789abcdef0";

test("the head token round-trips through the audit detail", () => {
  assertEquals(parseReviewHead(`no head-current review ${reviewHeadToken(HEAD)}`), HEAD);
  assertEquals(parseReviewHead("no token"), null);
  assertEquals(parseReviewHead(null), null);
});

test("a newest review-pending / review-requested row derives waiting_review(<sha7>)", () => {
  const rows = [
    { id: 1, outcome: "blocked", detail: "x" },
    { id: 2, outcome: "review-pending", detail: `d ${reviewHeadToken(HEAD)}` },
    { id: 3, outcome: "review-requested", detail: "head-current Copilot review request #1: requested" },
  ];
  assertEquals(reviewWaitReason(rows), "waiting_review(51c424c)");
  assertEquals(reviewWaitReason(rows.slice(0, 2)), "waiting_review(51c424c)");
});

test("no head recorded → waiting_review; a non-review newest row or no rows → null", () => {
  assertEquals(reviewWaitReason([{ id: 1, outcome: "review-pending", detail: "legacy" }]), "waiting_review");
  assertEquals(
    reviewWaitReason([
      { id: 1, outcome: "review-pending", detail: reviewHeadToken(HEAD) },
      { id: 2, outcome: "queued", detail: "" },
    ]),
    null,
  );
  assertEquals(reviewWaitReason([]), null);
});
