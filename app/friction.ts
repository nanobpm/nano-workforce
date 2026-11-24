// nano-workforce — the agent FRICTION SWEEP (issue #1073): the one canonical module behind
// `resources/processes/friction-sweep.bpmn`.
//
// Every 12h the sweep reads what agents did since the last sweep (engine records + engine-stored
// agent transcripts ONLY — never a host's worker logs) and turns the friction it finds (failed and
// retried tool calls, permission blocks, bash timeouts, missing generated facades, repeated commands,
// failed/timed-out jobs, incidents, escalations) into deduplicated, evidence-backed issues in a
// separate repo (`NANO_FRICTION_REPO`, default the private `jwulf/friction`).
//
// Three stages, three owners (no stage is duplicated anywhere else):
//   1. COLLECT (`pr.friction-collect` → {@link collectFriction}) — deterministic host code. Reads the
//      window `(watermark, now]`, extracts typed signals, REDACTS them, persists signals + a bounded
//      digest + the advanced watermark in ONE transaction (compare-and-swap on the watermark), and
//      hands ONLY the bounded redacted digest onward. Raw transcripts never leave this module.
//   2. ANALYSE (`senior:friction-analyst`, resources/prompts/friction-analyst.md) — an agent clusters
//      the signals into root causes and proposes findings with a fix surface + target repo.
//   3. FILE (`pr.friction-file` → {@link fileFindings}) — deterministic host code. Dedupes by
//      fingerprint against the open `friction` issues, applies the occurrence/run thresholds, and
//      opens or comments. The agent never writes to GitHub itself.
import type { AgentHistoryRecord, AgentInstanceSummary, DataLayer, EngineClient } from "@nanobpm/urban";
import { publicBaseUrl } from "./blackboard.ts";
import { readEnvOr } from "./contracts.ts";
import { runGh, useGh } from "./github.ts";

/** The friction-sweep BPMN process id (resources/processes/friction-sweep.bpmn). */
export const FRICTION_PROCESS_ID = "friction-sweep";
/** The analyst agent's job type. */
export const FRICTION_ANALYST_JOB_TYPE = "senior:friction-analyst";
/** The operator summary user task's element id (a Tasks-inbox kind, app/userTasks.ts). */
export const FRICTION_SUMMARY_ELEMENT = "friction-summary";
/** The `.form` the summary user task renders. */
export const FRICTION_SUMMARY_FORM = "friction-summary";
/** The label every filed finding carries — and the label the dedupe read filters on. */
export const FRICTION_LABEL = "friction";
/** How far back the FIRST sweep looks (no watermark yet): the engine retains transcripts for 24h. */
export const FIRST_SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** The singleton watermark row id. */
const WATERMARK_ID = "sweep";

/** The fix surfaces a finding may name (issue #1073 "Classification"). */
export const FIX_SURFACES = ["AGENTS.md", "prompt", "skill", "permission-rule", "worker-config", "missing-tool"] as const;
export type FixSurface = (typeof FIX_SURFACES)[number];

