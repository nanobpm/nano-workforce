// Unit coverage for the pr.readiness-probe poll loop (workers/readiness-probe/worker.ts, #258).
//
// The loop is factored out (`pollUntilReady`) with injectable I/O, clock, and publisher so the two
// load-bearing behaviours are proven without a network, a subprocess, or a real timer:
//   • ready → it publishes the `readiness-ready` message exactly once and returns ready;
//   • never-ready → it EXHAUSTS its local budget and returns not-ready WITHOUT publishing (the
//     engine timer, not the worker, is the authoritative bound) — and it must not loop forever.
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "#test-assert";
import type { CommandResult, HttpResponse, ProbeExec, ReadinessProbe } from "../../app/readiness.ts";
import { parseProbe } from "../../app/readiness.ts";
import handler, { pollUntilReady, READINESS_READY_MESSAGE, readGateVars, safeBind } from "./worker.ts";

// A virtual clock: `now()` advances only when the loop's `wait(ms)` is called, so a never-ready
// probe races to its deadline in zero real time (no setTimeout) and the test can never hang.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms: number) => {
      t += ms;
    },
  };
}

function execReturning(seq: Array<HttpResponse>): ProbeExec {
  let i = 0;
  return {
    async httpGet() {
      const r = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return r;
    },
    async run(): Promise<CommandResult> {
      return { code: 1, stdout: "", stderr: "" };
    },
  };
}

const httpProbe = (poll: ReadinessProbe["poll"]): ReadinessProbe =>
  parseProbe({ kind: "http", target: "https://x/health", poll });

test("safeBind: strips reserved keys (ready/detail) so a bind can only ADD outputs, never shadow the payload", () => {
  const cleaned = safeBind({ resolvedArtifact: "@nanobpm/urban@0.54.0", ready: "false", detail: "spoofed" });
  assertEquals(cleaned.resolvedArtifact, "@nanobpm/urban@0.54.0");
  assertEquals("ready" in cleaned, false, "a bound 'ready' can never override the canonical payload");
  assertEquals("detail" in cleaned, false, "a bound 'detail' can never override the canonical payload");
  assertEquals(Object.keys(safeBind(undefined)).length, 0, "an absent bind yields an empty object");
});

test("pollUntilReady: a fallback that throws is caught, logged by class name (no leak), and stays not-ready", async () => {
  const clock = fakeClock();
  const seen: string[] = [];
  let publishes = 0;
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 5, timeoutMs: 30, backoff: "fixed" }),
    gateKey: "gate-fallback-throws",
    exec: execReturning([{ status: 503, body: "" }]),
    env: {},
    now: clock.now,
    wait: clock.wait,
    publish: async () => {
      publishes += 1;
    },
    fallback: async () => {
      throw new Error("boom at https://h/p?token=s3cr3t");
    },
    log: (msg) => seen.push(msg),
  });
  assert(!res.ready, "a throwing fallback keeps the not-ready outcome for the engine timer");
  assertEquals(publishes, 0, "nothing is published when the fallback throws");
  const all = seen.join("\n");
  assert(all.includes("fallback error: Error"), "the fallback error is logged by class name");
  assert(!all.includes("s3cr3t"), "the raw error message (with its secret) must not leak");
});

test("pollUntilReady: publishes readiness-ready once and returns ready when a probe goes green", async () => {
  const clock = fakeClock();
  const published: Array<{ detail: string }> = [];
  const exec = execReturning([{ status: 503, body: "" }, { status: 200, body: "ok" }]);
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 10, timeoutMs: 10_000, backoff: "fixed" }),
    gateKey: "gate-1",
    exec,
    env: {},
    now: clock.now,
    wait: clock.wait,
    publish: async (detail) => {
      published.push({ detail });
    },
  });
  assert(res.ready, "the probe eventually reported ready");
  assertEquals(published.length, 1, "exactly one readiness message was published");
});

