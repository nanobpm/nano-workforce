// Tests for app/resolveApiBase.ts — the single canonical control-API base reconstruction shared by
// getAgentInstructions and getAgentSkill, plus the human-facing resolvePublicOrigin (#577). Covers
// proxy-header handling, scheme restriction, host sanitisation, x-forwarded-prefix sanitisation,
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

// ── resolveApiBase: x-forwarded-prefix sanitisation (#580) via the shared sanitiseForwardedPrefix ──
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

test("ignores a x-forwarded-prefix with percent-encoded .. traversal", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "/a/%2e%2e/%2e%2e" }, "/app/api/agent");
  assertEquals(resolveApiBase(r, "agent"), "http://h/app/api");
});

test("ignores a x-forwarded-prefix with a percent-encoded authority", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "/%2F%2Fevil.test" }, "/app/api/agent");
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

// ── resolvePublicOrigin: the human-facing ORIGIN (+ proxy prefix), no /app/api suffix (#577) ──
// Shares sanitiseForwardedPrefix with resolveApiBase, so the prefix policy (absolute-only, reject
// scheme/authority/traversal entirely, percent-aware) is identical on both surfaces — no drift.
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

test("resolvePublicOrigin: normalises a trailing slash on x-forwarded-prefix", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "/console/app-view/Workforce/" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://h/console/app-view/Workforce");
});

test("resolvePublicOrigin: treats a slash-only x-forwarded-prefix as empty (no double slash)", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "///" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://h");
});

test("resolvePublicOrigin: rejects a path-traversal x-forwarded-prefix entirely", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "/console/../../etc" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://h");
});

test("resolvePublicOrigin: rejects a scheme/authority x-forwarded-prefix", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "https://evil.example/hijack" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://h");
});

test("resolvePublicOrigin: rejects a relative (non-absolute) x-forwarded-prefix", () => {
  const r = req({ host: "h", "x-forwarded-prefix": "@evil.example" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://h");
});

test("resolvePublicOrigin: falls back to a localhost origin when the Host header is absent", () => {
  assertEquals(resolvePublicOrigin(req({}, "/app/api/actions/compile-delivery-graph")), "http://localhost:3000");
});

// ── host sanitisation: the untrusted x-forwarded-host/host authority is reflected into the URL ──
test("rejects a userinfo-injecting host (falls back to localhost)", () => {
  const r = req({ "x-forwarded-host": "evil.com@real.example" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://localhost:3000");
  assertEquals(resolveApiBase(req({ "x-forwarded-host": "evil.com@real.example" }, "/app/api/agent"), "agent"), "http://localhost:3000/app/api");
});

test("rejects a path-injecting host (falls back to localhost)", () => {
  const r = req({ "x-forwarded-host": "real.example/extra-path" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://localhost:3000");
});

test("accepts a host:port authority", () => {
  const r = req({ "x-forwarded-host": "wf.example.com:8443", "x-forwarded-proto": "https" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "https://wf.example.com:8443");
});

test("accepts a bracketed IPv6 host authority", () => {
  const r = req({ "x-forwarded-host": "[2001:db8::1]:3000" }, "/app/api/actions/compile-delivery-graph");
  assertEquals(resolvePublicOrigin(r), "http://[2001:db8::1]:3000");
});