/** The signal kinds the collector extracts. One per detectable friction class. */
export const SIGNAL_KINDS = [
  "tool_error",
  "permission_block",
  "timeout",
  "missing_generated",
  "repeated_command",
  "failed_job",
  "incident",
  "escalation",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface FrictionConfig {
  repo: string;
  minOccurrences: number;
  minRuns: number;
  digestMaxChars: number;
  /** Singleton lease expiry (ms). */
  leaseMs: number;
}

function positiveInt(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The sweep's configuration, read through the ONE typed env schema (app/contracts.ts). */
export function frictionConfig(): FrictionConfig {
  return {
    repo: readEnvOr("NANO_FRICTION_REPO").trim() || "jwulf/friction",
    minOccurrences: positiveInt(readEnvOr("NANO_FRICTION_MIN_OCCURRENCES"), 3),
    minRuns: positiveInt(readEnvOr("NANO_FRICTION_MIN_RUNS"), 2),
    digestMaxChars: positiveInt(readEnvOr("NANO_FRICTION_DIGEST_MAX_CHARS"), 24000),
    leaseMs: positiveInt(readEnvOr("NANO_FRICTION_LEASE_MS"), 6 * 60 * 60 * 1000),
  };
}

// ── Redaction ────────────────────────────────────────────────────────────────────────────────────

const REDACTIONS: readonly [RegExp, string][] = [
  // GitHub tokens (classic + fine-grained + app/user/server tokens).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED:github-token]"],
  // Common vendor keys.
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:api-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
  // PEM private keys.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  // Bearer / Basic auth headers.
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)\s+[^\s"']+/gi, "$1[REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]"],
  // Credentials embedded in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  // KEY=value / "key": "value" for secret-looking names.
  [
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*)(\s*[=:]\s*)("?)[^\s"']+\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
  // Home-directory paths leak the operator's username.
  [/\/(Users|home)\/[^/\s"']+/g, "/$1/[user]"],
];

/** Strip secrets (tokens, keys, credentials, auth headers) and usernames-in-paths from `text`. Every
 *  excerpt and digest passes through this before it is persisted, handed to the analyst, or filed. */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

/** Normalise a message into a grouping fingerprint: redacted, lower-cased, volatile tokens (numbers,
 *  hex ids, quoted strings, temp paths) collapsed so the same friction across runs groups together. */
export function normaliseMessage(text: string): string {
  return redact(text)
    .toLowerCase()
    .replace(/\/(?:tmp|var\/folders|private\/var)\/\S*/g, "<tmp>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/"[^"\n]{0,200}"|'[^'\n]{0,200}'/g, "<str>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** A short excerpt around `index` in `text`, redacted and single-lined. */
export function excerptAround(text: string, index: number, radius = 160): string {
  // Redact the WHOLE text first, then window: slicing first could cut a secret's recognisable
  // prefix at the window edge so it escapes every REDACTIONS pattern. A private-use sentinel marks
  // the anchor so the index survives redaction's length changes.
  const MARK = "\uE000";
  const clean = text.replaceAll(MARK, "");
  let at = Math.max(0, Math.min(clean.length, index));
  // Anchor on a whitespace boundary so the sentinel never splits a token a pattern must match whole.
  while (at > 0 && !/\s/.test(clean[at - 1] ?? "")) at--;
  const marked = redact(`${clean.slice(0, at)}${MARK}${clean.slice(at)}`);
  let pos = marked.indexOf(MARK);
  const red = marked.replaceAll(MARK, "");
  if (pos < 0) pos = Math.min(red.length, at);
  let start = Math.max(0, pos - radius);
  let end = Math.min(red.length, pos + radius);
  // Never cut through a redaction placeholder (keeps a "[REDACTED…]" marker whole).
  const ph = /\[[A-Z_-]*REDACTED[^\]]*\]/g;
  for (const m of red.matchAll(ph)) {
    const a = m.index ?? 0;
    const b = a + m[0].length;
    if (a < start && b > start) start = a;
    if (a < end && b > end) end = b;
  }
  const body = red.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < red.length ? "…" : ""}`;
}

// ── Signal extraction ────────────────────────────────────────────────────────────────────────────

export interface FrictionSignal {
  /** Stable id: `<kind>:<source key>[:<n>]`. */
  id: string;
  kind: SignalKind;
  /** The agent-instance / job / incident / escalation key the signal came from. */
  runKey: string;
  runUrl: string | null;
  fingerprint: string;
  excerpt: string;
}

/** Ordered classifiers for one tool-result text; the FIRST match wins so a permission block is not
 *  also counted as a generic tool error. */
const TOOL_RESULT_CLASSIFIERS: readonly { kind: SignalKind; re: RegExp }[] = [
  { kind: "permission_block", re: /blocked by nano-coder permissions/i },
  { kind: "missing_generated", re: /ERR_MODULE_NOT_FOUND[^\n]*nano-generated|nano-generated[^\n]*ERR_MODULE_NOT_FOUND/ },
  { kind: "timeout", re: /\b(?:timed out|timeout(?:ed)? after|ETIMEDOUT|killed after \d+|SIGTERM)\b/i },
  {
    kind: "tool_error",
    re: /\b(?:exit code:? [1-9]\d*|exited with (?:code )?[1-9]\d*|command failed|ENOENT|EACCES|permission denied|no such file or directory|Error:|error\[|fatal:)/i,
  },
];

function recordText(rec: AgentHistoryRecord): string {
  return rec.content
    .map((b) => (typeof b.text === "string" ? b.text : b.object !== undefined ? JSON.stringify(b.object) : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/** Classify one tool-result text into a signal kind (or `null` when it carries no friction). */
export function classifyToolResult(text: string): { kind: SignalKind; index: number } | null {
  for (const { kind, re } of TOOL_RESULT_CLASSIFIERS) {
    const m = re.exec(text);
    if (m) return { kind, index: m.index };
  }
  return null;
}

/** How many identical tool calls in one run count as a "repeated command" (a check run again and again). */
export const REPEAT_THRESHOLD = 3;

export interface RunExtraction {
  signals: FrictionSignal[];
  tokens: number;
  turns: number;
}

/** Extract every friction signal from one agent run's history. Pure — the unit-tested core. */
export function extractRunSignals(runKey: string, runUrl: string | null, records: readonly AgentHistoryRecord[]): RunExtraction {
  const signals: FrictionSignal[] = [];
  const perKind = new Map<SignalKind, number>();
  const push = (kind: SignalKind, fingerprintSource: string, excerpt: string) => {
    const n = perKind.get(kind) ?? 0;
    perKind.set(kind, n + 1);
    signals.push({ id: `${kind}:${runKey}:${n}`, kind, runKey, runUrl, fingerprint: normaliseMessage(fingerprintSource), excerpt });
  };
  const callCounts = new Map<string, { count: number; label: string }>();
  let tokens = 0;
  const iterations = new Set<number>();
  for (const rec of records) {
    iterations.add(rec.loopIteration);
    if (rec.metrics) tokens += (rec.metrics.inputTokens ?? 0) + (rec.metrics.outputTokens ?? 0);
    if (rec.role === "TOOL_RESULT") {
      const text = recordText(rec);
      const hit = classifyToolResult(text);
      if (hit) {
        const line = text.slice(hit.index).split("\n")[0] ?? "";
        push(hit.kind, line, excerptAround(text, hit.index));
      }
    }
    for (const call of rec.toolCalls) {
      const key = `${call.toolName} ${JSON.stringify(call.arguments)}`;
      const prev = callCounts.get(key);
      callCounts.set(key, { count: (prev?.count ?? 0) + 1, label: key });
    }
  }
  for (const { count, label } of callCounts.values()) {
    if (count >= REPEAT_THRESHOLD) push("repeated_command", label, redact(`${count}× ${label.slice(0, 300)}`));
  }
  return { signals, tokens, turns: iterations.size };
}

/** History search has no paging parameter; the engine may cap one unfiltered page. When a page looks
 *  capped, re-read the run one loop iteration at a time so a long run is never silently truncated. */
export const HISTORY_PAGE_CAP = 100;
const MAX_ITERATIONS = 5000;

export async function fetchRunHistory(engine: EngineClient, agentInstanceKey: string): Promise<AgentHistoryRecord[]> {
  const first = await engine.searchAgentInstanceHistory(agentInstanceKey);
  if (first.length < HISTORY_PAGE_CAP) return first;
  const all: AgentHistoryRecord[] = [];
  let emptyStreak = 0;
  for (let i = 0; i < MAX_ITERATIONS && emptyStreak < 3; i++) {
    const page = await engine.searchAgentInstanceHistory(agentInstanceKey, { loopIteration: i });
    if (page.length === 0) emptyStreak++;
    else {
      emptyStreak = 0;
      all.push(...page);
    }
  }
  return all.length > 0 ? all : first;
}

const ACTIVE_AGENT_STATUSES = new Set(["INITIALIZING", "THINKING", "TOOL_CALLING"]);

/** The instant an agent run finished (or last moved), used to place it in a window. */
function runInstant(run: AgentInstanceSummary): string | null {
  if (ACTIVE_AGENT_STATUSES.has(run.status)) return null; // still running — swept once it settles
  return run.completionDate ?? run.lastUpdatedDate ?? null;
}

function inWindow(ts: string | null | undefined, start: string, end: string): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  return Number.isFinite(t) && t > Date.parse(start) && t <= Date.parse(end);
}

// ── Persistence ──────────────────────────────────────────────────────────────────────────────────

export interface FrictionSweepRow {
  sweep_key: string;
  window_start: string;
  window_end: string;
  status: string;
  runs_swept: number;
  signal_count: number;
  tool_error_count: number;
  permission_block_count: number;
  timeout_count: number;
  missing_generated_count: number;
  repeated_command_count: number;
  failed_job_count: number;
  incident_count: number;
  escalation_count: number;
  tokens_total: number;
  digest: string | null;
  created_issues: string | null;
  updated_issues: string | null;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  created_at: string;
  updated_at: string;
}

export const frictionSweeps = (data: DataLayer) => data.table<FrictionSweepRow>("friction_sweeps", "sweep_key");

/** The current watermark (exclusive lower bound of the next window), or `null` before the first sweep. */
export function readWatermark(data: DataLayer): string | null {
  const rows = data.source().db.all<{ watermark: string }>("SELECT watermark FROM friction_watermark WHERE id = ?", [WATERMARK_ID]);
  return rows[0]?.watermark ?? null;
}

// ── GitHub (findings repo) ───────────────────────────────────────────────────────────────────────

export interface FrictionIssue {
  number: number;
  url: string;
  title: string;
  body: string;
}

/** The narrow GitHub surface the sweep needs — injectable so tests stub it. */
export interface FrictionGithub {
  listOpenIssues(repo: string, label: string): Promise<FrictionIssue[]>;
  createIssue(repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  comment(repo: string, issueNumber: number, body: string): Promise<{ url: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toIssue(v: unknown): FrictionIssue | null {
  if (!isRecord(v) || typeof v.number !== "number") return null;
  if (isRecord(v.pull_request)) return null; // the issues API also lists PRs
  return {
    number: v.number,
    url: typeof v.html_url === "string" ? v.html_url : "",
    title: typeof v.title === "string" ? v.title : "",
    body: typeof v.body === "string" ? v.body : "",
  };
}

/** The production GitHub transport: the host `gh` CLI when present (the operator's own login reaches
 *  the private findings repo), else REST with `GITHUB_TOKEN` — the same selection app/github.ts uses. */
export function frictionGithub(token: string): FrictionGithub {
  const api = async (method: string, path: string, body?: Record<string, unknown>): Promise<unknown> => {
    if (await useGh()) {
      const args = ["api", "-X", method, path];
      for (const [k, v] of Object.entries(body ?? {})) {
        if (Array.isArray(v)) for (const item of v) args.push("-f", `${k}[]=${String(item)}`);
        else args.push("-f", `${k}=${String(v)}`);
      }
      const out = await runGh(args, { timeoutMs: 60_000 });
      return out.trim() === "" ? null : JSON.parse(out);
    }
    if (!token) throw new Error("friction sweep: no GitHub transport (no gh CLI and no GITHUB_TOKEN)");
    const r = await fetch(`https://api.github.com/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path} → ${r.status}`);
    return r.status === 204 ? null : await r.json();
  };
  return {
    async listOpenIssues(repo, label) {
      const out: FrictionIssue[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await api("GET", `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`);
        const rows = Array.isArray(res) ? res : [];
        for (const r of rows) {
          const issue = toIssue(r);
          if (issue) out.push(issue);
        }
        if (rows.length < 100) break;
      }
      return out;
    },
    async createIssue(repo, issue) {
      const res = await api("POST", `repos/${repo}/issues`, { title: issue.title, body: issue.body, labels: issue.labels });
      const parsed = toIssue(res);
      if (!parsed) throw new Error(`GitHub create issue on ${repo} returned no issue`);
      return { number: parsed.number, url: parsed.url };
    },
    async comment(repo, issueNumber, body) {
      const res = await api("POST", `repos/${repo}/issues/${issueNumber}/comments`, { body });
      return { url: isRecord(res) && typeof res.html_url === "string" ? res.html_url : `https://github.com/${repo}/issues/${issueNumber}` };
    },
  };
}

/** The hidden marker a filed finding carries, so a later sweep dedupes by fingerprint, not by title. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- nano-friction-fingerprint: ${fingerprint} -->`;
}

/** Parse the fingerprint marker out of a filed finding's body (`null` when absent). */
export function parseFingerprintMarker(body: string): string | null {
  const m = /<!-- nano-friction-fingerprint: ([a-z0-9][a-z0-9-]*) -->/.exec(body);
  return m ? (m[1] ?? null) : null;
}

/** Canonicalise an analyst-supplied fingerprint to a stable slug. */
export function canonicalFingerprint(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── Collect ──────────────────────────────────────────────────────────────────────────────────────

export interface CollectDeps {
  data: DataLayer;
  engine: EngineClient;
  /** The sweep's process-instance key — the idempotency key for a retried collect job. */
  sweepKey: string;
  now: Date;
  config: FrictionConfig;
  /** Best-effort read of the open findings (for the analyst's dedupe context). */
  github?: FrictionGithub;
  /** Base for per-run links (`NANO_WORKFORCE_BASE_URL`). */
  baseUrl: string;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface CollectResult {
  /** `collected` (signals found), `noop` (nothing new in the window), or `superseded` (a concurrent
   *  sweep won the watermark CAS — nothing persisted). */
  status: "collected" | "noop" | "superseded";
  windowStart: string;
  windowEnd: string;
  runsSwept: number;
  signalCount: number;
  digest: string;
  openFindings: string[];
}

function runUrlFor(baseUrl: string, agentInstanceKey: string): string {
  return `${baseUrl}/app/api/agentic/agent-instances/${encodeURIComponent(agentInstanceKey)}/history`;
}

function countByKind(signals: readonly FrictionSignal[]): Record<SignalKind, number> {
  const out = Object.fromEntries(SIGNAL_KINDS.map((k) => [k, 0]));
  for (const s of signals) out[s.kind] = (out[s.kind] ?? 0) + 1;
  // biome-ignore lint/plugin: Object.fromEntries widens the literal key set; every SignalKind is seeded above
  return out as Record<SignalKind, number>;
}

interface RunSummary {
  runKey: string;
  elementId: string;
  tokens: number;
  turns: number;
  signals: number;
}

/** Build the bounded, redacted digest the analyst reads: per-kind counts, signals grouped by
 *  fingerprint (occurrences, distinct runs, a few excerpts + run links), then per-run summaries. Over
 *  `maxChars` it first drops to one excerpt per group, then truncates. */
export function buildDigest(
  window: { start: string; end: string },
  signals: readonly FrictionSignal[],
  runs: readonly RunSummary[],
  maxChars: number,
): string {
  const render = (excerptsPerGroup: number): string => {
    const counts = countByKind(signals);
    const lines: string[] = [
      `# Friction digest ${window.start} → ${window.end}`,
      "",
      `Runs swept: ${runs.length}. Signals: ${signals.length}.`,
      `Counts: ${SIGNAL_KINDS.map((k) => `${k}=${counts[k]}`).join(", ")}`,
      "",
      "## Signal groups (kind · fingerprint · occurrences · distinct runs)",
    ];
    const groups = new Map<string, FrictionSignal[]>();
    for (const s of signals) {
      const key = `${s.kind}\u0000${s.fingerprint}`;
      const g = groups.get(key) ?? [];
      g.push(s);
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
    for (const g of ordered) {
      const head = g[0];
      if (!head) continue;
      const distinct = new Set(g.map((s) => s.runKey)).size;
      lines.push("", `### ${head.kind} · \`${head.fingerprint}\` · ${g.length}× · ${distinct} run(s)`);
      for (const s of g.slice(0, excerptsPerGroup)) {
        lines.push(`- run ${s.runKey}${s.runUrl ? ` (${s.runUrl})` : ""}: ${s.excerpt}`);
      }
    }
    if (runs.length > 0) {
      lines.push("", "## Runs (agent instance · element · turns · tokens · signals)");
      for (const r of runs) lines.push(`- ${r.runKey} · ${r.elementId} · ${r.turns} · ${r.tokens} · ${r.signals}`);
    }
    return lines.join("\n");
  };
  let digest = redact(render(3));
  if (digest.length > maxChars) digest = redact(render(1));
  if (digest.length > maxChars) digest = `${digest.slice(0, Math.max(0, maxChars - 32))}\n…[digest truncated]`;
  return digest;
}

/** Render the open friction issues as the analyst's dedupe context (`#N [fingerprint] title`). */
function openFindingLines(issues: readonly FrictionIssue[]): string[] {
  return issues.map((i) => `#${i.number} [${parseFingerprintMarker(i.body) ?? "no-fingerprint"}] ${i.title}`);
}

/** Collect one sweep window. Idempotent: a retried job with the same `sweepKey` returns the stored
 *  result without re-reading; a failure before the commit leaves the watermark untouched (the window
 *  is re-swept next time); a concurrent sweep that loses the watermark CAS persists nothing. */
export async function collectFriction(deps: CollectDeps): Promise<CollectResult> {
  const { data, engine, sweepKey, config } = deps;
  const existing = await frictionSweeps(data).get(sweepKey);
  if (existing) {
    return {
      status: existing.signal_count > 0 ? "collected" : "noop",
      windowStart: existing.window_start,
      windowEnd: existing.window_end,
      runsSwept: existing.runs_swept,
      signalCount: existing.signal_count,
      digest: existing.digest ?? "",
      openFindings: [],
    };
  }
  const priorWatermark = readWatermark(data);
  const windowEnd = deps.now.toISOString();
  const windowStart = priorWatermark ?? new Date(deps.now.getTime() - FIRST_SWEEP_LOOKBACK_MS).toISOString();

  // ── Read (no writes yet: any throw here leaves the watermark where it was). ──
  const signals: FrictionSignal[] = [];
  const runs: RunSummary[] = [];
  const allRuns = await engine.searchAgentInstances();
  for (const run of allRuns) {
    if (!inWindow(runInstant(run), windowStart, windowEnd)) continue;
    const history = await fetchRunHistory(engine, run.agentInstanceKey);
    const ex = extractRunSignals(run.agentInstanceKey, runUrlFor(deps.baseUrl, run.agentInstanceKey), history);
    const metricTokens = run.metrics ? run.metrics.inputTokens + run.metrics.outputTokens : 0;
    signals.push(...ex.signals);
    runs.push({
      runKey: run.agentInstanceKey,
      elementId: run.elementId ?? "?",
      tokens: ex.tokens || metricTokens,
      turns: ex.turns,
      signals: ex.signals.length,
    });
  }
  // Engine-wide records carry no timestamp, so they are windowed by "not yet recorded" — the stable
  // signal id is the fence that stops a still-listed job/incident from being counted twice.
  const seen = new Set(
    data.source().db.all<{ id: string }>("SELECT id FROM friction_signals WHERE kind IN ('failed_job','incident')").map((r) => r.id),
  );
  for (const state of ["FAILED", "TIMED_OUT"]) {
    for (const job of await engine.searchJobs({ state })) {
      const id = `failed_job:${job.jobKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const what = state === "TIMED_OUT" ? "lease expired (job timed out)" : `job failed (retries left: ${job.retries ?? "?"})`;
      signals.push({
        id,
        kind: "failed_job",
        runKey: job.jobKey,
        runUrl: null,
        fingerprint: normaliseMessage(`${job.type} ${state.toLowerCase()}`),
        excerpt: redact(`${job.type} @ ${job.elementId ?? "?"} (instance ${job.processInstanceKey}): ${what}`),
      });
    }
  }
  for (const inc of await engine.searchIncidents({ state: "ACTIVE" })) {
    const id = `incident:${inc.incidentKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const msg = `${inc.errorType ?? "INCIDENT"} ${inc.errorMessage ?? ""}`;
    signals.push({
      id,
      kind: "incident",
      runKey: inc.incidentKey,
      runUrl: null,
      fingerprint: normaliseMessage(msg),
      excerpt: redact(`${inc.elementId ?? "?"} (instance ${inc.processInstanceKey}): ${msg}`.slice(0, 400)),
    });
  }
  const db = data.source().db;
  const escalationRows = [
    ...db
      .all<{ id: number; question: string | null; at: string }>(
        "SELECT id, question, asked_at AS at FROM escalations WHERE asked_at > ? AND asked_at <= ?",
        [windowStart, windowEnd],
      )
      .map((r) => ({ ...r, src: "pr" })),
    ...db
      .all<{ id: number; question: string | null; at: string }>(
        "SELECT id, question, created_at AS at FROM feature_escalations WHERE created_at > ? AND created_at <= ?",
        [windowStart, windowEnd],
      )
      .map((r) => ({ ...r, src: "feature" })),
  ];
  for (const e of escalationRows) {
    const q = e.question ?? "";
    signals.push({
      id: `escalation:${e.src}:${e.id}`,
      kind: "escalation",
      runKey: `${e.src}-escalation:${e.id}`,
      runUrl: null,
      fingerprint: normaliseMessage(q.split("\n")[0] ?? q),
      excerpt: redact(q.replace(/\s+/g, " ").slice(0, 400)),
    });
  }

  const digest = signals.length > 0 ? buildDigest({ start: windowStart, end: windowEnd }, signals, runs, config.digestMaxChars) : "";
  let openFindings: string[] = [];
  if (signals.length > 0 && deps.github) {
    try {
      openFindings = openFindingLines(await deps.github.listOpenIssues(config.repo, FRICTION_LABEL));
    } catch (err) {
      // Advisory only: the FILE stage re-reads the open findings authoritatively before any write.
      deps.log?.warn("friction collect: could not list open findings (analyst gets no dedupe context)", { error: String(err) });
    }
  }

  // ── Commit: signals + sweep row + watermark CAS, atomically. ──
  const counts = countByKind(signals);
  const at = deps.now.toISOString();
  const status: CollectResult["status"] = signals.length > 0 ? "collected" : "noop";
  const superseded = await data.open().tx(async (t) => {
    const cas =
      priorWatermark === null
        ? await t.exec("INSERT OR IGNORE INTO friction_watermark (id, watermark, updated_at) VALUES (?, ?, ?)", [WATERMARK_ID, windowEnd, at])
        : await t.exec("UPDATE friction_watermark SET watermark = ?, updated_at = ? WHERE id = ? AND watermark = ?", [
            windowEnd,
            at,
            WATERMARK_ID,
            priorWatermark,
          ]);
    if (cas.changed !== 1) return true; // a concurrent sweep claimed this window — persist nothing
    for (const s of signals) {
      await t.exec(
        "INSERT OR IGNORE INTO friction_signals (id, sweep_key, kind, run_key, run_url, fingerprint, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [s.id, sweepKey, s.kind, s.runKey, s.runUrl, s.fingerprint, s.excerpt, at],
      );
    }
    await t.exec(
      `INSERT INTO friction_sweeps (sweep_key, window_start, window_end, status, runs_swept, signal_count,
         tool_error_count, permission_block_count, timeout_count, missing_generated_count, repeated_command_count,
         failed_job_count, incident_count, escalation_count, tokens_total, digest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sweepKey,
        windowStart,
        windowEnd,
        status,
        runs.length,
        signals.length,
        counts.tool_error,
        counts.permission_block,
        counts.timeout,
        counts.missing_generated,
        counts.repeated_command,
        counts.failed_job,
        counts.incident,
        counts.escalation,
        runs.reduce((n, r) => n + r.tokens, 0),
        digest || null,
        at,
        at,
      ],
    );
    return false;
  });
  if (superseded) return { status: "superseded", windowStart, windowEnd, runsSwept: 0, signalCount: 0, digest: "", openFindings: [] };
  return { status, windowStart, windowEnd, runsSwept: runs.length, signalCount: signals.length, digest, openFindings };
}

// ── File ─────────────────────────────────────────────────────────────────────────────────────────

/** One analyst-proposed finding (the `FrictionFinding` shape in friction-sweep.bpmn). */
export interface FrictionFinding {
  fingerprint: string;
  title: string;
  occurrences: number;
  runs: number;
  fixSurface: string;
  targetRepo: string;
  evidence: string;
  proposedFix: string;
  existingIssue?: number | null;
}

/** Coerce the analyst's `findings` (an array, or a JSON-encoded array) into typed findings; malformed
 *  entries are dropped (and counted as skipped by the filer). */
export function parseFindings(raw: unknown): { findings: FrictionFinding[]; malformed: number } {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = raw.trim() === "" ? [] : JSON.parse(raw);
    } catch {
      return { findings: [], malformed: 1 };
    }
  }
  if (!Array.isArray(list)) return { findings: [], malformed: list == null ? 0 : 1 };
  const findings: FrictionFinding[] = [];
  let malformed = 0;
  for (const item of list) {
    if (!isRecord(item)) {
      malformed++;
      continue;
    }
    const str = (k: string) => (typeof item[k] === "string" ? String(item[k]).trim() : "");
    const num = (k: string) => (typeof item[k] === "number" && Number.isFinite(item[k]) ? Number(item[k]) : Number(item[k]) || 0);
    const fingerprint = canonicalFingerprint(str("fingerprint"));
    const title = str("title");
    const fixSurface = str("fixSurface");
    const targetRepo = str("targetRepo");
    if (!fingerprint || !title || !FIX_SURFACES.some((s) => s === fixSurface) || !/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) {
      malformed++;
      continue;
    }
    const existing = num("existingIssue");
    findings.push({
      fingerprint,
      title,
      occurrences: num("occurrences"),
      runs: num("runs"),
      fixSurface,
      targetRepo,
      evidence: str("evidence"),
      proposedFix: str("proposedFix"),
      existingIssue: existing > 0 ? existing : null,
    });
  }
  return { findings, malformed };
}

export interface FileDeps {
  github: FrictionGithub;
  config: FrictionConfig;
  window: { start: string; end: string };
}

export interface FileResult {
  created: string[];
  updated: string[];
  skipped: number;
}

function issueBody(f: FrictionFinding, window: { start: string; end: string }): string {
  return redact(
    [
      fingerprintMarker(f.fingerprint),
      `**Fix surface:** ${f.fixSurface}  `,
      `**Target repo:** ${f.targetRepo}  `,
      `**Observed:** ${f.occurrences} occurrence(s) across ${f.runs} run(s), window ${window.start} → ${window.end}`,
      "",
      "## Evidence",
      f.evidence || "_(none supplied)_",
      "",
      "## Proposed fix",
      f.proposedFix || "_(none supplied)_",
      "",
      "_Filed by the nano-workforce friction sweep (nanobpm/nano-workforce#1073)._",
    ].join("\n"),
  );
}

function recurrenceComment(f: FrictionFinding, window: { start: string; end: string }): string {
  return redact(
    [
      `Seen again: ${f.occurrences} occurrence(s) across ${f.runs} run(s) in ${window.start} → ${window.end}.`,
      "",
      f.evidence || "_(no new evidence supplied)_",
    ].join("\n"),
  );
}

/** File the analyst's findings. Dedupes by fingerprint against the open `friction` issues (a match
 *  gets a recurrence comment, never a second issue), applies the occurrence/run thresholds to NEW
 *  findings, and makes NO GitHub call at all when there is nothing to file. */
export async function fileFindings(deps: FileDeps, findingsIn: readonly FrictionFinding[], malformed = 0): Promise<FileResult> {
  const result: FileResult = { created: [], updated: [], skipped: malformed };
  if (findingsIn.length === 0) return result;
  // Merge duplicates within this batch (same fingerprint) before touching GitHub.
  const byFp = new Map<string, FrictionFinding>();
  for (const f of findingsIn) {
    const prev = byFp.get(f.fingerprint);
    if (prev) {
      prev.occurrences += f.occurrences;
      prev.runs = Math.max(prev.runs, f.runs);
      prev.evidence = [prev.evidence, f.evidence].filter(Boolean).join("\n");
      prev.existingIssue = prev.existingIssue ?? f.existingIssue;
    } else byFp.set(f.fingerprint, { ...f });
  }
  const open = await deps.github.listOpenIssues(deps.config.repo, FRICTION_LABEL);
  const openByFp = new Map<string, FrictionIssue>();
  const openByNumber = new Map<number, FrictionIssue>();
  for (const issue of open) {
    openByNumber.set(issue.number, issue);
    const fp = parseFingerprintMarker(issue.body);
    if (fp) openByFp.set(fp, issue);
  }
  for (const f of byFp.values()) {
    const match = openByFp.get(f.fingerprint) ?? (f.existingIssue ? openByNumber.get(f.existingIssue) : undefined);
    if (match) {
      await deps.github.comment(deps.config.repo, match.number, recurrenceComment(f, deps.window));
      result.updated.push(match.url || `https://github.com/${deps.config.repo}/issues/${match.number}`);
      continue;
    }
    if (f.occurrences < deps.config.minOccurrences || f.runs < deps.config.minRuns) {
      result.skipped++;
      continue;
    }
    const made = await deps.github.createIssue(deps.config.repo, {
      title: redact(f.title).slice(0, 200),
      body: issueBody(f, deps.window),
      labels: [FRICTION_LABEL],
    });
    result.created.push(made.url || `https://github.com/${deps.config.repo}/issues/${made.number}`);
  }
  return result;
}

/** Persist the filing outcome onto the sweep row (status → `filed`). Idempotent overwrite. */
export async function recordFiled(data: DataLayer, sweepKey: string, res: FileResult, at: string): Promise<void> {
  await frictionSweeps(data).update(sweepKey, {
    status: "filed",
    created_issues: res.created.join("\n") || null,
    updated_issues: res.updated.join("\n") || null,
    created_count: res.created.length,
    updated_count: res.updated.length,
    skipped_count: res.skipped,
    updated_at: at,
  });
}

/** The operator summary (markdown) the `friction-summary` user task renders: the window, what was
 *  swept, and a clickable link to every issue opened or updated. */
export function summaryMarkdown(sweep: Pick<FrictionSweepRow, "window_start" | "window_end" | "runs_swept" | "signal_count">, res: FileResult, baseUrl: string): string {
  const lines = [
    `**Friction sweep** ${sweep.window_start} → ${sweep.window_end}`,
    "",
    `Swept ${sweep.runs_swept} agent run(s); ${sweep.signal_count} friction signal(s).`,
    "",
    `**Opened (${res.created.length})**`,
    ...(res.created.length > 0 ? res.created.map((u) => `- [${u}](${u})`) : ["- none"]),
    "",
    `**Updated (${res.updated.length})**`,
    ...(res.updated.length > 0 ? res.updated.map((u) => `- [${u}](${u})`) : ["- none"]),
    "",
    `Below threshold / malformed (not filed): ${res.skipped}.`,
    "",
    `Trend: [Friction page](${baseUrl}/app/pages/friction)`,
  ];
  return lines.join("\n");
}

/** The summary for a persisted sweep row — the Tasks-inbox "Decision context" of its summary task,
 *  derived from the SAME renderer the form's `frictionSummary` comes from (no second wording). */
export function frictionSweepSummary(row: FrictionSweepRow, baseUrl: string): string {
  const split = (v: string | null) => (v ? v.split("\n").filter((s) => s !== "") : []);
  return summaryMarkdown(row, { created: split(row.created_issues), updated: split(row.updated_issues), skipped: row.skipped_count }, baseUrl);
}

/** The summary task's auto-close window (the `PT24H` boundary in friction-sweep.bpmn) plus slack. */
export const FRICTION_SUMMARY_SCAN_MS = 48 * 60 * 60 * 1000;

/** Pure: whether a sweep row can still hold an open summary task — filed within the scan window. The
 *  bpmn boundary auto-closes it after 24h, so older sweeps need no engine round trip. */
export function frictionSummaryMayBeOpen(row: Pick<FrictionSweepRow, "status" | "window_end">, nowIso: string): boolean {
  if (row.status !== "filed") return false;
  const end = Date.parse(row.window_end);
  const now = Date.parse(nowIso);
  return Number.isFinite(end) && Number.isFinite(now) && now - end <= FRICTION_SUMMARY_SCAN_MS;
}

/** The ONE minter of the friction sweep's app links (per-run history links in the digest, the
 *  Friction page link, the summary's page link) — display-only, classified in AGENT_FACING_URLS. */
export function frictionAppBaseUrl(): string {
  return publicBaseUrl();
}

// ── Singleton lease ──────────────────────────────────────────────────────────────────────────────

const LEASE_ID = "sweep";

interface LeaseRow {
  holder: string | null;
  expires_at: string | null;
}

function readLease(data: DataLayer): LeaseRow | null {
  return data.source().db.all<LeaseRow>("SELECT holder, expires_at FROM friction_sweep_lock WHERE id = ?", [LEASE_ID])[0] ?? null;
}

/** Whether `processInstanceKey` is still a running instance. Fail-closed: an unreadable engine counts
 *  as live (the new firing skips; the lease's own expiry still bounds the wait). */
async function instanceLive(engine: EngineClient, processInstanceKey: string): Promise<boolean> {
  try {
    const found = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    return found.some((i) => i.processInstanceKey === processInstanceKey && i.state === "ACTIVE");
  } catch {
    return true;
  }
}

export interface LeaseResult {
  acquired: boolean;
  /** The instance holding the lease when it was NOT acquired. */
  heldBy: string | null;
}

/** Take the singleton sweep lease for `holder` with one atomic conditional write. Re-entrant for the
 *  same holder (a retried job). A lease held by another instance is taken over only when it has
 *  expired or its holder is no longer running (crashed / cancelled); otherwise the caller must skip. */
export async function acquireLease(data: DataLayer, engine: EngineClient, holder: string, now: Date, leaseMs: number): Promise<LeaseResult> {
  const at = now.toISOString();
  const expires = new Date(now.getTime() + leaseMs).toISOString();
  const cur = readLease(data);
  if (cur?.holder && cur.holder !== holder) {
    const expired = !cur.expires_at || Date.parse(cur.expires_at) <= now.getTime();
    if (!expired && (await instanceLive(engine, cur.holder))) return { acquired: false, heldBy: cur.holder };
  }
  const db = data.open();
  const res =
    cur === null
      ? await db.exec("INSERT OR IGNORE INTO friction_sweep_lock (id, holder, expires_at, acquired_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
          LEASE_ID,
          holder,
          expires,
          at,
          at,
        ])
      : await db.exec(
          "UPDATE friction_sweep_lock SET holder = ?, expires_at = ?, acquired_at = ?, updated_at = ? WHERE id = ? AND holder IS ? AND expires_at IS ?",
          [holder, expires, at, at, LEASE_ID, cur.holder, cur.expires_at],
        );
  if (res.changed === 1) return { acquired: true, heldBy: null };
  // Lost a race with a concurrent acquirer: report who holds it now.
  const after = readLease(data);
  return after?.holder === holder ? { acquired: true, heldBy: null } : { acquired: false, heldBy: after?.holder ?? null };
}

/** Release the lease iff `holder` still holds it (a taken-over holder can never free its successor). */
export async function releaseLease(data: DataLayer, holder: string, now: Date): Promise<boolean> {
  const res = await data
    .open()
    .exec("UPDATE friction_sweep_lock SET holder = NULL, expires_at = NULL, updated_at = ? WHERE id = ? AND holder = ?", [now.toISOString(), LEASE_ID, holder]);
  return res.changed === 1;
}

/** The current lease holder (null when free) — for tests and the page. */
export function leaseHolder(data: DataLayer): string | null {
  return readLease(data)?.holder ?? null;
}

/** Record a skipped firing ("sweep already running") as its own sweep row, so the Friction page shows it. */
export async function recordSkipped(data: DataLayer, sweepKey: string, heldBy: string | null, now: Date): Promise<void> {
  const at = now.toISOString();
  await data
    .open()
    .exec(
      "INSERT OR IGNORE INTO friction_sweeps (sweep_key, window_start, window_end, status, runs_swept, signal_count, digest, created_at, updated_at) VALUES (?, ?, ?, 'skipped', 0, 0, ?, ?, ?)",
      [sweepKey, at, at, `skipped: sweep already running${heldBy ? ` (held by ${heldBy})` : ""}`, at, at],
    );
}

/** Mark a sweep row `failed` (the filing step errored after collection). */
export async function markFailed(data: DataLayer, sweepKey: string, error: string, now: Date): Promise<void> {
  await frictionSweeps(data).update(sweepKey, { status: "failed", digest: redact(`failed: ${error}`).slice(0, 2000), updated_at: now.toISOString() });
}
