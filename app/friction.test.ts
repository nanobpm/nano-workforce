// Unit tests for the friction sweep core (issue #1073): signal extraction per kind from fixture
// transcripts, redaction, the watermark (advance / no advance on failure / idempotent re-run), and
// the filer (new vs existing fingerprint, threshold, no writes when no findings).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AgentHistoryRecord, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import {
  acquireLease,
  buildDigest,
  collectFriction,
  excerptAround,
  extractRunSignals,
  type FrictionConfig,
  type FrictionGithub,
  type FrictionIssue,
  fetchRunHistory,
  fileFindings,
  observedSignalCounts,
  redactStructured,
  HISTORY_PAGE_CAP,
  fingerprintMarker,
  escalationSubjectUrl,
  frictionSummaryMayBeOpen,
  frictionSweeps,
  leaseHolder,
  markFailed,
  parseFindings,
  parseFingerprintMarker,
  readWatermark,
  recordFiled,
  recordSkipped,
  releaseLease,
  redact,
  summaryMarkdown,
} from "./friction.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const CONFIG: FrictionConfig = { repo: "acme/friction", minOccurrences: 2, minRuns: 2, digestMaxChars: 24000, leaseMs: 6 * 60 * 60 * 1000 };

async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-friction-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

let seq = 0;
function rec(role: string, text: string, toolCalls: { toolName: string; arguments: unknown }[] = [], iteration = 0): AgentHistoryRecord {
  seq += 1;
  return {
    historyItemKey: `h${seq}`,
    agentInstanceKey: "A1",
    loopIteration: iteration,
    role,
    content: [{ type: "text", text }],
    toolCalls,
    metrics: { inputTokens: 10, outputTokens: 5 },
    commitStatus: "COMMITTED",
  } as any;
}

// ── Extraction ─────────────────────────────────────────────────────────────────────────────────

test("extractRunSignals classifies each friction kind from a fixture transcript", () => {
  const bash = { toolName: "bash", arguments: { command: "npm test" } };
  const records = [
    rec("ASSISTANT", "running tests", [bash], 0),
    rec("TOOL_RESULT", "Blocked by nano-coder permissions: write redirect to relative path out.txt", [], 0),
    rec("ASSISTANT", "again", [bash], 1),
    rec("TOOL_RESULT", "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'nano-generated/operations.ts'", [], 1),
    rec("ASSISTANT", "again", [bash], 2),
    rec("TOOL_RESULT", "Command timed out after 1800 seconds", [], 2),
    rec("TOOL_RESULT", "fatal: not a git repository", [], 3),
    rec("TOOL_RESULT", "all 42 tests passed", [], 3),
  ];
  const ex = extractRunSignals("A1", "http://x/run/A1", records);
  const kinds = ex.signals.map((s) => s.kind).sort();
  assertEquals(kinds, ["missing_generated", "permission_block", "repeated_command", "timeout", "tool_error"]);
  assertEquals(ex.turns, 4);
  assertEquals(ex.tokens, 8 * 15);
  // A permission block is not double-counted as a generic tool error.
  assertEquals(ex.signals.filter((s) => s.kind === "tool_error").length, 1);
  for (const s of ex.signals) assertEquals(s.runUrl, "http://x/run/A1");
});

test("a clean run yields no signals", () => {
  const ex = extractRunSignals("A2", null, [rec("ASSISTANT", "ok", [{ toolName: "read_file", arguments: { path: "a" } }]), rec("TOOL_RESULT", "contents")]);
  assertEquals(ex.signals.length, 0);
});

// ── Redaction ──────────────────────────────────────────────────────────────────────────────────

test("redact strips tokens, keys, auth headers and usernames in paths", () => {
  const raw = [
    "gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "GITHUB_TOKEN=supersecretvalue123",
    "path /Users/joshua.wulf/workspace/x and /home/alice/y",
  ].join("\n");
  const out = redact(raw);
  assert(!out.includes("ghp_abcdefghijklmnop"), out);
  assert(!out.includes("eyJhbGciOiJIUzI1NiJ9"), out);
  assert(!out.includes("supersecretvalue123"), out);
  assert(!out.includes("joshua.wulf") && !out.includes("alice"), out);
});

