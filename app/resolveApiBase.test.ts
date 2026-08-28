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

test("strips multiple trailing slashes after the mount suffix", () => {
  assertEquals(resolveApiBase(req({ host: "h" }, "/app/api/agent/skill///"), "agent/skill"), "http://h/app/api");
});

test("prepends a validated x-forwarded-prefix to the reconstructed base", () => {
  const r = req(
    { host: "nano.ngrok-free.dev", "x-forwarded-prefix": "/console/app-view/Workforce" },
    "/app/api/agent",
  );
  assertEquals(resolveApiBase(r, "agent"), "http://nano.ngrok-free.dev/console/app-view/Workforce/app/api");
});

test("normalises a trailing slash on x-forwarded-prefix", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "/console/app-view/Workforce/" }, "/app/api/agent");
  assertEquals(resolveApiBase(r, "agent"), "http://h/console/app-view/Workforce/app/api");
});

test("ignores a x-forwarded-prefix carrying a scheme", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "https://evil.test" }, "/app/api/agent");
  assertEquals(resolveApiBase(r, "agent"), "http://h/app/api");
});

test("ignores a x-forwarded-prefix carrying an authority", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "//evil.test" }, "/app/api/agent");
  assertEquals(resolveApiBase(r, "agent"), "http://h/app/api");
});

test("ignores a x-forwarded-prefix with .. traversal", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "/a/../.." }, "/app/api/agent");
  assertEquals(resolveApiBase(r, "agent"), "http://h/app/api");
});

test("ignores a relative (non-absolute) x-forwarded-prefix", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "console/app-view/Workforce" }, "/app/api/agent");
  assertEquals(resolveApiBase(r, "agent"), "http://h/app/api");
});

test("prefix composes with x-forwarded-proto and x-forwarded-host", () => {
  const r = req(
    {
      host: "internal",
      "x-forwarded-host": "nano.ngrok-free.dev",
      "x-forwarded-proto": "https",
      "x-forwarded-prefix": "/console/app-view/Workforce",
    },
    "/app/api/agent/skill",
  );
  assertEquals(resolveApiBase(r, "agent/skill"), "https://nano.ngrok-free.dev/console/app-view/Workforce/app/api");
});
