// Unit tests for the /status + /escalations filter vocabulary (issue #1060).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { applyEscalationFilter, parseEscalationFilter, parseStatusFilter, repoOfKey } from "./listFilters.ts";

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
  assert(!parseStatusFilter({ updatedSince: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"] }).ok);
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

test("parseStatusFilter accepts the merging status", () => {
  assert(parseStatusFilter({ status: "merging" }).ok);
});

test("key values are opaque: a comma inside a key is preserved (both endpoints)", () => {
  const s = parseStatusFilter({ key: ["release,prod", "o/r#1"] });
  assert(s.ok);
  if (s.ok) assertEquals(s.filter.keys, ["release,prod", "o/r#1"]);
  const e = parseEscalationFilter({ key: "release,prod" });
  assert(e.ok);
  if (e.ok) assertEquals(e.filter.keys, ["release,prod"]);
});

test("a supplied blank filter value is rejected, not dropped", () => {
  for (const q of [{ repo: "" }, { repo: "  " }, { key: "" }, { kind: "" }, { status: "converging," }, { hasEscalation: "" }, { updatedSince: "" }]) {
    assert(!parseStatusFilter(q).ok, JSON.stringify(q));
  }
  for (const q of [{ repo: "" }, { key: " " }, { kind: "pr," }]) assert(!parseEscalationFilter(q).ok, JSON.stringify(q));
});

test("updatedSince must be a valid timezone-bearing ISO date-time", () => {
  for (const v of ["0", "2026-02-30T00:00:00Z", "2026-01-01T00:00:00", "2026-01-01", "2026-13-01T00:00:00Z"]) {
    assert(!parseStatusFilter({ updatedSince: v }).ok, v);
  }
  const r = parseStatusFilter({ updatedSince: "2026-01-01T00:00:00+02:00" });
  assert(r.ok);
  if (r.ok) assertEquals(r.filter.updatedSince, Date.parse("2026-01-01T00:00:00+02:00"));
  assert(parseStatusFilter({ updatedSince: "2024-02-29T12:30:00.5Z" }).ok);
});

test("escalation repo filter: opaque delivery/agent subject keys never infer a repo (use subjectUrl)", () => {
  const f = parseEscalationFilter({ repo: "acme/service" });
  const wrong = parseEscalationFilter({ repo: "release/prod" });
  assert(f.ok && wrong.ok);
  if (!f.ok || !wrong.ok) return;
  for (const subjectType of ["delivery", "agent"]) {
    const row = { subjectType, subjectKey: "release/prod#1", prKey: null, subjectUrl: "https://github.com/acme/service/issues/9" };
    assertEquals(applyEscalationFilter([row], f.filter).length, 1);
    assertEquals(applyEscalationFilter([row], wrong.filter).length, 0);
  }
  const pr = { subjectType: "pr", subjectKey: "acme/service#3", prKey: null, subjectUrl: null };
  assertEquals(applyEscalationFilter([pr], f.filter).length, 1);
});

test("escalation repo filter: repo-root subjectUrl with no trailing path still matches", () => {
  const f = parseEscalationFilter({ repo: "acme/service" });
  assert(f.ok);
  if (!f.ok) return;
  for (const subjectUrl of ["https://github.com/acme/service", "https://github.com/acme/service/", "https://github.com/acme/service?x=1", "https://github.com/acme/service#readme", "https://github.com/acme/service.git"]) {
    const row = { subjectType: "delivery", subjectKey: "opaque", prKey: null, subjectUrl };
    assertEquals(applyEscalationFilter([row], f.filter).length, 1);
  }
  const other = { subjectType: "delivery", subjectKey: "opaque", prKey: null, subjectUrl: "https://github.com/acme/service-two" };
  assertEquals(applyEscalationFilter([other], f.filter).length, 0);
});
