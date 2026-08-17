// Unit coverage for the ReadinessProbe core (app/readiness.ts, issue #258 / ADR 0001 §2).
//
// The gate's engine model is proven end-to-end in e2e/readiness-gate.e2e.ts; these tests pin the
// pure surface: descriptor parse/validation, each kind's matcher, the injectable `probeOnce`
// dispatch (no network / subprocess), backoff, the ms→ISO timeout derivation, and log redaction.
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "#test-assert";
import {
  type CommandResult,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_EVERY_MS,
  DEFAULT_TIMEOUT_MS,
  defaultProbeExec,
  type HttpResponse,
  MAX_EVERY_MS,
  matchCommand,
  matchGithubCheck,
  matchHttp,
  matchNpm,
  msToIsoDuration,
  nextDelay,
  normalizePoll,
  parseProbe,
  parseRepoRef,
  probeOnce,
  type ProbeExec,
  readinessTimeout,
  redactString,
  redactTarget,
} from "./readiness.ts";

// A ProbeExec stub: canned http/command responses, capturing the last command it was asked to run.
function stubExec(opts: { http?: HttpResponse; command?: CommandResult; capture?: { cmd?: string; headers?: Record<string, string> } }): ProbeExec {
  return {
    async httpGet(_url, headers) {
      if (opts.capture) opts.capture.headers = headers;
      return opts.http ?? { status: 0, body: "" };
    },
    async run(command) {
      if (opts.capture) opts.capture.cmd = command;
      return opts.command ?? { code: 0, stdout: "", stderr: "" };
    },
  };
}

// ── parseProbe ──────────────────────────────────────────────────────────────────────────────
test("parseProbe: accepts a minimal http probe and defaults onTimeout to escalate", () => {
  const p = parseProbe({ kind: "http", target: "https://x/health" });
  assertEquals(p.kind, "http");
  assertEquals(p.target, "https://x/health");
  assertEquals(p.onTimeout, "escalate");
});

test("parseProbe: rejects an unknown kind", () => {
  assertThrows(() => parseProbe({ kind: "oci", target: "img:tag" }), Error, "unknown kind");
});

test("parseProbe: rejects a blank target", () => {
  assertThrows(() => parseProbe({ kind: "command", target: "  " }), Error, "'target' is required");
});

test("parseProbe: rejects an invalid onTimeout", () => {
  assertThrows(() => parseProbe({ kind: "http", target: "x", onTimeout: "retry" }), Error, "invalid onTimeout");
});

test("parseProbe: rejects an invalid poll.backoff (a malformed probe must fail loudly, never silently default)", () => {
  assertThrows(
    () => parseProbe({ kind: "http", target: "x", poll: { backoff: "linear" } }),
    Error,
    "invalid backoff",
  );
});

test("parseProbe: rejects an undeclared credentialEnv (a probe must never inline a secret)", () => {
  assertThrows(
    () => parseProbe({ kind: "http", target: "x", credentialEnv: "MY_SECRET" }),
    Error,
    "not a declared env-contract key",
  );
});

test("parseProbe: accepts a declared credentialEnv and parses nested match/poll", () => {
  const p = parseProbe({
    kind: "github-check",
    target: "o/r@abc",
    credentialEnv: "GITHUB_TOKEN",
    match: { conclusion: "success", checkName: "build" },
    poll: { everyMs: 1000, timeoutMs: 60000, backoff: "fixed" },
  });
  assertEquals(p.credentialEnv, "GITHUB_TOKEN");
  assertEquals(p.match?.checkName, "build");
  assertEquals(p.poll?.backoff, "fixed");
});

// ── matchers ────────────────────────────────────────────────────────────────────────────────
test("matchHttp: any 2xx is ready by default; a 503 is not", () => {
  assert(matchHttp(undefined, { status: 204, body: "" }).ready);
  assert(!matchHttp(undefined, { status: 503, body: "" }).ready);
});

test("matchHttp: an explicit status + bodyIncludes are both required", () => {
  const m = { status: 200, bodyIncludes: "OK" };
  assert(matchHttp(m, { status: 200, body: "all OK here" }).ready);
  assert(!matchHttp(m, { status: 200, body: "degraded" }).ready);
  assert(!matchHttp(m, { status: 201, body: "OK" }).ready);
});