test("signal excerpts and the digest are redacted", () => {
  const ex = extractRunSignals("A3", null, [rec("TOOL_RESULT", "fatal: auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789")]);
  assertEquals(ex.signals.length, 1);
  assert(!ex.signals[0]?.excerpt.includes("ghp_abcdefghijklmnop"));
  const digest = buildDigest({ start: "a", end: "b" }, ex.signals, [], 24000);
  assert(!digest.includes("ghp_abcdefghijklmnop"));
});

test("buildDigest stays within its character bound", () => {
  const signals = Array.from({ length: 500 }, (_, i) => ({
    id: `tool_error:R${i}:0`,
    kind: "tool_error" as const,
    runKey: `R${i}`,
    runUrl: null,
    fingerprint: `message ${i % 50}`,
    excerpt: "x".repeat(300),
  }));
  assert(buildDigest({ start: "a", end: "b" }, signals, [], 4000).length <= 4000);
});

// ── Collect: watermark ────────────────────────────────────────────────────────────────────────

function engineStub(opts: { fail?: boolean; runs?: { key: string; at: string; records: AgentHistoryRecord[] }[] } = {}) {
  let reads = 0;
  const engine = {
    searchAgentInstances: async () => {
      reads += 1;
      if (opts.fail) throw new Error("engine down");
      return (opts.runs ?? []).map((r) => ({ agentInstanceKey: r.key, status: "COMPLETED", completionDate: r.at, elementId: "implement-task" }));
    },
    searchAgentInstanceHistory: async (key: string) => (opts.runs ?? []).find((r) => r.key === key)?.records ?? [],
    searchJobs: async () => [],
    searchIncidents: async () => [],
  } as any;
  return { engine, reads: () => reads };
}

test("collect advances the watermark, persists signals, and re-running the same sweep is idempotent", async () => {
  await withData(async (data) => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const { engine, reads } = engineStub({
      runs: [{ key: "R1", at: "2026-01-01T12:00:00.000Z", records: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")] }],
    });
    const first = await collectFriction({ data, engine, sweepKey: "S1", now, config: CONFIG, baseUrl: "http://h" });
    assertEquals(first.status, "collected");
    assertEquals(first.signalCount, 1);
    assertEquals(first.windowStart, "2026-01-01T00:00:00.000Z");
    assertEquals(readWatermark(data), now.toISOString());
    const again = await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-03T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(again.signalCount, 1);
    assertEquals(again.windowEnd, now.toISOString());
    assertEquals(reads(), 1, "a retried collect returns the stored result without re-reading");
    assertEquals(readWatermark(data), now.toISOString());
    assertEquals((await frictionSweeps(data).all()).length, 1);

    // The next sweep starts at the watermark: the already-swept run is outside its window → no-op.
    const next = await collectFriction({ data, engine, sweepKey: "S2", now: new Date("2026-01-02T12:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(next.status, "noop");
    assertEquals(next.windowStart, now.toISOString());
    assertEquals(next.digest, "");
  });
});

test("a failed collect leaves the watermark untouched and persists nothing", async () => {
  await withData(async (data) => {
    const { engine } = engineStub({ fail: true });
    await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" }).then(
      () => assert(false, "expected the collect to throw"),
      () => undefined,
    );
    assertEquals(readWatermark(data), null);
    assertEquals((await frictionSweeps(data).all()).length, 0);
  });
});

// ── File ───────────────────────────────────────────────────────────────────────────────────────

function githubStub(open: FrictionIssue[] = []) {
  const calls: string[] = [];
  const created: { title: string; body: string; labels: string[] }[] = [];
  const github: FrictionGithub = {
    listOpenIssues: async () => {
      calls.push("list");
      return open;
    },
    createIssue: async (_repo, issue) => {
      calls.push("create");
      created.push(issue);
      return { number: 100 + created.length, url: `https://github.com/acme/friction/issues/${100 + created.length}` };
    },
    comment: async (_repo, n) => {
      calls.push(`comment:${n}`);
      return { url: `https://github.com/acme/friction/issues/${n}#c` };
    },
  };
  return { github, calls, created };
}

/** A recount that agrees with whatever the analyst claimed (isolates the non-threshold tests). */
const TRUST = () => ({ occurrences: 1e9, runs: 1e9 });
const WINDOW = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T12:00:00.000Z" };
function finding(over: Record<string, unknown> = {}) {
  return { fingerprint: "redirect-blocked", title: "Redirects blocked", occurrences: 5, runs: 3, fixSurface: "permission-rule", targetRepo: "nanobpm/nano-coder", evidence: "- x", proposedFix: "allow", ...over };
}

test("a new fingerprint above threshold opens an issue carrying its fingerprint marker and label", async () => {
  const { github, created } = githubStub();
  const { findings } = parseFindings([finding()]);
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST }, findings);
  assertEquals(res.created, ["https://github.com/acme/friction/issues/101"]);
  assertEquals(created[0]?.labels, ["friction"]);
  assertEquals(parseFingerprintMarker(created[0]?.body ?? ""), "redirect-blocked");
});

test("an existing open fingerprint gets a recurrence comment, never a second issue", async () => {
  const open = [{ number: 7, url: "https://github.com/acme/friction/issues/7", title: "t", body: fingerprintMarker("redirect-blocked") }];
  const { github, calls } = githubStub(open);
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST }, parseFindings([finding({ occurrences: 1, runs: 1 })]).findings);
  assertEquals(calls, ["list", "comment:7"]);
  assertEquals(res.updated, ["https://github.com/acme/friction/issues/7"]);
  assertEquals(res.created, []);
});

