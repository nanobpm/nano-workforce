// Tests for app/resolveApiBase.ts — the single canonical control-API base reconstruction shared by
// getAgentInstructions and getAgentSkill. Covers proxy-header handling, scheme restriction,
// host-absent fallback, and mount-suffix stripping for both mount depths.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { resolveApiBase, resolvePublicOrigin } from "./resolveApiBase.ts";

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

// ── resolvePublicOrigin: the human-facing ORIGIN (+ proxy prefix), no /app/api suffix (#577) ──
test("resolvePublicOrigin: bare origin from the host header", () => {
  assertEquals(resolvePublicOrigin(req({ host: "wf.example.com" }, "/app/api/actions/compile-delivery-graph")), "http://wf.example.com");
});

test("resolvePublicOrigin: honours x-forwarded-proto and x-forwarded-host", () => {
  const r = req({ host: "internal", "x-forwarded-host": "example.test", "x-forwarded-proto": "https" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "https://example.test");
});

test("resolvePublicOrigin: restricts x-forwarded-proto to http/https", () => {
  const r = req({ host: "wf.example.com", "x-forwarded-proto": "javascript" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://wf.example.com");
});

test("resolvePublicOrigin: appends the reverse-proxy x-forwarded-prefix", () => {
  const r = req(
    { "x-forwarded-host": "nano.ngrok-free.dev", "x-forwarded-proto": "https", "x-forwarded-prefix": "/console/app-view/Workforce" },
    "/app/api/actions/compile-delivery-graph",
  );
  assertEquals(resolvePublicOrigin(r), "https://nano.ngrok-free.dev/console/app-view/Workforce");
});

test("resolvePublicOrigin: normalises stray slashes on x-forwarded-prefix", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "console/app-view///" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://h/console/app-view");
});

test("resolvePublicOrigin: falls back to a localhost origin when the Host header is absent", () => {
  assertEquals(resolvePublicOrigin(req({}, "/app/api/actions/compile-delivery-graph")), "http://localhost:3000");
});