test("pollUntilReady: forwards a matcher's bind through publish into the message variables (#274 Gap B)", async () => {
  // A capability probe resolves a version; its bind must flow through publish so the gate can surface
  // resolvedArtifact as an output. The gh-api stub returns a release whose provenance carries #274.
  const clock = fakeClock();
  const published: Array<{ detail: string; bind?: Record<string, string> }> = [];
  const payload = JSON.stringify([{ tag_name: "@nanobpm/urban@0.54.0", body: "## Provenance\n- #274\n" }]);
  const exec: ProbeExec = {
    async httpGet() {
      return { status: 0, body: "" };
    },
    async run(): Promise<CommandResult> {
      return { code: 0, stdout: payload, stderr: "" };
    },
  };
  const res = await pollUntilReady({
    probe: parseProbe({
      kind: "capability",
      target: "github-releases:nanobpm/nano-ide",
      match: { capabilityRef: "nano-ide#274", package: "@nanobpm/urban" },
      poll: { everyMs: 5, timeoutMs: 5000, backoff: "fixed" },
    }),
    gateKey: "gate-cap",
    exec,
    env: {},
    now: clock.now,
    wait: clock.wait,
    publish: async (detail, bind) => {
      published.push({ detail, bind });
    },
  });
  assert(res.ready, "the capability edge resolved");
  assertEquals(published.length, 1, "exactly one readiness message was published");
  assertEquals(published[0]?.bind?.resolvedArtifact, "@nanobpm/urban@0.54.0", "the resolved artifact flowed through the bind");
});

test("pollUntilReady: the gated fallback fires ONCE at budget exhaustion and can still resolve+publish", async () => {
  // Deterministic provenance never resolves (no matching release), so the loop exhausts its budget —
  // the gate boundary. The fallback thunk then verifies empirically and publishes a bound version.
  const clock = fakeClock();
  const published: Array<{ bind?: Record<string, string> }> = [];
  let fallbackCalls = 0;
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 5, timeoutMs: 30, backoff: "fixed" }),
    gateKey: "gate-fallback",
    exec: execReturning([{ status: 503, body: "" }]),
    env: {},
    now: clock.now,
    wait: clock.wait,
    publish: async (_detail, bind) => {
      published.push({ bind });
    },
    fallback: async () => {
      fallbackCalls += 1;
      return { ready: true, detail: "verified empirically", bind: { resolvedArtifact: "@nanobpm/urban@0.60.0" } };
    },
  });
  assert(res.ready, "the boundary fallback resolved the edge");
  assertEquals(fallbackCalls, 1, "the fallback fires exactly once, at the boundary — never per attempt");
  assertEquals(published[0]?.bind?.resolvedArtifact, "@nanobpm/urban@0.60.0");
});

test("pollUntilReady: a fallback that does not resolve leaves the not-ready outcome for the engine timer", async () => {
  const clock = fakeClock();
  let publishes = 0;
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 5, timeoutMs: 30, backoff: "fixed" }),
    gateKey: "gate-fallback-noop",
    exec: execReturning([{ status: 503, body: "" }]),
    env: {},
    now: clock.now,
    wait: clock.wait,
    publish: async () => {
      publishes += 1;
    },
    fallback: async () => ({ ready: false, detail: "still nothing" }),
  });
  assert(!res.ready, "an inconclusive fallback keeps the wait bounded by the engine timer");
  assertEquals(publishes, 0, "no readiness signal is published when the fallback does not resolve");
  assert(
    res.detail.includes("still nothing"),
    "the inconclusive fallback's (redacted) diagnostic is surfaced in the returned detail, not discarded",
  );
});

