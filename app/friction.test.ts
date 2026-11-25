import { createHash } from "node:crypto";
// Unit tests for the friction sweep core (issue #1073): signal extraction per kind from fixture
// transcripts, redaction, the watermark (advance / no advance on failure / idempotent re-run), and
// the filer (new vs existing fingerprint, threshold, no writes when no findings).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "#test-assert";
import type { AgentHistoryRecord, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { CAPTURE_FRICTION_JOB_TYPE, compileDeliveryGraphSemantic } from "./deliveryGraphCompiler.ts";
import { prepareDeliveryGraph, runDeliveryGraph } from "./deliveryRunner.ts";
import { renderFrictionNotes } from "./frictionNotes.ts";
import {
  acquireLease,
  buildDigest,
  captureFrictionFromJob,
  collectFriction,
  excerptAround,
  extractRunSignals,
  type FrictionConfig,
  type FrictionGithub,
  type FrictionIssue,
  fetchRunHistory,
  fileFindings,
  LeaseLostError,
  leaseHeldBy,
  signalRunUrls,
  observedSignalCounts,
  redactStructured,
  HISTORY_PAGE_SIZE,
  historyBudget,
  fingerprintMarker,
  escalationSubjectUrl,
  frictionSummaryMayBeOpen,
  frictionSweeps,
  leaseHolder,
  markFailed,
  parseFindings,
  parseFrictionNotes,
  parseFingerprintMarker,
  readWatermark,
  recordFiled,
  recordSkipped,
  releaseLease,
  redact,
  normaliseMessage,
  SWEEP_OVERLAP_MS,
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
    searchAgentInstanceHistoryPage: async (key: string) => ({ items: (opts.runs ?? []).find((r) => r.key === key)?.records ?? [], page: {} }),
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

test("a byte-capped sweep does not advance the watermark past an unread run (#1095 review)", async () => {
  await withData(async (data) => {
    const big = (k: number) => rec("ASSISTANT", "y".repeat(4000), [], k);
    const blocked = (who: string) => rec("TOOL_RESULT", `Blocked by nano-coder permissions: ${who}`, [], 99);
    const { engine } = engineStub({
      runs: [
        // Listed out of instant order on purpose: the sweep must read oldest-first.
        { key: "R2", at: "2026-01-01T18:00:00.000Z", records: [blocked("r2"), big(1), big(2)] },
        { key: "R1", at: "2026-01-01T12:00:00.000Z", records: [blocked("r1"), big(1), big(2)] },
      ],
    });
    const cap = 9_000; // fits R1's history, exhausts inside R2's
    const first = await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h", historyByteCap: cap });
    assert(Date.parse(first.windowEnd) < Date.parse("2026-01-01T18:00:00.000Z"), `watermark skipped the unread run: ${first.windowEnd}`);
    assertEquals(readWatermark(data), first.windowEnd);
    const second = await collectFriction({ data, engine, sweepKey: "S2", now: new Date("2026-01-02T00:01:00.000Z"), config: CONFIG, baseUrl: "http://h", historyByteCap: cap * 2 });
    const ids = (await data.source().db.all<{ run_key: string }>("SELECT run_key FROM friction_signals")).map((r) => r.run_key);
    assert(ids.some((k) => k.includes("R2")), `the capped run was never collected: ${JSON.stringify(ids)} ${JSON.stringify(second)}`);
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

function githubStub(open: FrictionIssue[] = [], pages?: FrictionIssue[][]) {
  const calls: string[] = [];
  const allPages = pages ?? [open];
  const created: { title: string; body: string; labels: string[] }[] = [];
  const github: FrictionGithub = {
    listOpenIssues: async () => {
      calls.push("list");
      return open;
    },
    listIssuesPage: async (_repo, _label, page) => {
      calls.push("list");
      return { issues: allPages[page - 1] ?? [], more: page < allPages.length };
    },
    reopen: async (_repo, n) => {
      calls.push(`reopen:${n}`);
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
const HELD = () => true;
const NOLINKS = (): string[] => [];
const WINDOW = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T12:00:00.000Z" };
function finding(over: Record<string, unknown> = {}) {
  return { fingerprint: "redirect-blocked", title: "Redirects blocked", occurrences: 5, runs: 3, fixSurface: "permission-rule", targetRepo: "nanobpm/nano-coder", evidence: "- x", proposedFix: "allow", ...over };
}

test("a new fingerprint above threshold opens an issue carrying its fingerprint marker and label", async () => {
  const { github, created } = githubStub();
  const { findings } = parseFindings([finding()]);
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, findings);
  assertEquals(res.created, ["https://github.com/acme/friction/issues/101"]);
  assertEquals(created[0]?.labels, ["friction"]);
  assertEquals(parseFingerprintMarker(created[0]?.body ?? ""), "redirect-blocked");
});

test("an existing open fingerprint gets a recurrence comment, never a second issue", async () => {
  const open = [{ number: 7, url: "https://github.com/acme/friction/issues/7", title: "t", body: fingerprintMarker("redirect-blocked") }];
  const { github, calls } = githubStub(open);
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, parseFindings([finding({ occurrences: 1, runs: 1 })]).findings);
  assertEquals(calls, ["list", "comment:7"]);
  assertEquals(res.updated, ["https://github.com/acme/friction/issues/7"]);
  assertEquals(res.created, []);
});

test("a new finding below the occurrence or run threshold is not filed", async () => {
  const { github, calls } = githubStub();
  const res = await fileFindings(
    { github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS },
    parseFindings([finding({ fingerprint: "a", occurrences: 1 }), finding({ fingerprint: "b", runs: 1 })]).findings,
  );
  assertEquals(calls, ["list"]);
  assertEquals(res.skipped, 2);
});

test("no findings → no GitHub call at all", async () => {
  const { github, calls } = githubStub();
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, []);
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
      searchAgentInstanceHistoryPage: async () => ({ items: records, page: {} }),
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

test("a swept active run that gains new history is re-read, its new signal collected (#1098 review)", async () => {
  await withData(async (data) => {
    const records = [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x", [], 1)];
    const run = { agentInstanceKey: "R1", status: "IDLE", lastUpdatedDate: "2026-01-01T12:00:00.000Z", elementId: "implement-task" } as Record<string, unknown>;
    const engine = {
      searchAgentInstances: async () => [run],
      searchAgentInstanceHistoryPage: async () => ({ items: records, page: {} }),
      searchJobs: async () => [],
      searchIncidents: async () => [],
    } as any;
    const first = await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(first.signalCount, 1);
    records.push(rec("TOOL_RESULT", "Blocked by nano-coder permissions: y", [], 2));
    run.status = "COMPLETED";
    run.lastUpdatedDate = "2026-01-02T06:00:00.000Z";
    run.completionDate = "2026-01-02T06:00:00.000Z";
    const second = await collectFriction({ data, engine, sweepKey: "S2", now: new Date("2026-01-02T06:30:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(second.signalCount, 1, "the new signal is collected; the old one is not re-counted");
    const [row] = await data.source().db.all<{ run_instant: string }>("SELECT run_instant FROM friction_swept_runs WHERE run_key = ?", ["R1"]);
    assertEquals(row?.run_instant, "2026-01-02T06:00:00.000Z", "the ledger is refreshed to the re-read instant");
    const third = await collectFriction({ data, engine, sweepKey: "S3", now: new Date("2026-01-02T06:35:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(third.signalCount, 0);
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

function pagedEngine(records: AgentHistoryRecord[], calls: { filter?: unknown; page?: { limit?: number; after?: string } }[] = []) {
  return {
    searchAgentInstanceHistoryPage: async (_key: string, q: { filter?: { commitStatus?: { $in?: string[] } }; page?: { limit?: number; after?: string } }) => {
      calls.push(q);
      const wanted = q.filter?.commitStatus?.$in ?? ["COMMITTED"];
      const matching = records.filter((r) => wanted.includes(r.commitStatus));
      const from = q.page?.after ? Number(q.page.after) : 0;
      const limit = q.page?.limit ?? 100;
      const items = matching.slice(from, from + limit);
      return { items, page: { totalItems: matching.length, endCursor: items.length ? String(from + items.length) : undefined } };
    },
  } as any;
}

for (const status of ["PENDING", "DISCARDED", "COMMITTED"]) {
  test(`fetchRunHistory reads ${status} history records (#1095)`, async () => {
    const r = { ...rec("TOOL_RESULT", "Blocked by nano-coder permissions: x"), commitStatus: status };
    const got = await fetchRunHistory(pagedEngine([r]), "A1");
    assertEquals(got.length, 1);
    assertEquals(got[0].commitStatus, status);
    const sig = extractRunSignals("A1", null, got).signals;
    assertEquals(sig.length, 1);
  });
}

test("fetchRunHistory pages across a page boundary until exhausted (#1095)", async () => {
  const statuses = ["PENDING", "DISCARDED", "COMMITTED"];
  const records = Array.from({ length: HISTORY_PAGE_SIZE * 2 + 7 }, (_, k) => ({ ...rec("ASSISTANT", `r${k}`, [], k), commitStatus: statuses[k % 3] }));
  const calls: { page?: { limit?: number; after?: string } }[] = [];
  const got = await fetchRunHistory(pagedEngine(records, calls), "A1");
  assertEquals(got.length, records.length);
  assertEquals(new Set(got.map((r) => r.historyItemKey)).size, records.length);
  assertEquals(calls.length, 4, "paging stops on cursor exhaustion, not on a short page");
  assertEquals(calls[1].page?.after, String(HISTORY_PAGE_SIZE));
});

test("fetchRunHistory stops at the per-sweep byte cap (#1095)", async () => {
  const records = Array.from({ length: 50 }, (_, k) => rec("ASSISTANT", "y".repeat(1000), [], k));
  const budget = historyBudget(10_000);
  const got = await fetchRunHistory(pagedEngine(records), "A1", budget);
  assert(got.length > 0 && got.length < 10);
  assert(budget.exhausted);
  assertEquals((await fetchRunHistory(pagedEngine(records), "A2", budget)).length, 0, "the cap spans the whole sweep");
});

test("an agent-supplied existingIssue with a different fingerprint is never trusted (#1074 review)", async () => {
  const open = [{ number: 9, url: "https://github.com/acme/friction/issues/9", title: "t", body: fingerprintMarker("something-else") }];
  const { github, calls } = githubStub(open);
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, parseFindings([finding({ occurrences: 1, runs: 1, existingIssue: 9 })]).findings);
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
    { github, config: CONFIG, window: WINDOW, observed: (fps) => (cited.push([...fps]), { occurrences: 1, runs: 1 }), leaseHeld: HELD, evidenceLinks: NOLINKS },
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

// ── #1074 review round: overlap, command identity, links, stable fingerprints, canonical runs ────

test("a completion first visible in the NEXT sweep (inside the overlap) is still collected, once", async () => {
  await withData(async (data) => {
    const runs: { key: string; at: string; records: AgentHistoryRecord[] }[] = [];
    const { engine } = engineStub({ runs });
    const w1 = new Date("2026-01-02T00:00:00.000Z");
    await collectFriction({ data, engine, sweepKey: "S1", now: w1, config: CONFIG, baseUrl: "http://h" });
    // Completed just before the S1 watermark, but only became visible after S1 committed.
    runs.push({ key: "LATE", at: new Date(w1.getTime() - SWEEP_OVERLAP_MS / 2).toISOString(), records: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")] });
    const s2 = await collectFriction({ data, engine, sweepKey: "S2", now: new Date("2026-01-02T06:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(s2.signalCount, 1);
    const s3 = await collectFriction({ data, engine, sweepKey: "S3", now: new Date("2026-01-02T06:10:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(s3.signalCount, 0, "the overlap re-read never double-counts");
    assertEquals(s3.runsSwept, 0);
  });
});

test("different repeated commands never share a fingerprint", () => {
  const calls = (cmd: string) => [0, 1, 2].map(() => rec("ASSISTANT", "", [{ toolName: "bash", arguments: { command: cmd } }]));
  const a = extractRunSignals("R", null, calls("npm test")).signals;
  const b = extractRunSignals("R", null, calls("curl --fail https://example.invalid/artifact")).signals;
  const a2 = extractRunSignals("R2", null, calls("npm test")).signals;
  assertEquals(a.length, 1);
  assert(a[0]?.fingerprint !== b[0]?.fingerprint, "distinct commands merged");
  assertEquals(a[0]?.fingerprint, a2[0]?.fingerprint, "the same command groups across runs");
});

test("run links are browser-facing cockpit links, never the protected history JSON", async () => {
  await withData(async (data) => {
    const engine = {
      searchAgentInstances: async () => [{ agentInstanceKey: "A9", processInstanceKey: "P9", status: "COMPLETED", completionDate: "2026-01-01T12:00:00.000Z", elementId: "x" }],
      searchAgentInstanceHistoryPage: async () => ({ items: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")], page: {} }),
      searchJobs: async () => [],
      searchIncidents: async () => [],
    } as any;
    await collectFriction({ data, engine, sweepKey: "SL", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const row = data.source().db.all<{ run_url: string }>("SELECT run_url FROM friction_signals WHERE sweep_key = 'SL'")[0];
    assertEquals(row?.run_url, "http://h/app/pages/cockpit#/cockpit/P9");
  });
});

test("failed-job and incident signals carry cockpit run links for their process instance", async () => {
  await withData(async (data) => {
    const engine = {
      searchAgentInstances: async () => [],
      searchAgentInstanceHistoryPage: async () => ({ items: [], page: {} }),
      searchJobs: async ({ state }: { state: string }) => (state === "FAILED" ? [{ jobKey: "J7", type: "t", processInstanceKey: "P7", retries: 0 }] : []),
      searchIncidents: async () => [{ incidentKey: "I7", processInstanceKey: "P8", errorType: "E", errorMessage: "m" }],
    } as any;
    await collectFriction({ data, engine, sweepKey: "SJ", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const rows = data.source().db.all<{ kind: string; run_url: string }>("SELECT kind, run_url FROM friction_signals WHERE sweep_key = 'SJ' ORDER BY kind");
    assertEquals(rows.map((r) => [r.kind, r.run_url]), [
      ["failed_job", "http://h/app/pages/cockpit#/cockpit/P7"],
      ["incident", "http://h/app/pages/cockpit#/cockpit/P8"],
    ]);
  });
});

test("a fingerprint survives the digest's redaction pass and recounts (digest-to-recount)", async () => {
  for (const msg of ["error: api_key=sekrit123 rejected", "Authorization: Bearer abcdefghijklmnopqrstu failed", "password hunter2 bad"]) {
    const fp = normaliseMessage(msg);
    assertEquals(redact(fp), fp, `unstable: ${fp}`);
    const digest = buildDigest({ start: "a", end: "b" }, [{ id: "1", kind: "tool_error", runKey: "r", runUrl: null, fingerprint: fp, excerpt: "e" }], [], 24000);
    assert(digest.includes(`\`${fp}\``), `digest rewrote ${fp}`);
  }
  await withData(async (data) => {
    const fp = normaliseMessage("error: api_key=sekrit123 rejected");
    data.source().db.run("INSERT INTO friction_signals (id, sweep_key, kind, run_key, run_url, fingerprint, excerpt, created_at) VALUES ('x', 's', 'tool_error', 'r', NULL, ?, '', 't')", [fp]);
    assertEquals(observedSignalCounts(data, "s", [redact(fp)]).occurrences, 1);
  });
});

test("a tool error, failed job and incident of ONE process instance count as one run", async () => {
  await withData(async (data) => {
    const engine = {
      searchAgentInstances: async () => [{ agentInstanceKey: "A1", processInstanceKey: "P1", status: "COMPLETED", completionDate: "2026-01-01T12:00:00.000Z", elementId: "x" }],
      searchAgentInstanceHistoryPage: async () => ({ items: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")], page: {} }),
      searchJobs: async ({ state }: { state: string }) => (state === "FAILED" ? [{ jobKey: "J1", type: "t", processInstanceKey: "P1", retries: 0 }] : []),
      searchIncidents: async () => [{ incidentKey: "I1", processInstanceKey: "P1", errorType: "E", errorMessage: "m" }],
    } as any;
    await collectFriction({ data, engine, sweepKey: "SC", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const rows = data.source().db.all<{ run_key: string }>("SELECT run_key FROM friction_signals WHERE sweep_key = 'SC'");
    assertEquals(rows.length, 3);
    assertEquals(new Set(rows.map((r) => r.run_key)).size, 1);
  });
});

test("a recurrence is recounted and clamped; an unsupported one is skipped", async () => {
  const open = [{ number: 7, url: "https://github.com/acme/friction/issues/7", title: "t", body: fingerprintMarker("redirect-blocked") }];
  const clamped = githubStub(open);
  const comments: string[] = [];
  const gh = { ...clamped.github, comment: async (r: string, n: number, body: string) => (comments.push(body), clamped.github.comment(r, n, body)) };
  await fileFindings({ github: gh, config: CONFIG, window: WINDOW, observed: () => ({ occurrences: 1, runs: 1 }), leaseHeld: HELD, evidenceLinks: NOLINKS }, parseFindings([finding({ occurrences: 50, runs: 20 })]).findings);
  assert(comments[0]?.includes("1 occurrence(s) across 1 run(s)"), comments[0] ?? "");
  const none = githubStub(open);
  const res = await fileFindings({ github: none.github, config: CONFIG, window: WINDOW, observed: () => ({ occurrences: 0, runs: 0 }), leaseHeld: HELD, evidenceLinks: NOLINKS }, parseFindings([finding()]).findings);
  assertEquals(none.calls, ["list"]);
  assertEquals(res.skipped, 1);
});

test("redact masks CLI secrets passed as separate arguments (#1074 changes requested)", () => {
  const cases: [string, string][] = [
    ["gh auth --token abc123", "gh auth --token [REDACTED]"],
    ["tool --api-key abc123 run", "tool --api-key [REDACTED] run"],
    ["tool --api_key abc123", "tool --api_key [REDACTED]"],
    ["tool --secret abc123", "tool --secret [REDACTED]"],
    ["tool --client-secret 'abc 123'", "tool --client-secret [REDACTED]"],
    ["tool --password-file /etc/pw", "tool --password-file [REDACTED]"],
    ["tool --credential abc123", "tool --credential [REDACTED]"],
    ["curl -u user:pass https://x", "curl -u [REDACTED] https://x"],
    ["curl -s --user user:pass https://x", "curl -s --user [REDACTED] https://x"],
    ["curl -uuser:pass https://x", "curl -u[REDACTED] https://x"],
    ["mysql -u root -p hunter2 db", "mysql -u root -p [REDACTED] db"],
    ["mysqldump -phunter2 db", "mysqldump -p[REDACTED] db"],
    ["psql -h h -p s3cret", "psql -h h -p [REDACTED]"],
  ];
  for (const [raw, want] of cases) assertEquals(redact(raw), want, raw);
  // Negatives: already-redacted, prose, `-p` outside the DB clients, flags with no value.
  assertEquals(redact("tool --token=[REDACTED]"), "tool --token=[REDACTED]");
  assertEquals(redact("tool --token [REDACTED]"), "tool --token [REDACTED]");
  assertEquals(redact("the token was rejected"), "the token was rejected");
  assertEquals(redact("docker run -p 8080:80 img"), "docker run -p 8080:80 img");
  assertEquals(redact("ssh -p 2222 host"), "ssh -p 2222 host");
  assertEquals(redact("tool --token --verbose"), "tool --token --verbose");
  assertEquals(redact("curl -s https://x"), "curl -s https://x");
});

test("filing stops before any GitHub write once the sweep lease is lost (#1074)", async () => {
  const { github, calls } = githubStub();
  await assertRejects(
    () =>
      fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: () => false, evidenceLinks: NOLINKS }, parseFindings([finding()]).findings),
    LeaseLostError,
  );
  assertEquals(calls, ["list"]);
  const open = [{ number: 7, url: "https://github.com/acme/friction/issues/7", title: "t", body: fingerprintMarker("redirect-blocked") }];
  const two = githubStub(open);
  await assertRejects(
    () =>
      fileFindings({ github: two.github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: () => false, evidenceLinks: NOLINKS }, parseFindings([finding()]).findings),
    LeaseLostError,
  );
  assertEquals(two.calls, ["list"]);
});

test("issue bodies and recurrence comments carry host-built, deduped, capped evidence links (#1074)", async () => {
  const links = [...Array.from({ length: 15 }, (_, i) => `https://h/run/${i}`), "https://h/run/0", "javascript:alert(1)"];
  const { github, created } = githubStub();
  await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: () => links }, parseFindings([finding()]).findings);
  const body = created[0]?.body ?? "";
  assertEquals((body.match(/^- https:\/\/h\/run\//gm) ?? []).length, 10);
  assert(!body.includes("javascript:"));
  const open = [{ number: 7, url: "https://github.com/acme/friction/issues/7", title: "t", body: fingerprintMarker("redirect-blocked") }];
  const bodies: string[] = [];
  const two = githubStub(open);
  two.github.comment = async (_r, n, b) => (bodies.push(b), { url: `u${n}` });
  await fileFindings({ github: two.github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: () => ["https://h/run/a"] }, parseFindings([finding()]).findings);
  assert(bodies[0]?.includes("- https://h/run/a"));
});

test("signalRunUrls and leaseHeldBy read the persisted signals and lease", async () => {
  await withData(async (data) => {
    const db = data.source().db;
    for (const [id, url, fp] of [["1", "https://h/r1", "f"], ["2", "https://h/r1", "f"], ["3", "https://h/r2", "f"], ["4", null, "f"], ["5", "https://h/r3", "g"]]) {
      db.run("INSERT INTO friction_signals (id, sweep_key, kind, run_key, run_url, fingerprint, excerpt, created_at) VALUES (?, 'SU', 'tool_error', ?, ?, ?, '', 't')", [id, id, url, fp]);
    }
    assertEquals(signalRunUrls(data, "SU", ["f"]), ["https://h/r1", "https://h/r2"]);
    assertEquals(signalRunUrls(data, "SU", []), []);
    const now = new Date("2026-01-01T00:00:00Z");
    await acquireLease(data, liveEngine(new Set()), "H1", now, 1000);
    assert(leaseHeldBy(data, "H1", now));
    assert(!leaseHeldBy(data, "H2", now));
    assert(!leaseHeldBy(data, "H1", new Date(now.getTime() + 2000)));
  });
});

test("excerptAround never splits a quoted secret: classifier anchors inside a quoted value (#1074 review)", () => {
  for (const text of [
    "tool --client-secret 'Error: opaque-credential' and more",
    'run PASSWORD="Blocked by nano-coder permissions: opaque-credential" now',
    '{"api_key":"Error: opaque-credential"}',
  ]) {
    for (const anchor of ["Error:", "Blocked by"]) {
      const idx = text.indexOf(anchor);
      if (idx < 0) continue;
      const ex = excerptAround(text, idx);
      assert(!ex.includes("opaque-credential"), `leak: ${ex}`);
    }
  }
});

test("an escalation and the transcript signals of one execution count as ONE run (#1074 review)", async () => {
  await withData(async (data) => {
    const db = data.source().db;
    db.run("PRAGMA foreign_keys = OFF");
    db.run(
      "INSERT INTO pull_requests (pr_key, repo, number, url, status, process_key, created_at, updated_at) VALUES ('o/r#9', 'o/r', 9, 'https://github.com/o/r/pull/9', 'escalated', 'P1', '2026-01-01', '2026-01-01')",
    );
    db.run("INSERT INTO escalations (pr_key, round_no, kind, question, status, asked_at) VALUES ('o/r#9', 1, 'question', 'Blocker', 'open', '2026-01-01T06:00:00.000Z')");
    const engine = {
      searchAgentInstances: async () => [{ agentInstanceKey: "A1", processInstanceKey: "P1", status: "COMPLETED", completionDate: "2026-01-01T12:00:00.000Z", elementId: "x" }],
      searchAgentInstanceHistoryPage: async () => ({ items: [rec("TOOL_RESULT", "Error: one"), rec("TOOL_RESULT", "Error: two")], page: {} }),
      searchJobs: async () => [],
      searchIncidents: async () => [],
    } as any;
    await collectFriction({ data, engine, sweepKey: "SX", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const rows = db.all<{ run_key: string; kind: string }>("SELECT run_key, kind FROM friction_signals WHERE sweep_key = 'SX'");
    assert(rows.some((r) => r.kind === "escalation"));
    assert(rows.length >= 2);
    assertEquals([...new Set(rows.map((r) => r.run_key))], ["pi:P1"]);
  });
});

test("extractRunSignals never leaks a quoted secret into ANY signal field (#1074 review)", () => {
  for (const text of [
    "tool --client-secret 'Error: opaque-credential' and more",
    'run PASSWORD="Error: opaque-credential" now',
    '{"api_key":"Error: opaque-credential"}',
  ]) {
    const { signals } = extractRunSignals("R1", null, [rec("TOOL_RESULT", text)]);
    for (const s of signals) {
      for (const [k, v] of Object.entries(s)) assert(!String(v).includes("opaque-credential"), `leak in ${k}: ${v}`);
    }
  }
});

test("a still-THINKING run is collected by lastUpdatedDate, not deferred until it settles (#1074 review)", async () => {
  await withData(async (data) => {
    const records = [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")];
    const engine = {
      searchAgentInstances: async () => [{ agentInstanceKey: "R1", status: "THINKING", lastUpdatedDate: "2026-01-01T12:00:00.000Z", elementId: "x" }],
      searchAgentInstanceHistoryPage: async () => ({ items: records, page: {} }),
      searchJobs: async () => [],
      searchIncidents: async () => [],
    } as any;
    const res = await collectFriction({ data, engine, sweepKey: "S1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(res.signalCount, 1);
  });
});

test("redact masks quoted Authorization headers in TEXT results (#1074 review)", () => {
  for (const msg of [
    'Error: request failed; headers={"Authorization":"Basic dXNlcjpwYXNz"}',
    "headers={'Authorization': 'Bearer abcdefghijklmnop'}",
    "AUTHORIZATION=Basic dXNlcjpwYXNz",
  ]) {
    const out = redact(msg);
    assert(!out.includes("dXNlcjpwYXNz") && !out.includes("abcdefghijklmnop"), out);
  }
});

// ── #1074 round-2 maintainer guidance ──────────────────────────────────────────────────────────

test("an incident created AND resolved between two sweeps is still collected", async () => {
  await withData(async (data) => {
    // Sweep 1 sees nothing; the incident is raised and resolved before sweep 2 runs.
    let incidents: { incidentKey: string; processInstanceKey: string; errorType: string; errorMessage: string; state: string }[] = [];
    const engine = {
      searchAgentInstances: async () => [],
      searchAgentInstanceHistoryPage: async () => ({ items: [], page: {} }),
      searchJobs: async () => [],
      searchIncidents: async (f?: { state?: string }) => incidents.filter((i) => !f?.state || i.state === f.state),
    } as any;
    await collectFriction({ data, engine, sweepKey: "IR1", now: new Date("2026-01-02T00:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    incidents = [{ incidentKey: "I9", processInstanceKey: "P9", errorType: "E", errorMessage: "m", state: "RESOLVED" }];
    await collectFriction({ data, engine, sweepKey: "IR2", now: new Date("2026-01-02T01:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    const rows = data.source().db.all<{ id: string }>("SELECT id FROM friction_signals WHERE sweep_key = 'IR2' AND kind = 'incident'");
    assertEquals(rows.map((r) => r.id), ["incident:I9"]);
    // And a third sweep does not re-count it.
    await collectFriction({ data, engine, sweepKey: "IR3", now: new Date("2026-01-02T02:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(data.source().db.all("SELECT id FROM friction_signals WHERE sweep_key = 'IR3'").length, 0);
  });
});

test("a job whose lease expired (TIMED_OUT) is collected as a lease-expiry signal", async () => {
  await withData(async (data) => {
    // Fake clock: the job was activated at T with a 5-minute lease; the sweep runs well past expiry,
    // and the engine reports the job TIMED_OUT only once that deadline has passed.
    const activatedAt = Date.parse("2026-01-02T00:00:00.000Z");
    const leaseMs = 5 * 60 * 1000;
    const clock = { now: activatedAt };
    const engine = {
      searchAgentInstances: async () => [],
      searchAgentInstanceHistoryPage: async () => ({ items: [], page: {} }),
      searchJobs: async ({ state }: { state: string }) =>
        state === "TIMED_OUT" && clock.now > activatedAt + leaseMs ? [{ jobKey: "J5", type: "senior:implement", processInstanceKey: "P5", elementId: "impl" }] : [],
      searchIncidents: async () => [],
    } as any;
    // Before expiry: no signal.
    await collectFriction({ data, engine, sweepKey: "LE1", now: new Date(clock.now), config: CONFIG, baseUrl: "http://h" });
    assertEquals(data.source().db.all("SELECT id FROM friction_signals WHERE sweep_key = 'LE1'").length, 0);
    // Advance the fake clock past the lease: the expiry is now observed and signalled.
    clock.now = activatedAt + leaseMs + 60_000;
    await collectFriction({ data, engine, sweepKey: "LE2", now: new Date(clock.now), config: CONFIG, baseUrl: "http://h" });
    const rows = data.source().db.all<{ id: string; excerpt: string; fingerprint: string }>("SELECT id, excerpt, fingerprint FROM friction_signals WHERE sweep_key = 'LE2'");
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.id, "failed_job:J5");
    assert(rows[0]?.excerpt.includes("lease expired"), rows[0]?.excerpt ?? "");
    assert(rows[0]?.fingerprint.includes("timed_out"), rows[0]?.fingerprint ?? "");
  });
});

test("a closed (completed) issue carrying the fingerprint gets a comment and is reopened, not duplicated", async () => {
  const closed = [{ number: 9, url: "https://github.com/acme/friction/issues/9", title: "t", body: fingerprintMarker("redirect-blocked"), state: "closed", stateReason: "completed" }];
  const { github, calls, created } = githubStub(closed);
  const res = await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, parseFindings([finding()]).findings);
  assertEquals(created.length, 0);
  assertEquals(calls, ["list", "comment:9", "reopen:9"]);
  assertEquals(res.updated, ["https://github.com/acme/friction/issues/9"]);
});

test("a closed not_planned issue carrying the fingerprint gets a comment but is NOT reopened", async () => {
  const closed = [{ number: 9, url: "https://github.com/acme/friction/issues/9", title: "t", body: fingerprintMarker("redirect-blocked"), state: "closed", stateReason: "not_planned" }];
  const { github, calls, created } = githubStub(closed);
  await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, parseFindings([finding()]).findings);
  assertEquals(created.length, 0);
  assertEquals(calls, ["list", "comment:9"]);
});

test("a fingerprint match on page 2 of the issue listing is still found", async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, url: "", title: "x", body: fingerprintMarker(`other-${i}`), state: "open" }));
  const hit = { number: 42, url: "https://github.com/acme/friction/issues/42", title: "t", body: fingerprintMarker("redirect-blocked"), state: "open" };
  const { github, calls, created } = githubStub([], [filler, [hit]]);
  await fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, parseFindings([finding()]).findings);
  assertEquals(created.length, 0);
  assertEquals(calls, ["list", "list", "comment:42"]);
});

test("merging 3 same-fingerprint findings counts 3 distinct runs, not 1 (real SQL recount)", async () => {
  await withData(async (data) => {
    const db = data.source().db;
    const ins = (id: string, run: string) =>
      db.run(
        "INSERT INTO friction_signals (id, sweep_key, kind, run_key, run_url, fingerprint, excerpt, created_at) VALUES (?, 'S', 'escalation', ?, NULL, 'fp', '', '2026-01-01')",
        [id, run],
      );
    ins("1", "rA");
    ins("2", "rB");
    ins("3", "rC");
    ins("4", "rA"); // a repeat of one run must not count as a 4th run
    const { github, created } = githubStub();
    const res = await fileFindings(
      { github, config: CONFIG, window: WINDOW, observed: (fps) => observedSignalCounts(data, "S", fps), leaseHeld: HELD, evidenceLinks: NOLINKS },
      parseFindings([
        finding({ occurrences: 2, runs: 1, evidence: "- run A", signalFingerprints: ["fp"] }),
        finding({ occurrences: 1, runs: 1, evidence: "- run B", signalFingerprints: ["fp"] }),
        finding({ occurrences: 1, runs: 1, evidence: "- run C", signalFingerprints: ["fp"] }),
      ]).findings,
    );
    assertEquals(res.created.length, 1);
    assert(created[0]?.body.includes("4 occurrence(s) across 3 run(s)"), created[0]?.body ?? "");
  });
});

test("dedupe index past the page cap refuses to write instead of duplicating an unscanned issue", async () => {
  const { github, created } = githubStub();
  github.listIssuesPage = async () => ({ issues: [], more: true });
  const { findings } = parseFindings([finding()]);
  await assertRejects(
    () => fileFindings({ github, config: CONFIG, window: WINDOW, observed: TRUST, leaseHeld: HELD, evidenceLinks: NOLINKS }, findings),
    Error,
    "dedupe index incomplete",
  );
  assertEquals(created.length, 0);
});

// ── #1098 review round 2: short pages, overlap starvation, watermark rewind ─────────────────────

test("fetchRunHistory keeps paging past a SHORT page whose cursor still advances (#1098 review)", async () => {
  const pages = [
    { items: [rec("ASSISTANT", "a", [], 1)], page: { endCursor: "c1" } },
    { items: [rec("ASSISTANT", "b", [], 2)], page: { endCursor: "c2" } },
    { items: [], page: { endCursor: "c2" } },
  ];
  let i = 0;
  const engine = { searchAgentInstanceHistoryPage: async () => pages[Math.min(i++, pages.length - 1)] } as any;
  const got = await fetchRunHistory(engine, "A1");
  assertEquals(got.length, 2);
  assertEquals(i, 3);
});

test("repeated sweeps under one cap never starve newer runs behind re-read overlap runs (#1098 review)", async () => {
  await withData(async (data) => {
    const big = (n: number) => Array.from({ length: 6 }, (_, k) => rec("ASSISTANT", "z".repeat(1000), [], n * 10 + k));
    const t0 = new Date("2026-01-02T00:00:00.000Z");
    const runs = [
      { key: "OLD1", at: new Date(t0.getTime() - 50 * 60_000).toISOString(), records: big(1) },
      { key: "OLD2", at: new Date(t0.getTime() - 20 * 60_000).toISOString(), records: big(2) },
    ];
    const { engine } = engineStub({ runs });
    const cap = 7000;
    await collectFriction({ data, engine, sweepKey: "S1", now: t0, config: CONFIG, baseUrl: "http://h" });
    // A newer run with a signal lands; OLD1/OLD2 sit in the next sweep's overlap hour.
    runs.push({ key: "NEW", at: new Date(t0.getTime() + 10 * 60_000).toISOString(), records: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: x")] });
    const now2 = new Date(t0.getTime() + 20 * 60_000);
    const s2 = await collectFriction({ data, engine, sweepKey: "S2", now: now2, config: CONFIG, baseUrl: "http://h", historyByteCap: cap });
    assertEquals(s2.signalCount, 1, "the new run is read despite the overlap runs");
    assertEquals(readWatermark(data), now2.toISOString());
  });
});

test("a capped overlap run never rewinds the watermark (#1098 review)", async () => {
  await withData(async (data) => {
    const t0 = new Date("2026-01-02T00:00:00.000Z");
    const runs: { key: string; at: string; records: AgentHistoryRecord[] }[] = [];
    const { engine } = engineStub({ runs });
    await collectFriction({ data, engine, sweepKey: "S1", now: t0, config: CONFIG, baseUrl: "http://h" });
    runs.push({ key: "OV", at: new Date(t0.getTime() - 30 * 60_000).toISOString(), records: Array.from({ length: 20 }, (_, k) => rec("ASSISTANT", "q".repeat(1000), [], k)) });
    const now2 = new Date(t0.getTime() + 60 * 60_000);
    const s2 = await collectFriction({ data, engine, sweepKey: "S2", now: now2, config: CONFIG, baseUrl: "http://h", historyByteCap: 5000 });
    assert(Date.parse(s2.windowEnd) >= Date.parse(s2.windowStart), `rewound: ${s2.windowStart} -> ${s2.windowEnd}`);
    assertEquals(readWatermark(data), now2.toISOString());
  });
});

// ── #1098 review round 3: timestamp ties and late-visible overlap runs under the byte cap ────────

test("runs sharing a timestamp are each read in full across capped sweeps (#1098 review)", async () => {
  await withData(async (data) => {
    const t0 = new Date("2026-01-02T00:00:00.000Z");
    const at = new Date(t0.getTime() - 30 * 60_000).toISOString();
    const big = (tag: string) => [
      ...Array.from({ length: 4 }, (_, k) => rec("ASSISTANT", "z".repeat(1000), [], k)),
      rec("TOOL_RESULT", `Blocked by nano-coder permissions: ${tag}`, [], 9),
    ];
    const runs = [
      { key: "R1", at, records: big("one") },
      { key: "R2", at, records: big("two") },
    ];
    const { engine } = engineStub({ runs });
    const cap = 6000; // each run fits alone, both together do not
    const sweeps = [];
    for (let i = 0; i < 3; i++) {
      sweeps.push(
        await collectFriction({ data, engine, sweepKey: `S${i}`, now: new Date(t0.getTime() + i * 60_000), config: CONFIG, baseUrl: "http://h", historyByteCap: cap }),
      );
    }
    const ids = data.source().db.all<{ excerpt: string }>("SELECT excerpt FROM friction_signals WHERE kind = 'permission_block'").map((r) => r.excerpt);
    assertEquals(ids.length, 2, `both tied runs collected in full: ${JSON.stringify(ids)}`);
    assertEquals(readWatermark(data), new Date(t0.getTime() + 2 * 60_000).toISOString());
  });
});

test("a late-visible overlap run whose first read is capped is still collected later (#1098 review)", async () => {
  await withData(async (data) => {
    const t0 = new Date("2026-01-02T00:00:00.000Z");
    const runs: { key: string; at: string; records: AgentHistoryRecord[] }[] = [];
    const { engine } = engineStub({ runs });
    await collectFriction({ data, engine, sweepKey: "S1", now: t0, config: CONFIG, baseUrl: "http://h" });
    const fill = Array.from({ length: 4 }, (_, k) => rec("ASSISTANT", "z".repeat(1000), [], k));
    runs.push({ key: "EARLY", at: new Date(t0.getTime() - 40 * 60_000).toISOString(), records: fill });
    runs.push({
      key: "LATE",
      at: new Date(t0.getTime() - 30 * 60_000).toISOString(),
      records: [...fill, rec("TOOL_RESULT", "Blocked by nano-coder permissions: late", [], 9)],
    });
    const cap = 6000;
    await collectFriction({ data, engine, sweepKey: "S2", now: new Date(t0.getTime() + 60 * 60_000), config: CONFIG, baseUrl: "http://h", historyByteCap: cap });
    const s3 = await collectFriction({ data, engine, sweepKey: "S3", now: new Date(t0.getTime() + 61 * 60_000), config: CONFIG, baseUrl: "http://h", historyByteCap: cap });
    assertEquals(s3.signalCount, 1, "the capped late-visible run is read on the next sweep");
  });
});

test("an oversized oldest run never advances the watermark past later unread runs (#1098 adversarial)", async () => {
  await withData(async (data) => {
    const t0 = new Date("2026-01-02T00:00:00.000Z");
    const huge = Array.from({ length: 20 }, (_, k) => rec("ASSISTANT", "q".repeat(1000), [], k));
    const { engine } = engineStub({
      runs: [
        { key: "HUGE", at: new Date(t0.getTime() - 10 * 3600_000).toISOString(), records: huge },
        { key: "NEXT", at: new Date(t0.getTime() - 5 * 3600_000).toISOString(), records: [rec("TOOL_RESULT", "Blocked by nano-coder permissions: next", [], 9)] },
      ],
    });
    const s1 = await collectFriction({ data, engine, sweepKey: "S1", now: t0, config: CONFIG, baseUrl: "http://h", historyByteCap: 5000 });
    assert(Date.parse(s1.windowEnd) < Date.parse(new Date(t0.getTime() - 5 * 3600_000).toISOString()), `watermark skipped NEXT: ${s1.windowEnd}`);
    await collectFriction({ data, engine, sweepKey: "S2", now: new Date(t0.getTime() + 24 * 3600_000), config: CONFIG, baseUrl: "http://h", historyByteCap: 5000 });
    const ex = data.source().db.all<{ excerpt: string }>("SELECT excerpt FROM friction_signals WHERE kind = 'permission_block'").map((r) => r.excerpt);
    assert(ex.some((e) => e.includes("next")), `NEXT was dropped: ${JSON.stringify(ex)}`);
  });
});

// ── Self-reported friction (issue #1101) ─────────────────────────────────────────────────────

test("parseFrictionNotes: absent/null/blank results are unchanged (no notes); valid notes are typed and redacted", () => {
  for (const raw of [undefined, null, "", "  ", "null"]) assertEquals(parseFrictionNotes(raw), { notes: [], malformed: 0 });
  const { notes, malformed } = parseFrictionNotes([
    { what: "AGENTS.md never says to run npm run gen; token ghp_abcdefghijklmnopqrstuvwxyz0123", turnsLost: 4.4, surface: "AGENTS.md", suggestedFix: "say it", targetRepo: "acme/repo" },
    { what: "x", surface: "not-a-surface" },
    { surface: "prompt" },
    "junk",
  ]);
  assertEquals(malformed, 3);
  assertEquals(notes.length, 1);
  assertEquals(notes[0]?.surface, "AGENTS.md");
  assertEquals(notes[0]?.turnsLost, 4);
  assertEquals(notes[0]?.targetRepo, "acme/repo");
  assert(!notes[0]?.what.includes("ghp_"), "what is redacted");
  assertEquals(parseFrictionNotes(JSON.stringify([{ what: "w", surface: "skill" }])).notes, [{ what: "w", surface: "skill" }]);
});

test("parseFrictionNotes: a credential-shaped targetRepo is discarded, never stored", () => {
  const { notes } = parseFrictionNotes([{ what: "w", surface: "prompt", targetRepo: "ghp_abcdefghijklmnopqrstuvwxyz0123/repo" }]);
  assertEquals(notes.length, 1);
  assertEquals(notes[0]?.targetRepo, undefined);
});

test("captureFrictionFromJob persists redacted notes with run linkage, idempotent by (processInstanceKey, note)", async () => {
  await withData(async (data) => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const job = { processInstanceKey: "P1", elementInstanceKey: "E1", jobKey: "J1", variables: { friction: [{ what: "password hunter2 in docs", surface: "prompt", turnsLost: 2 }] } };
    assertEquals(await captureFrictionFromJob(data, job, now), 1);
    // A later record worker of the SAME run still sees the propagated variable: nothing new is inserted.
    assertEquals(await captureFrictionFromJob(data, { ...job, elementInstanceKey: "E2" }, now), 0, "re-capture inserts nothing");
    // The same note in a DIFFERENT run is a distinct report.
    assertEquals(await captureFrictionFromJob(data, { ...job, processInstanceKey: "P2" }, now), 1);
    const rows = data.source().db.all<{ process_instance_key: string; scope_key: string; job_key: string; what: string; turns_lost: number }>(
      "SELECT process_instance_key, scope_key, job_key, what, turns_lost FROM friction_self_reports ORDER BY process_instance_key",
    );
    assertEquals(rows.length, 2);
    assertEquals(rows[0]?.process_instance_key, "P1");
    assertEquals(rows[0]?.scope_key, "E1");
    assertEquals(rows[0]?.job_key, "J1");
    assertEquals(rows[0]?.turns_lost, 2);
    assert(!rows[0]?.what.includes("hunter2"), "stored text is redacted");
  });
});

test("captureFrictionFromJob keeps job linkage with the Urban adapter's job shape (no elementInstanceKey)", async () => {
  await withData(async (data) => {
    // The Urban nanosdk adapter's handler job carries jobKey + processInstanceKey but NOT elementInstanceKey.
    const job = { jobKey: "42", processInstanceKey: "P9", type: "pr.capture-friction", variables: { friction: [{ what: "x", surface: "prompt" }] } };
    assertEquals(await captureFrictionFromJob(data, job), 1);
    const row = data.source().db.all<{ job_key: string | null; scope_key: string | null }>("SELECT job_key, scope_key FROM friction_self_reports")[0];
    assertEquals(row?.job_key, "42");
    assertEquals(row?.scope_key, null);
  });
});

test("captureFrictionFromJob: absent / null / malformed friction inserts nothing and never throws", async () => {
  await withData(async (data) => {
    for (const variables of [undefined, null, {}, { friction: null }, { friction: "" }, { friction: "{not json" }, { friction: [{ what: "x", surface: "nope" }] }, "junk"]) {
      assertEquals(await captureFrictionFromJob(data, { processInstanceKey: "P", variables }), 0);
    }
    assertEquals(data.source().db.all("SELECT id FROM friction_self_reports").length, 0);
  });
});

test("captureFrictionFromJob accepts a JSON-encoded friction array (string-typed result variable)", async () => {
  await withData(async (data) => {
    const friction = JSON.stringify([{ what: "a", surface: "skill" }, { what: "b", surface: "AGENTS.md" }]);
    assertEquals(await captureFrictionFromJob(data, { processInstanceKey: 7, variables: { friction } }), 2);
  });
});

test("every record worker following a senior:* agent task captures friction", () => {
  const workers = ["persist-round", "converge-gate", "persist-escalation", "liveness-check", "capture-head", "finalize", "escalation-steward-record", "friction-file", "reconcile-implement", "record-trial-merge", "arm-merge", "record-plan", "record-plan-review", "conformance-record", "retro-record"];
  for (const w of workers) {
    const src = readFileSync(resolve(import.meta.dirname, `../workers/${w}/worker.ts`), "utf8");
    assert(src.includes("await captureFrictionFromJob(app.data, job)"), `${w} captures friction`);
  }
});

test("collect emits self_reported signals into the digest, counts them, and respects digestMaxChars", async () => {
  await withData(async (data) => {
    const reports = Array.from({ length: 60 }, (_, i) => ({
      variableKey: `V${i}`,
      processInstanceKey: `P${i}`,
      scopeKey: `E${i}`,
      value: [{ what: `spent turns finding the build recipe ${"y".repeat(200)} ${i}`, surface: "AGENTS.md", suggestedFix: "document it" }],
    }));
    for (const r of reports) await captureFrictionFromJob(data, { processInstanceKey: r.processInstanceKey, elementInstanceKey: r.scopeKey, variables: { friction: r.value } }, new Date("2026-01-01T12:00:00.000Z"));
    const { engine } = engineStub();
    const res = await collectFriction({
      data,
      engine,
      sweepKey: "SR",
      now: new Date("2026-01-02T00:00:00.000Z"),
      config: { ...CONFIG, digestMaxChars: 3000 },
      baseUrl: "http://h",
    });
    assertEquals(res.status, "collected");
    assertEquals(res.signalCount, 60);
    assert(res.digest.includes("self_reported=60"), "per-kind count");
    assert(res.digest.includes("### self_reported"), "self_reported group");
    assert(res.digest.length <= 3000, "bounded digest");
    const sweep = data.source().db.all<{ self_reported_count: number }>("SELECT self_reported_count FROM friction_sweeps WHERE sweep_key = 'SR'")[0];
    assertEquals(sweep?.self_reported_count, 60);
    const again = await collectFriction({ data, engine, sweepKey: "SR2", now: new Date("2026-01-02T06:00:00.000Z"), config: CONFIG, baseUrl: "http://h" });
    assertEquals(again.signalCount, 0, "a later sweep never recounts a self-report");
  });
});

test("every senior:* agent task with explicit output mappings passes `friction` through (else it stays task-local and is lost)", () => {
  const dir = resolve(import.meta.dirname, "../resources/processes");
  let checked = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".bpmn"))) {
    const xml = readFileSync(resolve(dir, f), "utf8");
    for (const m of xml.matchAll(/<bpmn:serviceTask id="([^"]+)"[\s\S]*?<\/bpmn:serviceTask>/g)) {
      const block = m[0];
      if (!block.includes('type="senior:') || !block.includes("<zeebe:output")) continue;
      checked++;
      assert(block.includes('target="friction"'), `${f}#${m[1]} must map friction to process scope`);
      // A parent's `friction` propagates into a called child (call-activity variable propagation); without
      // a task-local null seed, an agent that omits the optional key re-emits the INHERITED note and it is
      // captured again under the child's processInstanceKey — one report counted N times (PR review #1103).
      assert(block.includes('<zeebe:input source="=null" target="friction" />'), `${f}#${m[1]} must seed task-local friction to null`);
    }
  }
  assert(checked > 0, "found mapped agent tasks");
});

test("implement-cell captures friction on the common post-agent path, before the result gateway", () => {
  const xml = readFileSync(resolve(import.meta.dirname, "../resources/processes/implement-cell.bpmn"), "utf8");
  assert(xml.includes('sourceRef="implement-task" targetRef="capture-friction"'), "agent -> capture");
  assert(xml.includes('sourceRef="capture-friction" targetRef="ic_gw"'), "capture -> gateway");
  const src = readFileSync(resolve(import.meta.dirname, "../workers/capture-friction/worker.ts"), "utf8");
  assert(src.includes("await captureFrictionFromJob(app.data, job)"));
});

test("issue #1104: a compiled delivery-graph agent cell's self-reported friction note lands in friction_self_reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nwf-friction-graph-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    // The fleet agent returns a friction note (with a secret, to prove redaction) in its result. No mock
    // for `pr.capture-friction`: the app's REAL worker (in-body step after the agent task) captures it.
    await app.engine.registerWorker("senior:feature", async () => ({
      status: "opened",
      friction: [{ what: "graph cell docs were stale; token ghp_abcdefghijklmnopqrstuvwxyz0123", surface: "prompt", turnsLost: 4 }],
    }));
    const graph: DeliveryGraph = { name: "friction graph", nodes: [{ id: "impl", kind: "agent", agent: { jobType: "senior:feature", prompt: "do it" } }], edges: [] };
    const run = await runDeliveryGraph(app.engine, graph, { repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    await app.engine.drain();
    const [pi] = await app.engine.searchProcessInstances({ processInstanceKeys: [run.handle.processInstanceKey] });
    assertEquals(pi?.state, "COMPLETED", "the capture step must not hold the agent cell open");
    const rows = app.db.source().db.all<{ process_instance_key: string; what: string; surface: string; turns_lost: number }>(
      "SELECT process_instance_key, what, surface, turns_lost FROM friction_self_reports",
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.process_instance_key, String(run.handle.processInstanceKey));
    assertEquals(rows[0]?.surface, "prompt");
    assertEquals(rows[0]?.turns_lost, 4);
    assert(rows[0]?.what.includes("graph cell docs were stale") && !rows[0]?.what.includes("ghp_"), "captured + redacted");
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue #1104: every compiled agent cell asks for friction notes and runs the capture step after the agent", async () => {
  const graph: DeliveryGraph = { name: "friction prompt", nodes: [{ id: "impl", kind: "agent", agent: { jobType: "senior:feature", prompt: "do it" } }], edges: [] };
  const prep = await prepareDeliveryGraph(graph, { repoless: true });
  assert(prep.ok, "prepare");
  const agent = Object.values(prep.prepared.nodeInputs).find((v) => "jobType" in v) as Record<string, unknown> | undefined;
  assert(String(agent?.appendPrompt).endsWith(renderFrictionNotes()), "agent appendPrompt carries the friction-notes paragraph");
  const compiled = await compileDeliveryGraphSemantic(graph);
  assert(compiled.ok, "compile");
  const bpmn = compiled.semanticBpmn;
  assert(bpmn.includes(`<zeebe:taskDefinition type="${CAPTURE_FRICTION_JOB_TYPE}" />`), "capture step compiled");
  // Capture runs OUTSIDE the SLA-guarded `<el>_work` scope: an in-flight SLA check can never cancel it.
  assert(/<bpmn:sequenceFlow id="(\w+)_w1" sourceRef="\1_task" targetRef="\1_wend"/.test(bpmn), "agent task -> terminate _work");
  assert(/<bpmn:sequenceFlow id="(\w+)_i1" sourceRef="\1_work" targetRef="\1_cf"/.test(bpmn), "_work -> capture");
  assert(/<bpmn:sequenceFlow id="(\w+)_wc" sourceRef="\1_cf" targetRef="\1_gate"/.test(bpmn), "capture -> producer gate");
  const work = bpmn.slice(bpmn.indexOf('_work" name='), bpmn.indexOf("</bpmn:subProcess>", bpmn.indexOf('_work" name=')));
  assert(!work.includes(CAPTURE_FRICTION_JOB_TYPE), "capture is not inside the SLA-guarded _work subProcess");
  assert(/target="friction"/.test(bpmn), "friction mapped out of the agent task node-locally");
});
