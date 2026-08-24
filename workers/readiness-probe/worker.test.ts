// Unit coverage for the pr.readiness-probe single-shot worker (workers/readiness-probe/worker.ts, #428).
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "#test-assert";
import type { CommandResult, HttpResponse, ProbeExec, ReadinessProbe } from "../../app/readiness.ts";
import { parseProbe } from "../../app/readiness.ts";
import handler, { probeSingleShot, READINESS_READY_MESSAGE, readGateVars, safeBind } from "./worker.ts";

function execReturning(seq: Array<HttpResponse>, counts: { http: number } = { http: 0 }): ProbeExec {
  let i = 0;
  return {
    async httpGet() {
      counts.http += 1;
      const r = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return r;
    },
    async run(): Promise<CommandResult> {
      return { code: 1, stdout: "", stderr: "" };
    },
  };
}

const httpProbe = (poll?: ReadinessProbe["poll"]): ReadinessProbe =>
  parseProbe({ kind: "http", target: "https://x/health?token=s3cr3t", poll });

test("safeBind: strips reserved keys (ready/detail) so a bind can only ADD outputs, never shadow the payload", () => {
  const cleaned = safeBind({ resolvedArtifact: "@nanobpm/urban@0.54.0", ready: "false", detail: "spoofed" });
  assertEquals(cleaned.resolvedArtifact, "@nanobpm/urban@0.54.0");
  assertEquals("ready" in cleaned, false, "a bound 'ready' can never override the canonical payload");
  assertEquals("detail" in cleaned, false, "a bound 'detail' can never override the canonical payload");
  assertEquals(Object.keys(safeBind(undefined)).length, 0, "an absent bind yields an empty object");
});

test("probeSingleShot: publishes readiness-ready once and returns ready when a probe is green", async () => {
  const published: Array<{ detail: string }> = [];
  const counts = { http: 0 };
  const res = await probeSingleShot({
    probe: httpProbe({ everyMs: 1, timeoutMs: 60_000, backoff: "fixed" }),
    exec: execReturning([{ status: 200, body: "ok" }], counts),
    env: {},
    publish: async (detail) => {
      published.push({ detail });
    },
  });
  assert(res.ready, "the probe reported ready");
  assertEquals(counts.http, 1, "a single activation performs exactly one probe I/O");
  assertEquals(published.length, 1, "exactly one readiness message was published");
});

test("probeSingleShot: not-ready and not lastAttempt returns without publishing", async () => {
  let publishes = 0;
  const counts = { http: 0 };
  const res = await probeSingleShot({
    probe: httpProbe({ everyMs: 1, timeoutMs: 60_000, backoff: "fixed" }),
    exec: execReturning([{ status: 503, body: "" }], counts),
    env: {},
    publish: async () => {
      publishes += 1;
    },
  });
  assert(!res.ready, "the probe reported not-ready");
  assertEquals(counts.http, 1, "regression guard: the worker has no wall-clock retry loop");
  assertEquals(publishes, 0, "a not-ready non-final activation never publishes");
});

test("probeSingleShot: lastAttempt fallback fires once, can resolve ready, and publishes bound outputs", async () => {
  const published: Array<{ bind?: Record<string, string> }> = [];
  let fallbackCalls = 0;
  const res = await probeSingleShot({
    probe: httpProbe(),
    exec: execReturning([{ status: 503, body: "" }]),
    env: {},
    lastAttempt: true,
    publish: async (_detail, bind) => {
      published.push({ bind });
    },
    fallback: async () => {
      fallbackCalls += 1;
      return { ready: true, detail: "verified empirically", bind: { resolvedArtifact: "@nanobpm/urban@0.60.0" } };
    },
  });
  assert(res.ready, "the boundary fallback resolved the edge");
  assertEquals(fallbackCalls, 1, "the fallback fires exactly once at the boundary");
  assertEquals(published.length, 1, "the fallback ready result publishes once");
  assertEquals(published[0]?.bind?.resolvedArtifact, "@nanobpm/urban@0.60.0");
});

test("probeSingleShot: lastAttempt fallback throwing is caught by class name and stays not-ready", async () => {
  const seen: string[] = [];
  let publishes = 0;
  const res = await probeSingleShot({
    probe: httpProbe(),
    exec: execReturning([{ status: 503, body: "" }]),
    env: {},
    lastAttempt: true,
    publish: async () => {
      publishes += 1;
    },
    fallback: async () => {
      throw new Error("boom at https://h/p?token=fallback-secret");
    },
    log: (msg) => seen.push(msg),
  });
  assert(!res.ready, "a throwing fallback keeps the not-ready outcome for the engine timer");
  assertEquals(publishes, 0, "nothing is published when the fallback throws");
  const all = [res.detail, ...seen].join("\n");
  assert(all.includes("fallback error: Error"), "the fallback error is logged by class name");
  assert(!all.includes("fallback-secret"), "the raw error message must not leak");
});

test("probeSingleShot: inconclusive lastAttempt fallback surfaces its redacted detail", async () => {
  const res = await probeSingleShot({
    probe: httpProbe(),
    exec: execReturning([{ status: 503, body: "" }]),
    env: {},
    lastAttempt: true,
    publish: async () => {},
    fallback: async () => ({ ready: false, detail: "still nothing" }),
  });
  assert(!res.ready, "an inconclusive fallback keeps not-ready");
  assert(res.detail.includes("fallback: still nothing"), "the fallback diagnostic is preserved");
});

