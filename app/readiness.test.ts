// Unit coverage for the ReadinessProbe core (app/readiness.ts, issue #258 / ADR 0001 §2).
//
// The gate's engine model is proven end-to-end in e2e/readiness-gate.e2e.ts; these tests pin the
// pure surface: descriptor parse/validation, each kind's matcher, the injectable `probeOnce`
// dispatch (no network / subprocess), backoff, the ms→ISO timeout derivation, and log redaction.
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "#test-assert";
import {
  type CommandResult,
  cmpVersion,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_EVERY_MS,
  DEFAULT_TIMEOUT_MS,
  defaultProbeExec,
  type GithubRelease,
  type HttpResponse,
  makeCapabilityFallback,
  MAX_EVERY_MS,
  matchCapability,
  matchCommand,
  matchGithubCheck,
  matchHttp,
  matchNpm,
  matchPr,
  msToIsoDuration,
  newestPublishedVersion,
  nextDelay,
  normalizePoll,
  parseProbe,
  parsePrTarget,
  summariseCapabilityCandidates,
  parsePrView,
  parseReleases,
  parseReleasesTarget,
  parseRepoRef,
  probeBudgetMs,
  probeOnce,
  type ProbeExec,
  type PrObservation,
  prViewCommand,
  readinessPollEvery,
  readinessTimeout,
  readinessTimeoutMs,
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

test("parseProbe: rejects a credentialEnv on a non-http kind (a subprocess probe never consumes it)", () => {
  assertThrows(
    () => parseProbe({ kind: "github-check", target: "o/r@abc", credentialEnv: "GITHUB_TOKEN" }),
    Error,
    "only supported for the 'http' kind",
  );
});

test("parseProbe: accepts a declared credentialEnv (http) and parses nested match/poll", () => {
  const p = parseProbe({
    kind: "http",
    target: "https://x/health",
    credentialEnv: "GITHUB_TOKEN",
    match: { status: 200, checkName: "build" },
    poll: { everyMs: 1000, timeoutMs: 60000, backoff: "fixed" },
  });
  assertEquals(p.credentialEnv, "GITHUB_TOKEN");
  assertEquals(p.match?.checkName, "build");
  assertEquals(p.poll?.backoff, "fixed");
});

// ── parseProbe: capability kind (#274 — required capabilityRef + package, fail loudly on blank) ──
test("parseProbe: a capability probe with a blank capabilityRef throws (a never-resolvable edge must fail loudly)", () => {
  assertThrows(
    () => parseProbe({ kind: "capability", target: "github-releases:nanobpm/nano-ide", match: { package: "@nanobpm/urban" } }),
    Error,
    "capabilityRef' is required",
  );
});

test("parseProbe: a capability probe with a blank package throws (provenance is per-package scoped)", () => {
  assertThrows(
    () => parseProbe({ kind: "capability", target: "github-releases:nanobpm/nano-ide", match: { capabilityRef: "#274" } }),
    Error,
    "package' is required",
  );
});

test("parseProbe: a capability probe whose capabilityRef carries no numeric id throws (never resolvable)", () => {
  assertThrows(
    () =>
      parseProbe({
        kind: "capability",
        target: "github-releases:nanobpm/nano-ide",
        match: { capabilityRef: "nano-ide#", package: "@nanobpm/urban" },
      }),
    Error,
    "must carry a",
  );
});

test("parseProbe: a valid capability probe round-trips its required match fields", () => {
  const p = parseProbe({
    kind: "capability",
    target: "github-releases:nanobpm/nano-ide",
    match: { capabilityRef: "nano-ide#274", package: "@nanobpm/urban", verifyCommand: "node -e 0" },
  });
  assertEquals(p.kind, "capability");
  assertEquals(p.match?.capabilityRef, "nano-ide#274");
  assertEquals(p.match?.package, "@nanobpm/urban");
  assertEquals(p.match?.verifyCommand, "node -e 0");
  assertEquals(p.onTimeout, "escalate");
});

// ── matchCapability: the deterministic lowest-version-per-package resolver (#274 Gap A) ──────────
const rel = (tag: string, refs: number[]): GithubRelease => ({
  tag,
  body: `Automated release of \`${tag}\`.\n\n## Provenance\n${refs.map((n) => `- #${n}`).join("\n")}\n`,
});
const capMatch = { capabilityRef: "nano-ide#274", package: "@nanobpm/urban" };

test("matchCapability: a capability in exactly one release resolves that version and binds resolvedArtifact", () => {
  const res = matchCapability(capMatch, [rel("@nanobpm/urban@0.54.0", [273, 274, 275])]);
  assert(res.ready);
  assertEquals(res.bind?.resolvedArtifact, "@nanobpm/urban@0.54.0");
});

test("matchCapability: present in multiple releases resolves the LOWEST version (first-carries)", () => {
  const releases = [
    rel("@nanobpm/urban@0.60.0", [274]),
    rel("@nanobpm/urban@0.54.0", [274]),
    rel("@nanobpm/urban@0.9.0", [274]), // 0.9 < 0.54 numerically — cmpVersion, not lexicographic
  ];
  const res = matchCapability(capMatch, releases);
  assert(res.ready);
  assertEquals(res.bind?.resolvedArtifact, "@nanobpm/urban@0.9.0");
});

test("matchCapability: an absent capability is not-ready (still waiting), never throws", () => {
  const res = matchCapability(capMatch, [rel("@nanobpm/urban@0.54.0", [200, 201])]);
  assert(!res.ready);
  assertEquals(res.bind, undefined);
});

test("matchCapability: the same #C in another package resolves ONLY within the named package", () => {
  const releases = [
    rel("@nanobpm/other@1.0.0", [274]), // same #274, wrong package — must be ignored
    rel("@nanobpm/urban@0.55.0", [274]),
  ];
  const res = matchCapability(capMatch, releases);
  assert(res.ready);
  assertEquals(res.bind?.resolvedArtifact, "@nanobpm/urban@0.55.0");
});

test("matchCapability: a prefix ref (#27) never spuriously satisfies #274", () => {
  assert(!matchCapability(capMatch, [rel("@nanobpm/urban@0.54.0", [27])]).ready);
});

test("matchCapability: a malformed/empty releases list is not-ready and never throws", () => {
  assert(!matchCapability(capMatch, []).ready);
  // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed rows exercise the tolerant guard.
  assert(!matchCapability(capMatch, [{ tag: 123, body: null } as any, null as any]).ready);
});

test("matchCapability: the bare '#274' ref form resolves identically to 'nano-ide#274'", () => {
  const res = matchCapability({ capabilityRef: "#274", package: "@nanobpm/urban" }, [rel("@nanobpm/urban@1.2.3", [274])]);
  assert(res.ready);
  assertEquals(res.bind?.resolvedArtifact, "@nanobpm/urban@1.2.3");
});

// ── #514 Defect A: the capability gate is self-diagnosing on escalation ──────────────────────────

test("#514 Defect A summariseCapabilityCandidates: lists candidate releases (newest first) and whether each references the ref", () => {
  const summary = summariseCapabilityCandidates(capMatch, [
    rel("@nanobpm/urban@0.9.0", [200]),
    rel("@nanobpm/urban@0.82.0", [274]),
    rel("@nanobpm/other@1.0.0", [274]), // wrong package — excluded from the per-package summary
  ]);
  assertStringIncludes(summary, "2 @nanobpm/urban release(s) observed");
  assertStringIncludes(summary, "1 referencing #274");
  // Newest candidate first, and the ref-flag per candidate.
  assertStringIncludes(summary, "@nanobpm/urban@0.82.0 refs #274");
  assertStringIncludes(summary, "@nanobpm/urban@0.9.0 no #274");
  assert(!summary.includes("@nanobpm/other"), "a sibling package never leaks into the per-package summary");
});

test("#514 Defect A summariseCapabilityCandidates: no matching releases yields a plain observed note (never throws)", () => {
  assertEquals(summariseCapabilityCandidates(capMatch, []), "no @nanobpm/urban releases observed");
  assertEquals(summariseCapabilityCandidates(capMatch, [rel("@nanobpm/other@1.0.0", [274])]), "no @nanobpm/urban releases observed");
});

test("#514 Defect A summariseCapabilityCandidates: caps the newest 8 candidates so a >100-release repo cannot bloat the form/log", () => {
  const many: GithubRelease[] = [];
  for (let i = 1; i <= 20; i++) many.push(rel(`@nanobpm/urban@0.${i}.0`, [200]));
  const summary = summariseCapabilityCandidates(capMatch, many);
  assertStringIncludes(summary, "20 @nanobpm/urban release(s) observed");
  assertStringIncludes(summary, "(+12 more)");
  assertStringIncludes(summary, "@nanobpm/urban@0.20.0 no #274"); // newest is shown
  assert(!summary.includes("@nanobpm/urban@0.1.0 "), "the oldest is trimmed by the cap");
});

test("#514 Defect A matchCapability surfaces `observed` on the not-ready path — a false-negative is diagnosable, not contextless", () => {
  // Red before the fix: matchCapability returned only {ready, detail} with no observed-release context,
  // so an escalation could not tell a genuine 'not published yet' from a transient false-negative.
  const notReady = matchCapability(capMatch, [rel("@nanobpm/urban@0.82.0", [200])]);
  assert(!notReady.ready);
  assertStringIncludes(notReady.observed ?? "", "@nanobpm/urban@0.82.0 no #274");
});

test("#514 Defect A matchCapability surfaces `observed` on the ready path too (the resolving release shows as referencing the ref)", () => {
  const ready = matchCapability(capMatch, [rel("@nanobpm/urban@0.82.0", [274])]);
  assert(ready.ready);
  assertStringIncludes(ready.observed ?? "", "@nanobpm/urban@0.82.0 refs #274");
});

test("cmpVersion: numeric dotted compare (0.9 < 0.54 < 0.60), matching nano-ide publish.mjs", () => {
  assert(cmpVersion("0.9.0", "0.54.0") < 0);
  assert(cmpVersion("0.54.0", "0.60.0") < 0);
  assertEquals(cmpVersion("1.2", "1.2.0"), 0);
});

test("newestPublishedVersion: picks the highest version of the named package only", () => {
  const releases = [rel("@nanobpm/urban@0.9.0", []), rel("@nanobpm/urban@0.54.0", []), rel("@nanobpm/other@9.9.9", [])];
  assertEquals(newestPublishedVersion("@nanobpm/urban", releases), "0.54.0");
  assertEquals(newestPublishedVersion("@nanobpm/missing", releases), undefined);
});

test("parseReleases: reduces a gh api payload to {tag, body}; non-array input yields []", () => {
  const parsed = parseReleases([{ tag_name: "@nanobpm/urban@0.54.0", body: "## Provenance\n- #274" }, { nope: 1 }]);
  assertEquals(parsed[0]?.tag, "@nanobpm/urban@0.54.0");
  assertEquals(parseReleases("not-an-array").length, 0);
  assertEquals(parseReleases(null).length, 0);
});

test("parseReleases: flattens the --paginate --slurp array-of-pages shape (>100 releases are seen)", () => {
  const slurped = [
    [{ tag_name: "@nanobpm/urban@0.54.0", body: "- #274" }],
    [{ tag_name: "@nanobpm/urban@0.9.0", body: "- #274" }],
  ];
  const tags = parseReleases(slurped).map((r) => r.tag);
  assertEquals(tags.includes("@nanobpm/urban@0.54.0"), true, "first page's release is seen");
  assertEquals(tags.includes("@nanobpm/urban@0.9.0"), true, "a later page's release is seen too");
});

test("parseReleasesTarget: strips the optional github-releases: scheme, else passes owner/repo through", () => {
  assertEquals(parseReleasesTarget("github-releases:nanobpm/nano-ide"), "nanobpm/nano-ide");
  assertEquals(parseReleasesTarget("nanobpm/nano-ide"), "nanobpm/nano-ide");
});

// ── probeOnce capability dispatch + gated fallback (#274 decision 5) ─────────────────────────────
test("probeOnce capability: queries the repo's releases and binds the resolved artifact", async () => {
  const cap: { cmd?: string } = {};
  const payload = JSON.stringify([{ tag_name: "@nanobpm/urban@0.54.0", body: "## Provenance\n- #274\n" }]);
  const exec = stubExec({ command: { code: 0, stdout: payload, stderr: "" }, capture: cap });
  const res = await probeOnce(parseProbe({ kind: "capability", target: "github-releases:nanobpm/nano-ide", match: capMatch }), exec, {});
  assert(res.ready);
  assertEquals(res.bind?.resolvedArtifact, "@nanobpm/urban@0.54.0");
  assertStringIncludes(cap.cmd ?? "", "repos/nanobpm/nano-ide/releases");
});

test("probeOnce capability: a failed gh api call is not-ready (never throws)", async () => {
  const exec = stubExec({ command: { code: 1, stdout: "", stderr: "boom" } });
  const res = await probeOnce(parseProbe({ kind: "capability", target: "nanobpm/nano-ide", match: capMatch }), exec, {});
  assert(!res.ready);
});

test("makeCapabilityFallback: null for a capability probe with no verifyCommand (deterministic-only)", async () => {
  const probe = parseProbe({ kind: "capability", target: "nanobpm/nano-ide", match: capMatch });
  const fb = makeCapabilityFallback(probe, stubExec({}), {});
  assertEquals(await fb(), null);
});

test("makeCapabilityFallback: verifies the NEWEST version empirically and binds it when the verifier passes", async () => {
  const payload = JSON.stringify([
    { tag_name: "@nanobpm/urban@0.54.0", body: "no ref" },
    { tag_name: "@nanobpm/urban@0.60.0", body: "no ref" },
  ]);
  const seen: string[] = [];
  const exec: ProbeExec = {
    async httpGet() {
      return { status: 0, body: "" };
    },
    async run(command, env) {
      seen.push(command);
      if (command.includes("gh api")) return { code: 0, stdout: payload, stderr: "" };
      // the verifier: assert the newest version was handed to it via the env
      return { code: env.RESOLVED_VERSION === "0.60.0" ? 0 : 1, stdout: "", stderr: "" };
    },
  };
  const probe = parseProbe({ kind: "capability", target: "nanobpm/nano-ide", match: { ...capMatch, verifyCommand: "verify.sh" } });
  const res = await makeCapabilityFallback(probe, exec, {})();
  assert(res?.ready);
  assertEquals(res?.bind?.resolvedArtifact, "@nanobpm/urban@0.60.0");
  assert(seen.some((c) => c === "verify.sh"), "the verifier command was run at the boundary");
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

// ── parseProbe: pr kind (ADR 0005 §2 — owner/repo#N target + validated prState) ──────────────────
test("parseProbe: accepts an owner/repo#N pr probe and defaults onTimeout to escalate (timeout → escalate)", () => {
  const p = parseProbe({ kind: "pr", target: "nanobpm/nano-workforce#377" });
  assertEquals(p.kind, "pr");
  assertEquals(p.onTimeout, "escalate");
});

test("parseProbe: a pr probe whose target carries no numeric PR id throws (never resolvable)", () => {
  assertThrows(() => parseProbe({ kind: "pr", target: "nanobpm/nano-workforce" }), Error, "owner/repo#<number>");
});

test("parseProbe: a pr probe with an unknown match.prState throws (mistyped state fails loudly)", () => {
  assertThrows(
    () => parseProbe({ kind: "pr", target: "o/r#1", match: { prState: "landed" } }),
    Error,
    "invalid match.prState",
  );
});

test("parseProbe: a valid pr probe round-trips its prState", () => {
  const p = parseProbe({ kind: "pr", target: "o/r#12", match: { prState: "mergeable" } });
  assertEquals(p.match?.prState, "mergeable");
});

// ── matchPr (pure — operates on an already-fetched PR observation) ────────────────────────────────
function prObs(over: Partial<PrObservation> = {}): PrObservation {
  return {
    merged: false,
    state: "open",
    mergeStateStatus: "UNKNOWN",
    failingChecks: 0,
    failingCheckNames: [],
    totalChecks: 0,
    presentCheckNames: [],
    pendingCheckNames: [],
    checkConclusions: {},
    isDraft: false,
    headRefOid: "abc123",
    mergedSha: null,
    pendingChecks: 0,
    ...over,
  };
}

test("matchPr: prState 'ready' is the draft→ready transition (a non-draft PR is ready)", () => {
  assert(!matchPr({ prState: "ready" }, prObs({ isDraft: true })).ready);
  assert(matchPr({ prState: "ready" }, prObs({ isDraft: false })).ready);
});

test("matchPr: prState 'merged' waits for the merge and binds mergedSha (mirrors resolvedArtifact)", () => {
  assert(!matchPr({ prState: "merged" }, prObs({ merged: false })).ready);
  const res = matchPr({ prState: "merged" }, prObs({ merged: true, state: "merged", mergedSha: "deadbeef" }));
  assert(res.ready);
  assertEquals(res.bind?.mergedSha, "deadbeef");
});

test("matchPr: 'merged' is the default when no prState is declared", () => {
  assert(!matchPr(undefined, prObs({ merged: false })).ready);
  assert(matchPr(undefined, prObs({ merged: true, state: "merged" })).ready);
});

test("matchPr: prState 'mergeable' reuses classifyMergeability (CLEAN is ready, BLOCKED is not)", () => {
  assert(matchPr({ prState: "mergeable" }, prObs({ mergeStateStatus: "CLEAN" })).ready);
  assert(!matchPr({ prState: "mergeable" }, prObs({ mergeStateStatus: "BLOCKED", failingChecks: 1 })).ready);
});

test("matchPr: prState 'checks-green' needs a present, non-failing, non-pending head run", () => {
  assert(matchPr({ prState: "checks-green" }, prObs({ totalChecks: 2, failingChecks: 0 })).ready);
  assert(!matchPr({ prState: "checks-green" }, prObs({ totalChecks: 2, failingChecks: 1 })).ready);
  assert(!matchPr({ prState: "checks-green" }, prObs({ totalChecks: 0, failingChecks: 0 })).ready);
  // A run still queued/in-progress (no failing conclusion yet) must NOT read as green.
  assert(!matchPr({ prState: "checks-green" }, prObs({ totalChecks: 2, failingChecks: 0, pendingChecks: 1 })).ready);
  // token mode (checks unenumerable, totalChecks < 0) stays conservative — never falsely green.
  assert(!matchPr({ prState: "checks-green" }, prObs({ totalChecks: -1, failingChecks: -1 })).ready);
});

test("matchPr: a not-yet-satisfied state is not-ready — the bounded gate keeps waiting → timeout escalates", () => {
  // Every un-reached state resolves to ready:false, which is exactly what the engine timer arm bounds
  // (onTimeout defaults to 'escalate'): a PR that never lands is never falsely resolved.
  assert(!matchPr({ prState: "merged" }, prObs({ merged: false })).ready);
  assert(!matchPr({ prState: "ready" }, prObs({ isDraft: true })).ready);
  assert(!matchPr({ prState: "checks-green" }, prObs({ totalChecks: 1, failingChecks: 1 })).ready);
});

// ── parsePrView + probeOnce pr dispatch (injected exec — no I/O) ─────────────────────────────────
test("parsePrView: reduces a gh pr view payload and collapses the check rollup", () => {
  const obs = parsePrView({
    state: "OPEN",
    mergeStateStatus: "clean",
    isDraft: false,
    headRefOid: "sha1",
    statusCheckRollup: [
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
    ],
  });
  assertEquals(obs.merged, false);
  assertEquals(obs.mergeStateStatus, "CLEAN");
  assertEquals(obs.totalChecks, 2);
  assertEquals(obs.failingCheckNames, ["lint"]);
});

test("parsePrView: an in-flight run is counted as pending (so checks-green stays not-green)", () => {
  const obs = parsePrView({
    state: "OPEN",
    statusCheckRollup: [
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "e2e", status: "IN_PROGRESS" },
    ],
  });
  assertEquals(obs.failingChecks, 0);
  assertEquals(obs.pendingChecks, 1);
  assert(!matchPr({ prState: "checks-green" }, obs).ready);
});

test("parsePrView: a merged PR carries its merge commit oid", () => {
  const obs = parsePrView({ state: "MERGED", mergedAt: "2026-08-20T00:00:00Z", mergeCommit: { oid: "cafe" } });
  assertEquals(obs.merged, true);
  assertEquals(obs.state, "merged");
  assertEquals(obs.mergedSha, "cafe");
});

test("parsePrView: a garbled payload degrades to an all-open, no-checks observation (never throws)", () => {
  const obs = parsePrView(null);
  assertEquals(obs.merged, false);
  assertEquals(obs.totalChecks, 0);
});

test("probeOnce pr: builds a quoted `gh pr view` command and matches merged, binding mergedSha", async () => {
  const cap: { cmd?: string } = {};
  const exec = stubExec({
    command: { code: 0, stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc" } }), stderr: "" },
    capture: cap,
  });
  const res = await probeOnce(parseProbe({ kind: "pr", target: "nanobpm/nano-workforce#377" }), exec, {});
  assert(res.ready);
  assertEquals(res.bind?.mergedSha, "abc");
  assertStringIncludes(cap.cmd ?? "", "gh pr view '377' --repo 'nanobpm/nano-workforce'");
});

test("probeOnce pr: a failed gh pr view call is not-ready (never throws)", async () => {
  const exec = stubExec({ command: { code: 1, stdout: "", stderr: "no pr" } });
  const res = await probeOnce(parseProbe({ kind: "pr", target: "o/r#1" }), exec, {});
  assert(!res.ready);
});

test("parsePrTarget: parses owner/repo#N, rejects @N and a bare repo", () => {
  assertEquals(parsePrTarget("o/r#12"), { repo: "o/r", number: "12" });
  // `@N` is deliberately NOT a PR handle — it's the repo-ref syntax, so it must not parse as a PR.
  assertEquals(parsePrTarget("o/r@34"), null);
  assertEquals(parsePrTarget("o/r"), null);
});

test("prViewCommand: single-quote-escapes its args", () => {
  assertStringIncludes(prViewCommand("o/r", "9"), "gh pr view '9' --repo 'o/r'");
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

test("readinessTimeoutMs: the ms twin of readinessTimeout — same precedence, no drift with the gate timer", () => {
  // Declared budget is taken verbatim in ms (the gate rounds it up to whole seconds for its ISO timer).
  assertEquals(readinessTimeoutMs(parseProbe({ kind: "http", target: "x", poll: { timeoutMs: 60000 } }), {}), 60000);
  // Omitted + no env → the built-in default (30m), matching readinessTimeout's PT30M.
  assertEquals(readinessTimeoutMs(parseProbe({ kind: "http", target: "x" }), {}), 1_800_000);
  // Omitted + env → the env budget in ms. Regression: this used to fall back to the hard-coded 30m,
  // stranding the worker while the gate timer waited the full env budget.
  assertEquals(
    readinessTimeoutMs(parseProbe({ kind: "http", target: "x" }), { NANO_READINESS_POLL_TIMEOUT: "PT2H" }),
    7_200_000,
  );
});


test("readinessPollEvery: derives the engine retry cadence from descriptor/env/default with clamp", () => {
  assertEquals(readinessPollEvery(parseProbe({ kind: "http", target: "x", poll: { everyMs: 1500 } }), {}), "PT2S");
  assertEquals(readinessPollEvery(parseProbe({ kind: "http", target: "x" }), { NANO_READINESS_POLL_EVERY_MS: "2500" }), "PT3S");
  assertEquals(readinessPollEvery(parseProbe({ kind: "http", target: "x", poll: { everyMs: MAX_EVERY_MS + 1 } }), {}), msToIsoDuration(MAX_EVERY_MS));
  assertEquals(readinessPollEvery(parseProbe({ kind: "http", target: "x" }), { NANO_READINESS_POLL_EVERY_MS: "bad" }), msToIsoDuration(DEFAULT_EVERY_MS));
});

test("probeBudgetMs: prefers the seeded probeTimeout (the gate timer's bound), falling back to the env twin", () => {
  const probe = parseProbe({ kind: "http", target: "x" });
  // The seeded probeTimeout wins over the ambient env — binding worker and engine to ONE per-instance
  // value: a stale env can't shorten the worker while the engine timer waits the seeded budget.
  assertEquals(probeBudgetMs("PT45M", probe, { NANO_READINESS_POLL_TIMEOUT: "PT1M" }), 2_700_000);
  // Absent/blank probeTimeout → fall back to the env-derived twin (readinessTimeoutMs).
  assertEquals(probeBudgetMs(undefined, probe, { NANO_READINESS_POLL_TIMEOUT: "PT2H" }), 7_200_000);
  assertEquals(probeBudgetMs("   ", probe, {}), 1_800_000);
  // A malformed seeded value degrades to the built-in default (30m), matching isoDurationToMs.
  assertEquals(probeBudgetMs("nonsense", probe, { NANO_READINESS_POLL_TIMEOUT: "PT1M" }), 1_800_000);
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