test("a new finding below the occurrence or run threshold is not filed", async () => {
  const { github, calls } = githubStub();
  const res = await fileFindings(
    { github, config: CONFIG, window: WINDOW, observed: TRUST },
    parseFindings([finding({ fingerprint: "a", occurrences: 1 }), finding({ fingerprint: "b", runs: 1 })]).findings,
  );
  assertEquals(calls, ["list"]);
  assertEquals(res.skipped, 2);
});

test("no findings → no GitHub call at all", async () => {
  const { github, calls } = githubStub();
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST }, []);
  assertEquals(calls, []);
  assertEquals(res, { created: [], updated: [], skipped: 0 });
});

test("parseFindings accepts JSON strings and drops malformed entries", () => {
  const { findings, malformed } = parseFindings(JSON.stringify([finding(), { title: "no fingerprint" }, finding({ fixSurface: "vibes" })]));
  assertEquals(findings.length, 1);
  assertEquals(malformed, 2);
  assertEquals(parseFindings(null), { findings: [], malformed: 0 });
});

test("summaryMarkdown links every opened and updated issue", () => {
  const md = summaryMarkdown(
    { window_start: "a", window_end: "b", runs_swept: 3, signal_count: 9 },
    { created: ["https://github.com/acme/friction/issues/1"], updated: ["https://github.com/acme/friction/issues/2"], skipped: 1 },
    "http://h",
  );
  assert(md.includes("(https://github.com/acme/friction/issues/1)"));
  assert(md.includes("(https://github.com/acme/friction/issues/2)"));
});

test("frictionSummaryMayBeOpen bounds the Tasks-inbox scan to recent filed sweeps", () => {
  assert(frictionSummaryMayBeOpen({ status: "filed", updated_at: "2026-01-01T00:00:00.000Z" }, "2026-01-02T00:00:00.000Z"));
  assert(!frictionSummaryMayBeOpen({ status: "filed", updated_at: "2026-01-01T00:00:00.000Z" }, "2026-01-04T00:00:00.000Z"));
  assert(!frictionSummaryMayBeOpen({ status: "noop", updated_at: "2026-01-01T00:00:00.000Z" }, "2026-01-01T01:00:00.000Z"));
  // Delayed filing: window ended 47h before filing; the summary is still in scope an hour after filing.
  assert(frictionSummaryMayBeOpen({ status: "filed", updated_at: "2026-01-02T23:00:00.000Z" }, "2026-01-03T00:00:00.000Z"));
});

