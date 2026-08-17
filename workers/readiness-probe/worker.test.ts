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
import handler, { pollUntilReady, READINESS_READY_MESSAGE } from "./worker.ts";

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

test("READINESS_READY_MESSAGE is the name the gate correlates", () => {
  assertEquals(READINESS_READY_MESSAGE, "readiness-ready");
});
