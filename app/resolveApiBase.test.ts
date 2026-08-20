// Tests for app/resolveApiBase.ts — the single canonical control-API base reconstruction shared by
// getAgentInstructions and getAgentSkill. Covers proxy-header handling, scheme restriction,
// host-absent fallback, and mount-suffix stripping for both mount depths.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { resolveApiBase } from "./resolveApiBase.ts";

function req(headers: Record<string, string>, path: string) {
  return { path, headers: new Headers(headers) };
}

test("strips the single-segment mount suffix to recover the base", () => {
  assertEquals(resolveApiBase(req({ host: "wf.example.com" }, "/app/api/agent"), "agent"), "http://wf.example.com/app/api");
});

test("strips the nested mount suffix to recover the base", () => {
  assertEquals(
    resolveApiBase(req({ host: "wf.example.com" }, "/app/api/agent/skill"), "agent/skill"),
    "http://wf.example.com/app/api",
  );
});

test("honours x-forwarded-proto and x-forwarded-host", () => {
  const r = req({ host: "internal", "x-forwarded-host": "wf.example.com", "x-forwarded-proto": "https" }, "/app/api/agent");
  assertEquals(resolveApiBase(r, "agent"), "https://wf.example.com/app/api");
});

test("restricts x-forwarded-proto to http/https", () => {
  const r = req({ host: "wf.example.com", "x-forwarded-proto": "javascript" }, "/app/api/agent/skill");
  assertEquals(resolveApiBase(r, "agent/skill"), "http://wf.example.com/app/api");
});

test("falls back to a localhost default when the Host header is absent", () => {
  assertEquals(resolveApiBase(req({}, "/app/api/agent"), "agent"), "http://localhost:3000/app/api");
});

test("tolerates a leading slash on the mount suffix", () => {
  assertEquals(resolveApiBase(req({ host: "h" }, "/app/api/agent"), "/agent"), "http://h/app/api");
});