test("pollUntilReady: a never-green probe exhausts its budget and returns not-ready WITHOUT publishing", async () => {
  const clock = fakeClock();
  let publishes = 0;
  const exec = execReturning([{ status: 503, body: "" }]);
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 5, timeoutMs: 100, backoff: "fixed" }),
    gateKey: "gate-2",
    exec,
    env: {},
    now: clock.now,
    wait: clock.wait,
    publish: async () => {
      publishes += 1;
    },
  });
  assert(!res.ready, "the wait was bounded — the loop gave up instead of hanging");
  assertEquals(publishes, 0, "a not-ready probe never publishes a readiness signal");
  assert(clock.now() <= 100, "the loop stopped at (or before) its declared budget");
});

test("pollUntilReady: an I/O throw is caught and treated as not-ready (never rejects), and its raw message is not leaked", async () => {
  const clock = fakeClock();
  const seen: string[] = [];
  const exec: ProbeExec = {
    async httpGet() {
      throw new Error("connection refused to https://h/p?token=s3cr3t");
    },
    async run(): Promise<CommandResult> {
      return { code: 1, stdout: "", stderr: "" };
    },
  };
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 5, timeoutMs: 30, backoff: "fixed" }),
    gateKey: "gate-3",
    exec,
    env: {},
    now: clock.now,
    wait: clock.wait,
    publish: async () => {},
    log: (msg) => seen.push(msg),
  });
  assert(!res.ready, "a transport failure is a transient not-ready, not a crash");
  const all = [res.detail, ...seen].join("\n");
  assert(!all.includes("s3cr3t"), "the raw error message (with its secret) must not leak");
  assert(!all.includes("connection refused"), "only the error class is surfaced, not the message");
});

test("handler: a blank gateKey fails fast (an empty correlationKey would never release the gate)", async () => {
  const job = { variables: { probe: { kind: "http", target: "https://x/health" }, gateKey: "  " } };
  await assertRejects(
    // biome-ignore lint/suspicious/noExplicitAny: minimal job/app stub for the fail-fast guard.
    () => handler(job as any, {} as any),
    Error,
    "gateKey",
  );
});

test("pollUntilReady: the poll cadence reads NANO_READINESS_POLL_EVERY_MS from the injected env, not ambient process.env", async () => {
  const clock = fakeClock();
  // Descriptor omits everyMs, so the cadence falls back to the env contract. A small injected value
  // (25ms) makes the loop step through its 100ms budget; the ambient default (15_000ms) would blow
  // the budget on the first wait and bail at now()=0. Asserting the clock advanced proves the
  // injected env — not process.env — drove the cadence.
  const exec = execReturning([{ status: 503, body: "" }]);
  const res = await pollUntilReady({
    probe: httpProbe({ timeoutMs: 100, backoff: "fixed" }),
    gateKey: "gate-env",
    exec,
    env: { NANO_READINESS_POLL_EVERY_MS: "25" },
    now: clock.now,
    wait: clock.wait,
    publish: async () => {},
  });
  assert(!res.ready, "the never-green probe exhausted its budget");
  assert(clock.now() > 0, "the injected env's 25ms cadence stepped the clock (ambient default would bail at 0)");
});

test("pollUntilReady: an omitted poll.timeoutMs takes the budget from NANO_READINESS_POLL_TIMEOUT, not the built-in 30m", async () => {
  const clock = fakeClock();
  // Regression for the worker/gate timeout drift: the gate's engine timer derives from
  // NANO_READINESS_POLL_TIMEOUT when the descriptor omits poll.timeoutMs, but the worker used to
  // fall back to the hard-coded 30m default. With a 45m env budget and no descriptor timeout, the
  // never-green probe must keep polling PAST 30m (up to the 45m the gate itself waits) so it can't
  // go silent while the gate is still waiting. everyMs is clamped to MAX_EVERY_MS (5m), so ~9 waits
  // land the clock beyond 30m only if the env budget — not the 30m default — is in force.
  const exec = execReturning([{ status: 503, body: "" }]);
  const THIRTY_MIN = 30 * 60_000;
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 5 * 60_000, backoff: "fixed" }),
    gateKey: "gate-timeout-env",
    exec,
    env: { NANO_READINESS_POLL_TIMEOUT: "PT45M" },
    now: clock.now,
    wait: clock.wait,
    publish: async () => {},
  });
  assert(!res.ready, "the never-green probe exhausted its budget");
  assert(
    clock.now() > THIRTY_MIN,
    `the worker honored the 45m env budget (probed past 30m); stopped at ${clock.now()}ms`,
  );
});