// ── Singleton lease ────────────────────────────────────────────────────────────────────────────

function liveEngine(live: Set<string>) {
  return {
    searchProcessInstances: async (f: { processInstanceKeys?: string[] }) =>
      (f.processInstanceKeys ?? []).map((k) => ({ processInstanceKey: k, state: live.has(k) ? "ACTIVE" : "COMPLETED" })),
  } as any;
}

const T0 = new Date("2026-01-01T00:00:00.000Z");
const LEASE = 6 * 60 * 60 * 1000;

test("two overlapping firings: exactly one takes the lease, the other must skip", async () => {
  await withData(async (data) => {
    const engine = liveEngine(new Set(["P1", "P2"]));
    const [a, b] = await Promise.all([acquireLease(data, engine, "P1", T0, LEASE), acquireLease(data, engine, "P2", T0, LEASE)]);
    assertEquals([a.acquired, b.acquired].filter(Boolean).length, 1);
    const loser = a.acquired ? b : a;
    assertEquals(loser.heldBy, a.acquired ? "P1" : "P2");
    await recordSkipped(data, a.acquired ? "P2" : "P1", loser.heldBy, T0);
    const rows = await frictionSweeps(data).all();
    assertEquals(rows.map((r) => r.status), ["skipped"]);
    // Re-entrant for the holder (a retried lease job).
    assert((await acquireLease(data, engine, leaseHolder(data) ?? "", T0, LEASE)).acquired);
  });
});

test("a held-but-expired lease is taken over", async () => {
  await withData(async (data) => {
    const engine = liveEngine(new Set(["P1", "P2"]));
    assert((await acquireLease(data, engine, "P1", T0, LEASE)).acquired);
    assert(!(await acquireLease(data, engine, "P2", new Date(T0.getTime() + LEASE - 1), LEASE)).acquired);
    assert((await acquireLease(data, engine, "P2", new Date(T0.getTime() + LEASE), LEASE)).acquired);
    assertEquals(leaseHolder(data), "P2");
  });
});

test("a lease whose holder is no longer running (crashed / cancelled) is taken over before expiry", async () => {
  await withData(async (data) => {
    assert((await acquireLease(data, liveEngine(new Set(["P1"])), "P1", T0, LEASE)).acquired);
    assert((await acquireLease(data, liveEngine(new Set(["P2"])), "P2", new Date(T0.getTime() + 60_000), LEASE)).acquired);
    assertEquals(leaseHolder(data), "P2");
  });
});

test("only the holder releases the lease; a released lease is free for the next sweep", async () => {
  await withData(async (data) => {
    const engine = liveEngine(new Set(["P1", "P2"]));
    assert((await acquireLease(data, engine, "P1", T0, LEASE)).acquired);
    assertEquals(await releaseLease(data, "P2", T0), false);
    assertEquals(leaseHolder(data), "P1");
    assertEquals(await releaseLease(data, "P1", T0), true);
    assertEquals(leaseHolder(data), null);
    assert((await acquireLease(data, engine, "P2", T0, LEASE)).acquired);
  });
});

test("excerptAround redacts before windowing: a secret cut by the window edge never leaks", () => {
  const tok = `ghp_${"A".repeat(36)}`;
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----";
  for (const secret of [tok, "Authorization: Bearer abcdefghijklmnopqrstuvwx", pem]) {
    const text = `${"x ".repeat(200)}${secret} ${"y ".repeat(5)}Error: boom ${"z ".repeat(200)}`;
    const idx = text.indexOf("Error:");
    for (let r = 5; r < 200; r += 3) {
      const ex = excerptAround(text, idx, r);
      assert(!/AAAAAAAA|abcdefgh|MIIBOg|tPf9Cnz/.test(ex), `leak at radius ${r}: ${ex}`);
    }
  }
});

