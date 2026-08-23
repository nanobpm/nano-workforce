// Negative-path coverage for the deterministic probe seam (e2e/support/probe-exec.ts).
//
// The wired readiness-gate suites only ever route the hermetic `true`/`false` builtins through the
// seam, so a regression in RECORDING or REJECTING an unexpected command/HTTP call — the seam's whole
// reason to exist — would leave every one of them green while silently swallowing an escape. This
// exercises the escape contract directly: a non-hermetic command or a real HTTP probe must be
// recorded and make `restoreAndAssertHermetic()` fail, and the recorded escape must never leak the
// raw command or a URL's credential material into the teardown assertion (ADR 0004 pinned
// decision 2 — mirrors production `redactTarget`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { __setProbeExecForTest } from "../../workers/readiness-probe/worker.ts";
import { deterministicProbeSeam } from "./probe-exec.ts";

/** Install the seam, then hand back the exact `ProbeExec` it wired into the worker so a test can
 *  route probes through the real installed seam (not a private copy). Uses the documented
 *  set-returns-previous contract of `__setProbeExecForTest` to read the current override, then puts
 *  it straight back so the seam's own restore still returns the DB to the prior exec. */
function installAndCaptureExec(seam: ReturnType<typeof deterministicProbeSeam>) {
  seam.install();
  const installed = __setProbeExecForTest(undefined);
  assert.ok(installed, "install() must have wired a ProbeExec into the worker");
  __setProbeExecForTest(installed);
  return installed;
}

test("hermetic true/false probes leave the seam clean", async () => {
  const seam = deterministicProbeSeam("hermetic");
  const exec = installAndCaptureExec(seam);

  assert.deepEqual(await exec.run("true", {}), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await exec.run("false", {}), { code: 1, stdout: "", stderr: "" });

  // No escape recorded — teardown passes.
  seam.restoreAndAssertHermetic();
});

test("a non-hermetic command escapes, fails teardown, and never leaks the raw command", async () => {
  const seam = deterministicProbeSeam("cmd-escape");
  const exec = installAndCaptureExec(seam);

  const secret = "curl https://user:supersecret@host/health?token=abc123";
  const result = await exec.run(secret, {});
  // The escaping command still resolves to a non-green result so a bounded not-ready scenario holds.
  assert.equal(result.code, 127);

  assert.throws(
    () => seam.restoreAndAssertHermetic(),
    (err: unknown) => {
      const msg = String(err);
      assert.match(msg, /cmd-escape saw unexpected probe I\/O/);
      assert.doesNotMatch(msg, /supersecret/, "the credential must never reach teardown output");
      assert.doesNotMatch(msg, /abc123/, "the token must never reach teardown output");
      return true;
    },
  );
});

test("a real HTTP probe escapes, fails teardown, and redacts the URL's credential material", async () => {
  const seam = deterministicProbeSeam("http-escape");
  const exec = installAndCaptureExec(seam);

  await assert.rejects(
    exec.httpGet("https://user:tok@host/ready?apikey=zzz999", {}),
    /http-escape: unexpected real HTTP probe/,
  );

  assert.throws(
    () => seam.restoreAndAssertHermetic(),
    (err: unknown) => {
      const msg = String(err);
      assert.match(msg, /http-escape saw unexpected probe I\/O/);
      assert.doesNotMatch(msg, /zzz999/, "the query token must never reach teardown output");
      assert.doesNotMatch(msg, /user:tok/, "the userinfo credential must never reach teardown output");
      return true;
    },
  );
});