test("pollUntilReady: the seeded probeTimeout binds the worker to the gate per-instance, overriding ambient env", async () => {
  const clock = fakeClock();
  // Regression for the per-instance worker/gate drift: the gate's engine timers fire off the seeded
  // `probeTimeout` process variable, so the worker must adopt THAT value, not recompute from the
  // ambient env. Here the seeded bound (45m) is generous while the ambient env (1m) is stale/smaller.
  // The env-recomputing code would bail after 1m — going silent while the engine still waits 45m —
  // so the never-green probe must instead keep polling PAST 30m to prove the seeded value is in force.
  const exec = execReturning([{ status: 503, body: "" }]);
  const THIRTY_MIN = 30 * 60_000;
  const res = await pollUntilReady({
    probe: httpProbe({ everyMs: 5 * 60_000, backoff: "fixed" }),
    gateKey: "gate-seeded",
    probeTimeout: "PT45M",
    exec,
    env: { NANO_READINESS_POLL_TIMEOUT: "PT1M" },
    now: clock.now,
    wait: clock.wait,
    publish: async () => {},
  });
  assert(!res.ready, "the never-green probe exhausted its (seeded) budget");
  assert(
    clock.now() > THIRTY_MIN,
    `the worker honored the seeded 45m probeTimeout over the 1m env; stopped at ${clock.now()}ms`,
  );
});

test("READINESS_READY_MESSAGE is the name the gate correlates", () => {
  assertEquals(READINESS_READY_MESSAGE, "readiness-ready");
});

test("readGateVars: returns the RAW (untrimmed) gateKey so the publish key matches the gate's =gateKey subscription", () => {
  // The gate's message subscription binds correlationKey="=gateKey" (the untrimmed process variable).
  // If a caller seeds a whitespace-padded gateKey, trimming the publish key would desync it from the
  // subscription — a green probe would then release the wait only via the timeout arm. So the key we
  // publish on must be the raw value, byte-for-byte.
  const { gateKey } = readGateVars({ gateKey: "  gate-x  ", probeTimeout: "PT30M" });
  assertEquals(gateKey, "  gate-x  ", "the raw gateKey is preserved for byte-for-byte correlation");
});

test("readGateVars: a blank/whitespace gateKey fails fast (an empty correlationKey can never release the gate)", () => {
  for (const gateKey of ["", "   "]) {
    let threw = false;
    try {
      readGateVars({ gateKey, probeTimeout: "PT30M" });
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes("gateKey"), "the error names the offending gateKey");
    }
    assert(threw, `a ${JSON.stringify(gateKey)} gateKey must fail fast`);
  }
});

test("readGateVars: a missing/blank probeTimeout fails fast rather than silently falling back to env", () => {
  // probeTimeout drives BOTH the gate's engine timers (=probeTimeout). A missing/non-string value used
  // to fall back to the env-derived twin, breaking the per-instance bound and masking a mis-seeded
  // instance until it escalated. It must now fail fast.
  for (const probeTimeout of [undefined, "", "   ", 42, null]) {
    let threw = false;
    try {
      readGateVars({ gateKey: "gate-1", probeTimeout });
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes("probeTimeout"), "the error names the offending probeTimeout");
    }
    assert(threw, `a ${JSON.stringify(probeTimeout)} probeTimeout must fail fast`);
  }
});

test("readGateVars: passes a valid probeTimeout through raw (the engine timer evaluates the same string)", () => {
  const { probeTimeout } = readGateVars({ gateKey: "gate-1", probeTimeout: "PT45M" });
  assertEquals(probeTimeout, "PT45M", "the seeded probeTimeout string flows through unchanged");
});
