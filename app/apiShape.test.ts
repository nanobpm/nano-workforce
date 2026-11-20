// Unit tests for the Camunda-aligned API shape helpers (#972).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { listEnvelope, pickKey, withProcessInstanceKey } from "./apiShape.ts";

test("listEnvelope: wraps a list as { items, page: { totalItems } }", () => {
  assertEquals(listEnvelope([1, 2, 3]), { items: [1, 2, 3], page: { totalItems: 3 } });
  assertEquals(listEnvelope([]), { items: [], page: { totalItems: 0 } });
});

test("withProcessInstanceKey: renames the internal processKey to processInstanceKey (no processKey on the wire)", () => {
  assertEquals(withProcessInstanceKey({ a: 1, processKey: "9" }), { a: 1, processInstanceKey: "9" });
  assertEquals(withProcessInstanceKey({ processKey: null }), { processInstanceKey: null });
  assertEquals(withProcessInstanceKey({}), { processInstanceKey: null });
});

test("pickKey: the canonical name wins; blank values fall through; non-objects yield empty", () => {
  assertEquals(pickKey({ prKey: "a", pr_key: "b" }, "prKey", "pr_key"), "a");
  assertEquals(pickKey({ prKey: "  ", pr_key: " b " }, "prKey", "pr_key"), "b");
  assertEquals(pickKey({ prKey: 7 }, "prKey"), "");
  assertEquals(pickKey(undefined, "prKey"), "");
});
