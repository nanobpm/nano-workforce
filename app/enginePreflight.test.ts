// Tests for engine address resolution + the startup preflight (nano-workforce#391).
//
// The resolver and the identity description are pure (an injectable env reader /
// a plain topology body), and the preflight takes an injectable `fetch`, so none
// of this needs a live engine or `process.env` mutation.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  announceEngine,
  describeEngine,
  type EngineAddress,
  resolveEngineAddress,
  type TopologyProbe,
} from "./enginePreflight.ts";

const reader = (vars: Record<string, string>) => (name: string): string | null => vars[name] ?? null;

test("resolveEngineAddress honours an explicit CAMUNDA_REST_ADDRESS and strips trailing slashes", () => {
  const addr = resolveEngineAddress(reader({ CAMUNDA_REST_ADDRESS: "http://engine.example:8080/v2///" }));
  assertEquals(addr, { restAddress: "http://engine.example:8080/v2", source: "CAMUNDA_REST_ADDRESS" });
});

test("resolveEngineAddress derives /v2 from NANOBPMN_BASE_URL when no explicit address", () => {
  const addr = resolveEngineAddress(reader({ NANOBPMN_BASE_URL: "http://engine.example:7000//" }));
  assertEquals(addr, { restAddress: "http://engine.example:7000/v2", source: "NANOBPMN_BASE_URL" });
});

test("resolveEngineAddress defaults to localhost:8080 and labels the source as the default", () => {
  const addr = resolveEngineAddress(reader({}));
  assertEquals(addr, { restAddress: "http://localhost:8080/v2", source: "default (http://localhost:8080)" });
});

test("describeEngine reports a Nano engine from the `nano` marker", () => {
  const line = describeEngine({ nano: { engine: "nanobpmn", version: "0.114.1", falconPath: "/falcon" } });
  assert(line.includes("Nano engine (nanobpmn v0.114.1)"), "names the nano engine + version");
  assert(line.includes("/falcon"), "mentions the Falcon path");
});

test("describeEngine reports Camunda 8 (never rejects) when the `nano` marker is absent", () => {
  const line = describeEngine({ gatewayVersion: "8.6.0" });
  assert(line.startsWith("Camunda 8"), "identifies Camunda 8");
  assert(line.includes("8.6.0"), "surfaces the gateway version");
  assert(line.includes("REST only"), "notes Falcon is unavailable");
});

test("describeEngine tolerates an empty / missing body", () => {
  assert(describeEngine(null).startsWith("Camunda 8"), "null body degrades to Camunda 8");
  assert(describeEngine({}).startsWith("Camunda 8"), "empty body degrades to Camunda 8");
});

// --- announceEngine (injected fetch; never throws) ---

const ADDR: EngineAddress = { restAddress: "http://localhost:8080/v2", source: "default (http://localhost:8080)" };

function capture() {
  const info: string[] = [];
  const warn: string[] = [];
  return { log: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) }, info, warn };
}

const okResponse = (body: TopologyProbe) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

test("announceEngine logs the resolved address + a Nano identity line", async () => {
  const { log, info, warn } = capture();
  let probed = "";
  await announceEngine(ADDR, log, {
    fetchImpl: ((url: string) => {
      probed = url;
      return Promise.resolve(okResponse({ nano: { engine: "nanobpmn", version: "1.2.3", falconPath: "/falcon" } }));
    }) as unknown as typeof fetch,
  });
  assertEquals(probed, "http://localhost:8080/v2/topology");
  assert(info.some((l) => l.includes("Engine address: http://localhost:8080/v2 (from default")), "echoes address+source");
  assert(info.some((l) => l.includes("Nano engine (nanobpmn v1.2.3)")), "announces the Nano engine");
  assertEquals(warn, []);
});

test("announceEngine announces Camunda 8 without rejecting", async () => {
  const { log, info, warn } = capture();
  await announceEngine(ADDR, log, {
    fetchImpl: (() => Promise.resolve(okResponse({ gatewayVersion: "8.6.0" }))) as unknown as typeof fetch,
  });
  assert(info.some((l) => l.includes("Camunda 8")), "announces Camunda 8");
  assertEquals(warn, []);
});

test("announceEngine sends CAMUNDA_TOKEN as a bearer credential on the probe", async () => {
  const { log } = capture();
  let sentAuth: string | undefined;
  await announceEngine(ADDR, log, {
    token: "secret-token",
    fetchImpl: ((_url: string, init: { headers: Record<string, string> }) => {
      sentAuth = init.headers.authorization;
      return Promise.resolve(okResponse({ nano: { engine: "nanobpmn" } }));
    }) as unknown as typeof fetch,
  });
  assertEquals(sentAuth, "Bearer secret-token");
});

test("announceEngine treats 401/403 as an auth hint, not an unreachable warning", async () => {
  const { log, warn } = capture();
  const res = { ok: false, status: 401, json: () => Promise.reject(new Error("unused")) } as unknown as Response;
  await announceEngine(ADDR, log, { fetchImpl: (() => Promise.resolve(res)) as unknown as typeof fetch });
  assert(warn.some((l) => l.includes("HTTP 401") && l.includes("CAMUNDA_TOKEN")), "points at the token, not unreachability");
  assert(!warn.some((l) => l.includes("could not reach")), "does not claim the engine is unreachable");
});

test("announceEngine warns (does not throw) on a non-200 response", async () => {
  const { log, warn } = capture();
  const res = { ok: false, status: 503, json: () => Promise.reject(new Error("unused")) } as unknown as Response;
  await announceEngine(ADDR, log, { fetchImpl: (() => Promise.resolve(res)) as unknown as typeof fetch });
  assert(warn.some((l) => l.includes("HTTP 503")), "warns with the status code");
});

test("announceEngine warns (does not throw) when the engine is unreachable", async () => {
  const { log, warn } = capture();
  await announceEngine(ADDR, log, {
    fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
  });
  assert(warn.some((l) => l.includes("could not reach") && l.includes("ECONNREFUSED")), "warns with the reason");
});
