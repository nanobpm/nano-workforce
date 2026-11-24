// Unit tests for the /status + /escalations filter vocabulary (issue #1060).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { parseEscalationFilter, parseStatusFilter, repoOfKey } from "./listFilters.ts";

test("parseStatusFilter accepts repeated and comma-separated values", () => {
  const r = parseStatusFilter({ status: ["converging", "escalated,incident"], key: "o/r#1" });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.filter.statuses, ["converging", "escalated", "incident"]);
    assertEquals(r.filter.keys, ["o/r#1"]);
    assertEquals(r.filter.hasEscalation, null);
  }
});

test("parseStatusFilter rejects a repeated hasEscalation / updatedSince", () => {
  assert(!parseStatusFilter({ hasEscalation: ["true", "false"] }).ok);
  assert(!parseStatusFilter({ updatedSince: ["2026-01-01", "2026-01-02"] }).ok);
});

test("parseEscalationFilter maps the epic alias onto plan", () => {
  const r = parseEscalationFilter({ kind: ["epic", "pr"] });
  assert(r.ok);
  if (r.ok) assertEquals(r.filter.kinds, ["plan", "pr"]);
});

test("repoOfKey derives owner/repo from a PR key", () => {
  assertEquals(repoOfKey("o/r#12"), "o/r");
  assertEquals(repoOfKey("plan-1"), null);
  assertEquals(repoOfKey(null), null);
});