test("matchCommand: exit 0 is ready by default; stdoutIncludes narrows it", () => {
  assert(matchCommand(undefined, { code: 0, stdout: "", stderr: "" }).ready);
  assert(!matchCommand(undefined, { code: 1, stdout: "", stderr: "" }).ready);
  assert(matchCommand({ stdoutIncludes: "ready" }, { code: 0, stdout: "svc ready", stderr: "" }).ready);
  assert(!matchCommand({ stdoutIncludes: "ready" }, { code: 0, stdout: "starting", stderr: "" }).ready);
});

test("matchNpm: a printed version means published; a failed view is not-ready", () => {
  assert(matchNpm(undefined, "pkg@1.2.3", { code: 0, stdout: "1.2.3\n", stderr: "" }).ready);
  assert(!matchNpm(undefined, "pkg@1.2.3", { code: 1, stdout: "", stderr: "E404" }).ready);
  assert(!matchNpm(undefined, "pkg@1.2.3", { code: 0, stdout: "", stderr: "" }).ready);
});

test("matchNpm: the version in pkg@version must match the printed version", () => {
  assert(!matchNpm(undefined, "pkg@2.0.0", { code: 0, stdout: "1.9.9", stderr: "" }).ready);
  assert(matchNpm(undefined, "pkg@2.0.0", { code: 0, stdout: "2.0.0", stderr: "" }).ready);
});

test("matchGithubCheck: all runs must be completed+success; a pending run is not-ready", () => {
  const green = { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] };
  const pending = { check_runs: [{ name: "build", status: "in_progress", conclusion: "" }] };
  assert(matchGithubCheck(undefined, green).ready);
  assert(!matchGithubCheck(undefined, pending).ready);
  assert(!matchGithubCheck(undefined, { check_runs: [] }).ready);
});

test("matchGithubCheck: checkName restricts the predicate to that run", () => {
  const payload = {
    check_runs: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "flaky", status: "completed", conclusion: "failure" },
    ],
  };
  assert(matchGithubCheck({ checkName: "build" }, payload).ready);
  assert(!matchGithubCheck({ checkName: "flaky" }, payload).ready);
  assert(!matchGithubCheck({ checkName: "missing" }, payload).ready);
});

// ── probeOnce dispatch (injected exec — no I/O) ───────────────────────────────────────────────
test("probeOnce http: injects a Bearer credential from the declared env-contract, redacting nothing into the target", async () => {
  const cap: { headers?: Record<string, string> } = {};
  const exec = stubExec({ http: { status: 200, body: "ok" }, capture: cap });
  const p = parseProbe({ kind: "http", target: "https://x/health", credentialEnv: "GITHUB_TOKEN" });
  const res = await probeOnce(p, exec, { GITHUB_TOKEN: "tkn" });
  assert(res.ready);
  assertEquals(cap.headers?.authorization, "Bearer tkn");
});

test("probeOnce npm: builds a quoted `npm view … version` command", async () => {
  const cap: { cmd?: string } = {};
  const exec = stubExec({ command: { code: 0, stdout: "1.0.0", stderr: "" }, capture: cap });
  const res = await probeOnce(parseProbe({ kind: "npm", target: "@scope/pkg@1.0.0" }), exec, {});
  assert(res.ready);
  assertStringIncludes(cap.cmd ?? "", "npm view '@scope/pkg@1.0.0' version");
});

test("probeOnce github-check: parses gh api JSON and requires success", async () => {
  const cap: { cmd?: string } = {};
  const exec = stubExec({
    command: { code: 0, stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }), stderr: "" },
    capture: cap,
  });
  const res = await probeOnce(parseProbe({ kind: "github-check", target: "o/r@main" }), exec, {});
  assert(res.ready);
  assertStringIncludes(cap.cmd ?? "", "repos/o/r/commits/main/check-runs");
});

test("probeOnce github-check: a failed gh api call is not-ready (never throws)", async () => {
  const exec = stubExec({ command: { code: 1, stdout: "", stderr: "not found" } });
  const res = await probeOnce(parseProbe({ kind: "github-check", target: "o/r@main" }), exec, {});
  assert(!res.ready);
});

// ── backoff + poll normalisation ──────────────────────────────────────────────────────────────
test("normalizePoll: fills defaults and clamps everyMs to the ceiling", () => {
  const d = normalizePoll(undefined);
  assertEquals(d.everyMs, DEFAULT_EVERY_MS);
  assertEquals(d.timeoutMs, DEFAULT_TIMEOUT_MS);
  assertEquals(d.backoff, "exponential");
  assertEquals(normalizePoll({ everyMs: 10 * 60_000 }).everyMs, MAX_EVERY_MS);
});

