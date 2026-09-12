// Tests for app/consoleRedirect.ts — the standalone `/console` → engine-console redirect (issue
// #771). Covers the pure match/target derivation, origin resolution from NANOBPMN_BASE_URL, and the
// live listener-rewiring mount over a real node:http server (redirect fires for `/console/*`,
// passthrough for everything else, teardown restores the original handler).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  consoleRedirectLocation,
  mountConsoleRedirect,
  resolveConsoleOrigin,
} from "./consoleRedirect.ts";

test("redirects a bare /console path to the console origin", () => {
  assertEquals(consoleRedirectLocation("/console", "http://localhost:8080"), "http://localhost:8080/console");
});

test("preserves the full path and query under /console/", () => {
  assertEquals(
    consoleRedirectLocation("/console/app-view/Foo?tab=bar&x=1", "http://localhost:8080"),
    "http://localhost:8080/console/app-view/Foo?tab=bar&x=1",
  );
});

test("leaves /app/* and root routes unchanged (null)", () => {
  assertEquals(consoleRedirectLocation("/app/api/agent", "http://localhost:8080"), null);
  assertEquals(consoleRedirectLocation("/", "http://localhost:8080"), null);
  assertEquals(consoleRedirectLocation("/agentic", "http://localhost:8080"), null);
});

test("does not match a sibling route that merely starts with 'console'", () => {
  assertEquals(consoleRedirectLocation("/console-x", "http://localhost:8080"), null);
  assertEquals(consoleRedirectLocation("/consolexyz/app", "http://localhost:8080"), null);
});

test("matches /console immediately followed by a query", () => {
  assertEquals(consoleRedirectLocation("/console?next=1", "http://localhost:8080"), "http://localhost:8080/console?next=1");
});

test("normalises a trailing slash on the console origin", () => {
  assertEquals(consoleRedirectLocation("/console/x", "http://localhost:8080/"), "http://localhost:8080/console/x");
});

test("handles an absent url", () => {
  assertEquals(consoleRedirectLocation(undefined, "http://localhost:8080"), null);
});

test("resolveConsoleOrigin gives CAMUNDA_REST_ADDRESS precedence over NANOBPMN_BASE_URL", () => {
  const read = (name: string): string | null =>
    name === "CAMUNDA_REST_ADDRESS"
      ? "http://engine.example:8080/v2"
      : name === "NANOBPMN_BASE_URL"
        ? "http://localhost:9999"
        : null;
  assertEquals(resolveConsoleOrigin(read), "http://engine.example:8080");
});

test("resolveConsoleOrigin uses NANOBPMN_BASE_URL when CAMUNDA_REST_ADDRESS is unset", () => {
  const read = (name: string): string | null =>
    name === "NANOBPMN_BASE_URL" ? "https://engine.example.com:9000" : null;
  assertEquals(resolveConsoleOrigin(read), "https://engine.example.com:9000");
});

test("resolveConsoleOrigin derives the origin from NANOBPMN_BASE_URL", () => {
  assertEquals(resolveConsoleOrigin(() => "https://engine.example.com:9000"), "https://engine.example.com:9000");
});

test("resolveConsoleOrigin strips any path from the base", () => {
  assertEquals(resolveConsoleOrigin(() => "https://engine.example.com/v2/"), "https://engine.example.com");
});

test("resolveConsoleOrigin defaults to localhost:8080 when unset", () => {
  assertEquals(resolveConsoleOrigin(() => null), "http://localhost:8080");
});

test("resolveConsoleOrigin falls back to the default on an unparseable value", () => {
  assertEquals(resolveConsoleOrigin(() => "not a url"), "http://localhost:8080");
});

/** Spin up a real server with an app handler, mount the redirect, and return a fetch helper. */
async function withServer(
  run: (base: string, teardown: () => void) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end("app-handled");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const teardown = mountConsoleRedirect(server, "http://console.example:8080");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, teardown);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("mount: /console/* is answered with a 302 to the console origin, not the app handler", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/console/app-view/Workforce?tab=x`, { redirect: "manual" });
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "http://console.example:8080/console/app-view/Workforce?tab=x");
    // 302 body is empty — the app handler must not have run.
    assertEquals(await res.text(), "");
  });
});

test("mount: a non-console request is delegated to the app handler unchanged", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/app/api/agent`, { redirect: "manual" });
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "app-handled");
  });
});

test("mount: teardown restores the original app handler for /console too", async () => {
  await withServer(async (base, teardown) => {
    teardown();
    const res = await fetch(`${base}/console/x`, { redirect: "manual" });
    assertEquals(res.status, 200);
    assert((await res.text()) === "app-handled");
  });
});