test("#514 Defect A probeSingleShot: a not-ready capability at the boundary emits a structured WARN with the probe detail + observed releases, and threads `observed` to the return", async () => {
  // Red before the fix: the boundary last-attempt returned a contextless "gate boundary reached" with
  // no warn and no observed-release context, so an escalated false-negative was undiagnosable.
  const capProbe = parseProbe({
    kind: "capability",
    target: "github-releases:nanobpm/nano-ide",
    match: { package: "@nanobpm/urban", capabilityRef: "#468" },
  });
  // A live @nanobpm/urban release exists, but its provenance body does NOT (yet) reference #468 — the
  // exact transient false-negative shape from the incident.
  const releasesJson = JSON.stringify([
    [{ tag_name: "@nanobpm/urban@0.82.0", body: "## Provenance\n- #200\n" }],
  ]);
  const exec: ProbeExec = {
    async httpGet(): Promise<HttpResponse> {
      throw new Error("unused");
    },
    async run(): Promise<CommandResult> {
      return { code: 0, stdout: releasesJson, stderr: "" };
    },
  };
  const warns: string[] = [];
  let publishes = 0;
  const res = await probeSingleShot({
    probe: capProbe,
    exec,
    env: {},
    lastAttempt: true,
    publish: async () => {
      publishes += 1;
    },
    warn: (msg) => warns.push(msg),
  });
  assert(!res.ready, "the boundary attempt is still not-ready");
  assertEquals(publishes, 0, "a not-ready boundary never publishes readiness-ready");
  assertEquals(warns.length, 1, "exactly one structured warn is emitted at the boundary last attempt");
  assert(warns[0].includes("escalating"), "the warn says the gate is escalating");
  assert(warns[0].includes("capability #468 not published"), "the warn carries the probe's last detail");
  assert(warns[0].includes("@nanobpm/urban@0.82.0 no #468"), "the warn carries the observed candidate releases");
  assert((res.observed ?? "").includes("@nanobpm/urban@0.82.0 no #468"), "the observed summary is threaded to the return for the escalation task");
  // The return `detail` must carry the probe's actual last matcher detail — NOT a generic "gate boundary
  // reached" string — because the wait-gate seeds `probeDetail` and the escalation context FEEL from it.
  assert(
    res.detail.includes("capability #468 not published"),
    "the boundary return `detail` carries the probe's diagnostic last detail, keeping the escalation diagnostic",
  );
  assert(
    !res.detail.includes("gate boundary reached"),
    "the boundary return no longer clobbers `detail` with a generic contextless string",
  );
});


test("probeSingleShot: forwards a matcher's bind through publish into the message variables (#274 Gap B)", async () => {
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
  const res = await probeSingleShot({
    probe: parseProbe({
      kind: "capability",
      target: "github-releases:nanobpm/nano-ide",
      match: { capabilityRef: "nano-ide#274", package: "@nanobpm/urban" },
    }),
    exec,
    env: {},
    publish: async (detail, bind) => {
      published.push({ detail, bind });
    },
  });
  assert(res.ready, "the capability edge resolved");
  assertEquals(published.length, 1, "exactly one readiness message was published");
  assertEquals(published[0]?.bind?.resolvedArtifact, "@nanobpm/urban@0.54.0", "the resolved artifact flowed through the bind");
});

test("probeSingleShot: I/O throw is caught, raw message not leaked, and no retry loop runs", async () => {
  const seen: string[] = [];
  let calls = 0;
  const exec: ProbeExec = {
    async httpGet() {
      calls += 1;
      throw new Error("connection refused to https://h/p?token=s3cr3t");
    },
    async run(): Promise<CommandResult> {
      return { code: 1, stdout: "", stderr: "" };
    },
  };
  const res = await probeSingleShot({
    probe: httpProbe({ everyMs: 1, timeoutMs: 60_000, backoff: "fixed" }),
    exec,
    env: {},
    publish: async () => {},
    log: (msg) => seen.push(msg),
  });
  assert(!res.ready, "a transport failure is a transient not-ready, not a crash");
  assertEquals(calls, 1, "regression guard: an I/O throw does not enter an internal retry loop");
  const all = [res.detail, ...seen].join("\n");
  assert(!all.includes("s3cr3t"), "the raw error message (with its secret) must not leak");
  assert(!all.includes("connection refused"), "only the error class is surfaced, not the message");
});

test("handler: a blank gateKey fails fast (an empty correlationKey would never release the gate)", async () => {
  const job = { variables: { probe: { kind: "http", target: "https://x/health" }, gateKey: "  ", probeTimeout: "PT30M" } };
  await assertRejects(
    // biome-ignore lint/suspicious/noExplicitAny: minimal job/app stub for the fail-fast guard.
    () => handler(job as any, {} as any),
    Error,
    "gateKey",
  );
});

test("READINESS_READY_MESSAGE is the name the gate correlates", () => {
  assertEquals(READINESS_READY_MESSAGE, "readiness-ready");
});

test("readGateVars: returns the RAW (untrimmed) gateKey so the publish key matches the gate's =gateKey subscription", () => {
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