test("nextDelay: fixed returns everyMs; exponential doubles and clamps", () => {
  const fixed = normalizePoll({ everyMs: 1000, backoff: "fixed" });
  assertEquals(nextDelay(1, fixed), 1000);
  assertEquals(nextDelay(5, fixed), 1000);
  const exp = normalizePoll({ everyMs: 1000, backoff: "exponential" });
  assertEquals(nextDelay(1, exp), 1000);
  assertEquals(nextDelay(3, exp), 4000);
  assertEquals(nextDelay(30, exp), MAX_EVERY_MS);
});

// ── timeout derivation ────────────────────────────────────────────────────────────────────────
test("msToIsoDuration: rounds up to whole seconds, never zero", () => {
  assertEquals(msToIsoDuration(1000), "PT1S");
  assertEquals(msToIsoDuration(1500), "PT2S");
  assertEquals(msToIsoDuration(1), "PT1S");
});

test("readinessTimeout: derives from poll.timeoutMs, else the env default, else PT30M", () => {
  assertEquals(readinessTimeout(parseProbe({ kind: "http", target: "x", poll: { timeoutMs: 60000 } }), {}), "PT60S");
  assertEquals(readinessTimeout(parseProbe({ kind: "http", target: "x" }), {}), "PT30M");
  assertEquals(
    readinessTimeout(parseProbe({ kind: "http", target: "x" }), { NANO_READINESS_POLL_TIMEOUT: "PT5M" }),
    "PT5M",
  );
});

// ── repo/ref parse + redaction ──────────────────────────────────────────────────────────────
test("parseRepoRef: splits owner/repo@ref and defaults the ref to HEAD", () => {
  assertEquals(parseRepoRef("o/r@abc123"), { repo: "o/r", ref: "abc123" });
  assertEquals(parseRepoRef("o/r"), { repo: "o/r", ref: "HEAD" });
});

test("redactString/redactTarget: strip userinfo and query (a token often rides either)", () => {
  assertEquals(redactString("https://user:pass@host/path?token=abc"), "https://***@host/path?***");
  assertStringIncludes(redactTarget(parseProbe({ kind: "http", target: "https://h/p?tok=s3cr3t" })), "?***");
  const t = redactTarget(parseProbe({ kind: "http", target: "https://h/p?tok=s3cr3t" }));
  assert(!t.includes("s3cr3t"), "the secret must not survive redaction");
});

test("redactTarget: a command target is never logged — only the kind + a fixed placeholder", () => {
  const ct = redactTarget(parseProbe({ kind: "command", target: "curl -H 'Authorization: Bearer s3cr3t' https://h/p" }));
  assertEquals(ct, "command:<redacted>");
  assert(!ct.includes("s3cr3t"), "an arbitrary shell snippet's secrets must never survive to a log line");
});

// ── default ProbeExec: every attempt is bounded (a stuck probe can never hang the worker) ─────
test("defaultProbeExec.run: a command that outlives the attempt timeout resolves bounded, non-zero", async () => {
  const exec = defaultProbeExec(50);
  const start = Date.now();
  const out = await exec.run("sleep 5", process.env);
  const elapsed = Date.now() - start;
  assert(out.code !== 0, "a killed (timed-out) command must report a non-zero exit code, i.e. not ready");
  assert(elapsed < 4000, `the attempt must resolve in bounded time, not run to completion (took ${elapsed}ms)`);
});

test("defaultProbeExec.httpGet: a hung endpoint aborts at the attempt timeout instead of hanging forever", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    /* never responds — the request hangs until the client aborts */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const exec = defaultProbeExec(50);
    const start = Date.now();
    await assertRejects(() => exec.httpGet(`http://127.0.0.1:${port}/`, {}));
    assert(Date.now() - start < 4000, "the fetch must abort at the attempt deadline, not hang");
  } finally {
    server.close();
  }
});

test("DEFAULT_ATTEMPT_TIMEOUT_MS is a sane bounded default", () => {
  assert(DEFAULT_ATTEMPT_TIMEOUT_MS > 0 && DEFAULT_ATTEMPT_TIMEOUT_MS <= 5 * 60_000);
});