test("redact masks quoted JSON, single-quoted, escaped and netrc secret forms (#1074 review)", () => {
  const cases = [
    '{"api_key":"opaque-credential"}',
    "PASSWORD='opaque-credential'",
    'TOKEN="opaque\\"-credential"',
    "machine host login me password opaque-credential",
    "{'client_secret': 'opaque-credential'}",
  ];
  for (const c of cases) {
    const out = redact(c);
    assert(!out.includes("opaque"), `leaked: ${c} -> ${out}`);
    assert(out.includes("[REDACTED]"), out);
  }
});

// ── #1074 review: IDLE re-collection, failed-filing error, summary form ─────────────────────────

test("an agent swept while IDLE and completed in a later window is counted once", async () => {
  await withData(async (data) => {
    const records = [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")];
    const run = { agentInstanceKey: "R1", status: "IDLE", lastUpdatedDate: "2026-01-01T12:00:00.000Z", elementId: "implement-task" } as Record<string, unknown>;
    const engine = {
      searchAgentInstances: async () => [run],
      searchAgentInstanceHistory: async () => records,
      searchJobs: async () => [],
      searchIncidents: async () => [],
    } as any;
    const first = await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(first.signalCount, 1);
    run.status = "COMPLETED";
    run.completionDate = "2026-01-02T06:00:00.000Z";
    const second = await collectFriction({ data, engine, sweepKey: "S2", now: new Date("2026-01-02T12:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(second.signalCount, 0, "already-recorded signals are not re-counted");
    assertEquals(second.digest, "");
  });
});

test("markFailed records the error without overwriting the digest", async () => {
  await withData(async (data) => {
    const { engine } = engineStub({ runs: [{ key: "R1", at: "2026-01-01T12:00:00.000Z", records: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")] }] });
    await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const before = (await frictionSweeps(data).get("S1"))?.digest;
    assert(before && before !== "");
    await markFailed(data, "S1", "boom ghp_abcdefghijklmnopqrstuvwxyz0123456789", new Date("2026-01-02T00:01:00.000Z"));
    const row = await frictionSweeps(data).get("S1");
    assertEquals(row?.status, "failed");
    assertEquals(row?.digest, before);
    assert(row?.error?.includes("boom"));
    assert(!row?.error?.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  });
});

test("recordFiled persists one linkable row per opened/updated issue, idempotently", async () => {
  await withData(async (data) => {
    const { engine } = engineStub({ runs: [{ key: "R1", at: "2026-01-01T12:00:00.000Z", records: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")] }] });
    await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const res = { created: ["https://github.com/acme/friction/issues/1"], updated: ["https://github.com/acme/friction/issues/2#c"], skipped: 0 };
    await recordFiled(data, "S1", res as any, "2026-01-02T00:02:00.000Z");
    await recordFiled(data, "S1", res as any, "2026-01-02T00:03:00.000Z");
    const rows = data.source().db.all<{ action: string; issue_url: string }>("SELECT action, issue_url FROM friction_filings WHERE sweep_key = ? ORDER BY action", ["S1"]);
    assertEquals(rows.map((r) => `${r.action} ${r.issue_url}`), [
      "opened https://github.com/acme/friction/issues/1",
      "updated https://github.com/acme/friction/issues/2#c",
    ]);
  });
});

test("the friction-summary form is static: no process-variable expression, links the Friction page", () => {
  const form = JSON.parse(readFileSync(resolve(APP_ROOT, "resources/forms/friction-summary.form"), "utf8"));
  const texts: string[] = form.components.map((c: { text?: string }) => c.text ?? "");
  assert(texts.every((t) => !t.startsWith("=")), "the Tasks engineForm seeds no process variables");
  assert(texts.some((t) => t.includes("](./friction)")));
  const page = JSON.parse(readFileSync(resolve(APP_ROOT, "pages/friction.page.json"), "utf8"));
  assert(JSON.stringify(page).includes('"table":"friction_filings"'));
});

test("structured tool arguments and OBJECT results are redacted before serialisation", () => {
  const quoted = { toolName: "bash", arguments: { command: 'PASSWORD="opaque-credential" npm run check' } };
  const nested = { toolName: "http", arguments: { body: { api_key: "opaque-credential" } } };
  const records = [0, 1, 2].flatMap((i) => [rec("ASSISTANT", "x", [quoted, nested], i)]);
  const objResult = {
    ...rec("TOOL_RESULT", "", [], 3),
    content: [{ type: "object", object: { error: "Error: denied", api_key: "opaque-credential", cmd: 'TOKEN="opaque-credential"' } }],
  } as any;
  const ex = extractRunSignals("A1", null, [...records, objResult]);
  const all = JSON.stringify(ex.signals);
  assert(!all.includes("opaque-credential"), all);
  assertEquals(ex.signals.filter((s) => s.kind === "repeated_command").length, 2);
});

test("TOOL_RESULT tool references never count as repeated commands", () => {
  const ref = { toolName: "bash", arguments: null };
  const records = [0, 1, 2].flatMap((i) => [
    rec("ASSISTANT", "x", [{ toolName: "bash", arguments: { command: `cmd${i}` } }], i),
    rec("TOOL_RESULT", "ok", [ref], i),
  ]);
  assertEquals(extractRunSignals("A1", null, records).signals.filter((s) => s.kind === "repeated_command").length, 0);
});

test("escalationSubjectUrl links the escalation subject", () => {
  assertEquals(escalationSubjectUrl("o/r#12"), "https://github.com/o/r/issues/12");
  assertEquals(escalationSubjectUrl(null), null);
  assertEquals(escalationSubjectUrl("garbage"), null);
});

test("fetchRunHistory reads past an expired history prefix (#1074 review)", async () => {
  // Iterations 0–9 expired; 10–209 retained, one record each. The first page is capped.
  const retained = Array.from({ length: 200 }, (_, k) => rec("ASSISTANT", `r${k}`, [], k + 10));
  const engine = {
    searchAgentInstanceHistory: async (_key: string, f?: { loopIteration?: number }) =>
      f?.loopIteration === undefined ? retained.slice(0, HISTORY_PAGE_CAP) : retained.filter((r) => r.loopIteration === f.loopIteration),
  } as any;
  assertEquals((await fetchRunHistory(engine, "A1")).length, 200);
});

test("an agent-supplied existingIssue with a different fingerprint is never trusted (#1074 review)", async () => {
  const open = [{ number: 9, url: "https://github.com/acme/friction/issues/9", title: "t", body: fingerprintMarker("something-else") }];
  const { github, calls } = githubStub(open);
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST }, parseFindings([finding({ occurrences: 1, runs: 1, existingIssue: 9 })]).findings);
  assertEquals(calls, ["list"]);
  assertEquals(res.updated, []);
  assertEquals(res.skipped, 1);
});

test("extractRunSignals ids are stable across transcript prefix expiry (no ordinal collision)", () => {
  const old = rec("TOOL_RESULT", "fatal: first failure");
  const cmd = { toolName: "bash", arguments: { command: "npm test" } };
  const calls = [1, 2, 3].map(() => rec("ASSISTANT", "run", [cmd]));
  const before = extractRunSignals("A9", null, [old, ...calls]).signals.map((s) => s.id);
  const fresh = rec("TOOL_RESULT", "fatal: second failure", [], 1);
  const after = extractRunSignals("A9", null, [...calls, fresh]).signals;
  const newErr = after.find((s) => s.excerpt.includes("second"));
  assert(newErr !== undefined && !before.includes(newErr.id));
  const rep = (ids: string[]) => ids.filter((i) => i.startsWith("repeated_command:"));
  assertEquals(rep(after.map((s) => s.id)), rep(before));
});

test("redact masks bare-KEY, CREDENTIAL, AUTH and hyphenated header names (#1074 assessment)", () => {
  for (const name of ["ACCESS_KEY", "OPENAI_KEY", "SIGNING_KEY", "DB_CREDENTIAL", "GITHUB_CREDENTIALS", "BASIC_AUTH", "X-Api-Key", "x-api-key", "API-KEY"]) {
    const out = redact(`${name}=s3cr3tvalue123`);
    assert(!out.includes("s3cr3tvalue123"), `${name} leaked: ${out}`);
  }
  assertEquals(redact("author: Bob"), "author: Bob");
  const structured = JSON.stringify(redactStructured({ ACCESS_KEY: "v1", "X-Api-Key": "v2", basic_auth: "v3", author: "Bob" }));
  assert(!/v1|v2|v3/.test(structured), structured);
  assert(structured.includes("Bob"));
});

test("redact masks ASIA, AIza, npm_ and glpat- token prefixes (#1074 assessment)", () => {
  const cases = [
    `ASIA${"A".repeat(16)}`,
    `AIza${"b".repeat(35)}`,
    `npm_${"c".repeat(36)}`,
    `glpat-${"d".repeat(20)}`,
  ];
  for (const tok of cases) {
    const out = redact(`creds ${tok} here`);
    assert(!out.includes(tok), `${tok} leaked: ${out}`);
  }
});

test("an inflated analyst count does not file: thresholds use the host recount (#1074 assessment)", async () => {
  const { github, calls } = githubStub();
  const cited: string[][] = [];
  const res = await fileFindings(
    { github, config: CONFIG, window: WINDOW, observed: (fps) => (cited.push([...fps]), { occurrences: 1, runs: 1 }) },
    parseFindings([finding({ occurrences: 50, runs: 20, signalFingerprints: ["fp-a"] })]).findings,
  );
  assertEquals(cited, [["fp-a"]]);
  assertEquals(calls, ["list"]);
  assertEquals(res.skipped, 1);
});

test("observedSignalCounts recounts persisted signals by sweep and distinct run_key", async () => {
  await withData(async (data) => {
  const db = data.source().db;
  const ins = (id: string, sweep: string, run: string, fp: string) =>
    db.run(
      "INSERT INTO friction_signals (id, sweep_key, kind, run_key, run_url, fingerprint, excerpt, created_at) VALUES (?, ?, 'escalation', ?, NULL, ?, '', '2026-01-01')",
      [id, sweep, run, fp],
    );
  ins("1", "s1", "r1", "fp");
  ins("2", "s1", "r1", "fp");
  ins("3", "s1", "r2", "fp");
  ins("4", "s2", "r3", "fp");
  ins("5", "s1", "r4", "other");
  assertEquals(observedSignalCounts(data, "s1", ["fp"]), { occurrences: 3, runs: 2 });
  assertEquals(observedSignalCounts(data, "s1", []), { occurrences: 0, runs: 0 });
  });
});

test("N escalations of one PR count as ONE run (keyed by subject, #1074 assessment)", async () => {
  await withData(async (data) => {
    const db = data.source().db;
    db.run("PRAGMA foreign_keys = OFF");
    for (let i = 0; i < 3; i++) {
      db.run("INSERT INTO escalations (pr_key, round_no, kind, question, status, asked_at) VALUES ('o/r#9', ?, 'question', 'Same blocker', 'open', '2026-01-01T06:00:00.000Z')", [i]);
    }
    const { engine } = engineStub({ runs: [] });
    await collectFriction({ data, engine, sweepKey: "SE", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const rows = db.all<{ run_key: string }>("SELECT run_key FROM friction_signals WHERE sweep_key = 'SE' AND kind = 'escalation'");
    assertEquals(rows.length, 3);
    assertEquals(new Set(rows.map((r) => r.run_key)).size, 1);
  });
});
