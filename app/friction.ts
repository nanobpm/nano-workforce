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
import { createHash } from "node:crypto";
import type { AgentHistoryRecord, AgentInstanceSummary, DataLayer, EngineClient } from "@nanobpm/urban";
import { publicBaseUrl } from "./blackboard.ts";
import { readEnvOr } from "./contracts.ts";
import { runGh, useGh } from "./github.ts";
import { parsePr } from "./prParse.ts";

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
/** The agent-instance search is eventually consistent (zero wait): a completion can become visible
 *  only AFTER a sweep committed host `now` as the watermark. Each sweep therefore re-reads this much
 *  overlap before the watermark; the stable signal ids (dedup against `friction_signals`) stop the
 *  overlap from double-counting anything an earlier sweep already recorded (issue #1074 review). */
export const SWEEP_OVERLAP_MS = 60 * 60 * 1000;

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
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED:google-key]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[REDACTED:npm-token]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED:gitlab-token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
  // PEM private keys.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  // Bearer / Basic auth headers.
  [/\b(authorization["']?\s*[:=]\s*["']?)(?:bearer|basic|token)\s+[^\s"']+/gi, "$1[REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]"],
  // Credentials embedded in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  // KEY=value / "key": "value" for secret-looking names.
  [
    /(["']?)\b((?:[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIALS?|AUTH(?:ORIZATION)?(?![A-Z]))[A-Z0-9_-]*)|(?:[A-Z0-9_-]*[-_])?KEY)\1(\s*[=:]\s*)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s"',;}]+)/gi,
    "$1$2$1$3[REDACTED]",
  ],
  // netrc-style `password <value>` / `passwd <value>` (fail closed: the next word is always masked).
  [/\b(password|passwd)([ \t]+)(?!\[REDACTED)[^\s]+/gi, "$1$2[REDACTED]"],
  // CLI secrets passed as a SEPARATE argument: `--token abc`, `--api-key abc`, `--client-secret abc`,
  // `--password-file x`. Keeps the flag, masks the value (fail closed: any secret-named flag).
  [
    /(^|[\s"'(=])(--?[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[-_]key|credential)[A-Za-z0-9_-]*)([ \t]+)(?!\[REDACTED)(?!-)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s"']+)/gi,
    "$1$2$3[REDACTED]",
  ],
  // curl `-u user:pass` / `--user user:pass` (attached `-uuser:pass` too): the whole pair is masked.
  [/(\bcurl\b[^\n|;&]*?\s(?:-u[ \t]*|--user(?:[ \t]+|=)))(?!\[REDACTED)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi, "$1[REDACTED]"],
  // mysql / mysqldump / psql `-p value` or `-pvalue` (scoped to those commands: `-p` is a port elsewhere).
  [/(\b(?:mysql|mysqldump|psql)\b[^\n|;&]*?\s-p)([ \t]*)(?!\[REDACTED)(?!-)([^\s"']+)/gi, "$1$2[REDACTED]"],
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
  let out = redact(text)
    .toLowerCase()
    .replace(/\/(?:tmp|var\/folders|private\/var)\/\S*/g, "<tmp>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/"[^"\n]{0,200}"|'[^'\n]{0,200}'/g, "<str>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  // Lower-casing turns placeholders (`[REDACTED]`) into text a later redact() pass rewrites, so a
  // fingerprint would change on its way through the digest and never recount. Settle it to a
  // fixed point of redact() so the identifier the analyst copies is the one stored.
  for (let i = 0; i < 4; i++) {
    const next = redact(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** A short excerpt around `index` in `text`, redacted and single-lined. */
export function excerptAround(text: string, index: number, radius = 160): string {
  // Redact the UNCHANGED whole text first, then window: slicing first could cut a secret's
  // recognisable prefix so it escapes every REDACTIONS pattern, and inserting an anchor marker before
  // redaction could interrupt credential syntax (e.g. inside a quoted secret value) so the redactor
  // masks only part of it (issue #1074 review). The anchor is mapped by redacting the prefix alone —
  // only the window position depends on it; the emitted text is always the fully redacted input.
  const red = redact(text);
  const at = Math.max(0, Math.min(text.length, index));
  const pos = Math.min(red.length, redact(text.slice(0, at)).length);
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

const SECRET_KEY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIAL|AUTHORIZATION|AUTH(?![a-z])|(?:^|[-_])KEY$)/i;

/** Redact a structured value BEFORE it is serialised (issue #1074 review): JSON-encoding first escapes
 *  quotes (`PASSWORD="x"` → `PASSWORD=\"x\"`), which the text redactor cannot see through. Every string
 *  leaf is redacted raw and every secret-named key's value is masked whole. Deterministic, so identical
 *  inputs still serialise identically (exact repeated-command grouping is preserved). */
export function redactStructured(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redactStructured(v);
    return out;
  }
  return value;
}

/** The ONE serialiser for structured transcript data: sanitise first, then stringify. */
export function serialiseRedacted(value: unknown): string {
  return JSON.stringify(redactStructured(value)) ?? "";
}

function recordText(rec: AgentHistoryRecord): string {
  return rec.content
    .map((b) => (typeof b.text === "string" ? b.text : b.object !== undefined ? serialiseRedacted(b.object) : ""))
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
  // Ids derive from a STABLE identity (the history item key, or a hash of the exact command), never an
  // ordinal: after a transcript prefix expires an ordinal shifts, so a new signal could inherit an id a
  // prior sweep already recorded and be discarded as a duplicate (issue #1074 review).
  const push = (kind: SignalKind, identity: string, fingerprint: string, excerpt: string) => {
    signals.push({ id: `${kind}:${runKey}:${identity}`, kind, runKey, runUrl, fingerprint, excerpt });
  };
  const callCounts = new Map<string, { count: number; label: string }>();
  let tokens = 0;
  const iterations = new Set<number>();
  for (const rec of records) {
    iterations.add(rec.loopIteration);
    if (rec.metrics) tokens += (rec.metrics.inputTokens ?? 0) + (rec.metrics.outputTokens ?? 0);
    if (rec.role === "TOOL_RESULT") {
      // Redact the WHOLE result before classifying: an anchor inside a quoted secret would otherwise
      // slice off the credential syntax and leak the value into the fingerprint (#1074 review).
      const text = redact(recordText(rec));
      const hit = classifyToolResult(text);
      if (hit) {
        const line = text.slice(hit.index).split("\n")[0] ?? "";
        push(hit.kind, rec.historyItemKey, normaliseMessage(line), excerptAround(text, hit.index));
      }
    }
    // Only ASSISTANT records issue calls; a TOOL_RESULT's `toolCalls` merely references the originating
    // tool (null arguments), so counting it would group unrelated commands into a false repeat.
    if (rec.role !== "ASSISTANT") continue;
    for (const call of rec.toolCalls) {
      const key = `${call.toolName} ${serialiseRedacted(call.arguments)}`;
      const prev = callCounts.get(key);
      callCounts.set(key, { count: (prev?.count ?? 0) + 1, label: key });
    }
  }
  for (const [key, { count, label }] of callCounts) {
    if (count < REPEAT_THRESHOLD) continue;
    // Group by the EXACT redacted command identity (hashed), never a normalised label: normalising
    // collapses distinct commands (`npm test` vs `curl …`) into one `{<str>:<str>}` group.
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    push("repeated_command", hash, `cmd:${hash}`, redact(`${count}× ${label}`).slice(0, 300));
  }
  return { signals, tokens, turns: iterations.size };
}

/** Every engine commit status a friction sweep reads (issue #1095). The engine defaults a history
 *  search without a `commitStatus` to COMMITTED only, which hides an in-flight run's PENDING records
 *  and a superseded attempt's DISCARDED ones — exactly where friction (a failed/expired attempt) lives.
 *  Each record keeps its unique `historyItemKey`, so signal ids stay idempotent per
 *  (sweep_key, fingerprint, run_key) across statuses and re-reads. */
export const HISTORY_COMMIT_STATUSES = ["PENDING", "DISCARDED", "COMMITTED"] as const;
/** Page size for the paged history read. */
export const HISTORY_PAGE_SIZE = 100;
/** Default per-sweep byte budget for history read across ALL runs (bounds a sweep's memory/time). */
export const HISTORY_SWEEP_BYTE_CAP = 8 * 1024 * 1024;
const MAX_PAGES = 5000;

/** A mutable per-sweep read budget shared by every `fetchRunHistory` call in one sweep. */
export interface HistoryBudget {
  remainingBytes: number;
  /** Set once the cap stopped a read early (the sweep reports it). */
  exhausted: boolean;
}

export function historyBudget(bytes: number = HISTORY_SWEEP_BYTE_CAP): HistoryBudget {
  return { remainingBytes: bytes, exhausted: false };
}

function recordBytes(rec: AgentHistoryRecord): number {
  return Buffer.byteLength(JSON.stringify(rec), "utf8");
}

/** Read one run's history across PENDING, DISCARDED and COMMITTED through the paged read-model
 *  query (`EngineClient.searchAgentInstanceHistoryPage`, never the engine REST API directly), following
 *  the page cursor until exhausted or the sweep's byte `budget` runs out. Records are de-duplicated by
 *  their unique `historyItemKey` so a page-boundary overlap never double-counts. */
export async function fetchRunHistory(
  engine: EngineClient,
  agentInstanceKey: string,
  budget: HistoryBudget = historyBudget(),
): Promise<AgentHistoryRecord[]> {
  const all: AgentHistoryRecord[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (budget.remainingBytes <= 0) {
      budget.exhausted = true;
      break;
    }
    const res = await engine.searchAgentInstanceHistoryPage(agentInstanceKey, {
      filter: { commitStatus: { $in: [...HISTORY_COMMIT_STATUSES] } },
      page: after === undefined ? { limit: HISTORY_PAGE_SIZE } : { limit: HISTORY_PAGE_SIZE, after },
    });
    for (const rec of res.items) {
      if (seen.has(rec.historyItemKey)) continue;
      const size = recordBytes(rec);
      if (size > budget.remainingBytes) {
        budget.remainingBytes = 0;
        budget.exhausted = true;
        return all;
      }
      budget.remainingBytes -= size;
      seen.add(rec.historyItemKey);
      all.push(rec);
    }
    const cursor = res.page.endCursor ?? undefined;
    // Stop on cursor exhaustion/repetition ONLY: the mapper can drop malformed rows from a page while
    // keeping its cursor, so a short page is not proof the history ended (#1098 review).
    if (!cursor || cursor === after) break;
    after = cursor;
  }
  return all;
}

/** The instant an agent run last moved, used to place it in a window. Selected by `lastUpdatedDate`
 *  REGARDLESS of status: waiting for a long run to settle would let the engine's 24h transcript
 *  retention expire its early records before the first read. Stable signal ids dedupe re-reads. */
function runInstant(run: AgentInstanceSummary): string | null {
  return run.lastUpdatedDate ?? run.completionDate ?? null;
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
  /** Why the filing stage failed (`markFailed`) — kept apart from `digest` so the findings survive. */
  error: string | null;
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
  /** `open`/`closed` — only populated by `listIssuesPage` (state=all); open-only listings omit it. */
  state?: string;
  /** GitHub's close reason (`completed`, `not_planned`, …) for a closed issue. */
  stateReason?: string | null;
}

/** The narrow GitHub surface the sweep needs — injectable so tests stub it. */
export interface FrictionGithub {
  listOpenIssues(repo: string, label: string): Promise<FrictionIssue[]>;
  /** One page (1-based, 100 per page) of `label` issues in ANY state — open and closed — so a
   *  closed finding's fingerprint still dedupes. `more` is true when a further page may exist. */
  listIssuesPage(repo: string, label: string, page: number): Promise<{ issues: FrictionIssue[]; more: boolean }>;
  reopen(repo: string, issueNumber: number): Promise<void>;
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
    state: typeof v.state === "string" ? v.state : undefined,
    stateReason: typeof v.state_reason === "string" ? v.state_reason : null,
  };
}

/** Safety bound on pages drained for fingerprint dedupe (100 issues each). Hitting it with more
 *  pages still pending makes the dedupe index incomplete, so the sweep refuses to write (fail closed)
 *  rather than risk duplicating an issue that lives on an unscanned page. */
export const ISSUE_PAGE_CAP = 500;

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
    async listIssuesPage(repo, label, page) {
      const res = await api("GET", `repos/${repo}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`);
      const rows = Array.isArray(res) ? res : [];
      const issues: FrictionIssue[] = [];
      for (const r of rows) {
        const issue = toIssue(r);
        if (issue) issues.push(issue);
      }
      return { issues, more: rows.length >= 100 };
    },
    async reopen(repo, issueNumber) {
      await api("PATCH", `repos/${repo}/issues/${issueNumber}`, { state: "open" });
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
  /** Per-sweep history byte cap (default {@link HISTORY_SWEEP_BYTE_CAP}). */
  historyByteCap?: number;
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

/** A BROWSER-facing link to a run: the Cockpit page focused on the owning process instance. Never the
 *  protected history JSON endpoint, which 401s on navigation when a hook secret is configured. */
export function cockpitUrlFor(baseUrl: string, processInstanceKey: string): string {
  return `${baseUrl}/app/pages/cockpit#/cockpit/${encodeURIComponent(processInstanceKey)}`;
}

/** The ONE canonical run identity every signal source counts distinct runs by: the owning process
 *  instance (`pi:<key>`), falling back to the source record's own key only when none is known. */
export function canonicalRunKey(processInstanceKey: string | number | null | undefined, fallback: string): string {
  const k = processInstanceKey == null ? "" : String(processInstanceKey).trim();
  return k ? `pi:${k}` : fallback;
}

function countByKind(signals: readonly FrictionSignal[]): Record<SignalKind, number> {
  const out = Object.fromEntries(SIGNAL_KINDS.map((k) => [k, 0]));
  for (const s of signals) out[s.kind] = (out[s.kind] ?? 0) + 1;
  // biome-ignore lint/plugin: Object.fromEntries widens the literal key set; every SignalKind is seeded above
  return out as Record<SignalKind, number>;
}

interface RunSummary {
  runKey: string;
  /** Internal: ids of this run's signals (for the post-dedup recount); not rendered. */
  signalIds?: Set<string>;
  /** Internal: read only through the overlap before the watermark. */
  overlapOnly?: boolean;
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

/** The engine seam's searches read ONE server page (no paging through the Urban adapter yet —
 *  follow-up #1076). A result that fills a page may have been truncated: say so loudly. */
export const ENGINE_DEFAULT_PAGE_SIZE = 100;
function warnIfFullPage(log: CollectDeps["log"], what: string, n: number): void {
  if (n >= ENGINE_DEFAULT_PAGE_SIZE) {
    log?.warn(`friction collect: ${what} search returned a full page (${n}); results beyond it may be omitted`, { what, count: n });
  }
}

/** The subset of agent-run `keys` already fully read by an earlier sweep (`friction_swept_runs`). */
export function sweptRunKeys(data: DataLayer, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  const db = data.source().db;
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = db.all<{ run_key: string }>(`SELECT run_key FROM friction_swept_runs WHERE run_key IN (${chunk.map(() => "?").join(", ")})`, chunk);
    for (const r of rows) out.add(r.run_key);
  }
  return out;
}

/** The subset of `ids` already persisted in `friction_signals` (by any earlier sweep). */
export function recordedSignalIds(data: DataLayer, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const db = data.source().db;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.all<{ id: string }>(`SELECT id FROM friction_signals WHERE id IN (${chunk.map(() => "?").join(", ")})`, chunk);
    for (const r of rows) out.add(r.id);
  }
  return out;
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
  let windowEnd = deps.now.toISOString();
  const windowStart = priorWatermark ?? new Date(deps.now.getTime() - FIRST_SWEEP_LOOKBACK_MS).toISOString();
  // The READ window reaches SWEEP_OVERLAP_MS behind the watermark (late-visible completions).
  const readStart = priorWatermark === null ? windowStart : new Date(Date.parse(priorWatermark) - SWEEP_OVERLAP_MS).toISOString();

  // ── Read (no writes yet: any throw here leaves the watermark where it was). ──
  const signals: FrictionSignal[] = [];
  const runs: RunSummary[] = [];
  const budget = historyBudget(deps.historyByteCap);
  const allRuns = await engine.searchAgentInstances();
  warnIfFullPage(deps.log, "agent instances", allRuns.length);
  // Read every run in (readStart, windowEnd] that the per-run ledger (`friction_swept_runs`) does not
  // already hold, OLDEST-FIRST. Already-swept runs cost no budget (no overlap starvation), and a
  // late-visible overlap run or a timestamp tie left unread by the byte cap stays a candidate: it is
  // never recorded in the ledger, and the watermark never advances past it (#1098 review).
  const swept = sweptRunKeys(data, allRuns.map((r) => r.agentInstanceKey));
  const byInstant = (a: AgentInstanceSummary, b: AgentInstanceSummary) =>
    Date.parse(runInstant(a) ?? "") - Date.parse(runInstant(b) ?? "");
  const candidates = allRuns
    .filter((run) => !swept.has(run.agentInstanceKey) && inWindow(runInstant(run), readStart, windowEnd))
    .sort(byInstant);
  const fullyRead: { key: string; instant: string }[] = [];
  let firstUnread: string | null = null;
  for (const run of candidates) {
    const instant = runInstant(run) ?? windowEnd;
    const history = await fetchRunHistory(engine, run.agentInstanceKey, budget);
    if (budget.exhausted) {
      if (fullyRead.length === 0) {
        // Degenerate: the oldest unswept run alone exceeds the cap. Leaving it unread would wedge every
        // future sweep on it, so keep its truncated signals and record it as swept.
        deps.log?.warn("friction collect: a single run's history exceeds the byte cap — collected truncated", {
          run: run.agentInstanceKey,
        });
        pushRun(run, instant, history);
        fullyRead.push({ key: run.agentInstanceKey, instant });
      } else {
        // Drop the partial read; this run and every later one stay unread for the next sweep.
        firstUnread = instant;
      }
      break;
    }
    pushRun(run, instant, history);
    fullyRead.push({ key: run.agentInstanceKey, instant });
  }
  if (firstUnread !== null) {
    // Never advance past an unread run (but never rewind below the prior watermark either: the
    // ledger, not the watermark, carries progress through timestamp ties and overlap runs).
    const clamped = Date.parse(firstUnread) - 1;
    windowEnd = new Date(Math.max(Date.parse(windowStart), Math.min(Date.parse(windowEnd), clamped))).toISOString();
  }
  function pushRun(run: AgentInstanceSummary, instant: string | null, history: AgentHistoryRecord[]): void {
    const ex = extractRunSignals(run.agentInstanceKey, cockpitUrlFor(deps.baseUrl, run.processInstanceKey), history);
    const metricTokens = run.metrics ? run.metrics.inputTokens + run.metrics.outputTokens : 0;
    // Count runs by the CANONICAL run identity (the owning process instance) shared with failed-job and
    // incident signals; the signal id keeps the source-record key for dedup (issue #1074 review).
    const canonical = canonicalRunKey(run.processInstanceKey, run.agentInstanceKey);
    const runSignals = ex.signals.map((s) => ({ ...s, runKey: canonical }));
    signals.push(...runSignals);
    runs.push({
      overlapOnly: !inWindow(instant, windowStart, windowEnd),
      signalIds: new Set(runSignals.map((s) => s.id)),
      runKey: run.agentInstanceKey,
      elementId: run.elementId ?? "?",
      tokens: ex.tokens || metricTokens,
      turns: ex.turns,
      signals: ex.signals.length,
    });
  }
  if (firstUnread !== null) {
    deps.log?.warn("friction collect: history byte cap reached — unread runs re-swept next time", {
      cap: deps.historyByteCap ?? HISTORY_SWEEP_BYTE_CAP,
      windowEnd,
    });
  }
  // Engine-wide records carry no timestamp, so they are windowed by "not yet recorded" — the stable
  // signal id is the fence that stops a still-listed job/incident from being counted twice.
  const seen = new Set(
    data.source().db.all<{ id: string }>("SELECT id FROM friction_signals WHERE kind IN ('failed_job','incident')").map((r) => r.id),
  );
  for (const state of ["FAILED", "TIMED_OUT"]) {
    const jobs = await engine.searchJobs({ state });
    warnIfFullPage(deps.log, `jobs (${state})`, jobs.length);
    for (const job of jobs) {
      const id = `failed_job:${job.jobKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const what = state === "TIMED_OUT" ? "lease expired (job timed out)" : `job failed (retries left: ${job.retries ?? "?"})`;
      signals.push({
        id,
        kind: "failed_job",
        runKey: canonicalRunKey(job.processInstanceKey, `job:${job.jobKey}`),
        runUrl: job.processInstanceKey ? cockpitUrlFor(deps.baseUrl, String(job.processInstanceKey)) : null,
        fingerprint: normaliseMessage(`${job.type} ${state.toLowerCase()}`),
        excerpt: redact(`${job.type} @ ${job.elementId ?? "?"} (instance ${job.processInstanceKey}): ${what}`),
      });
    }
  }
  // ACTIVE *and* RESOLVED: an incident raised and resolved between two sweeps is still friction, and
  // incidents carry no timestamp to window on — the recorded-id fence (`seen`) stops a re-count.
  const incidents: Awaited<ReturnType<EngineClient["searchIncidents"]>>[number][] = [];
  for (const state of ["ACTIVE", "RESOLVED"] as const) {
    const page = await engine.searchIncidents({ state });
    warnIfFullPage(deps.log, `incidents (${state})`, page.length);
    incidents.push(...page);
  }
  for (const inc of incidents) {
    const id = `incident:${inc.incidentKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const msg = `${inc.errorType ?? "INCIDENT"} ${inc.errorMessage ?? ""}`;
    signals.push({
      id,
      kind: "incident",
      runKey: canonicalRunKey(inc.processInstanceKey, `incident:${inc.incidentKey}`),
      runUrl: inc.processInstanceKey ? cockpitUrlFor(deps.baseUrl, String(inc.processInstanceKey)) : null,
      fingerprint: normaliseMessage(msg),
      excerpt: redact(`${inc.elementId ?? "?"} (instance ${inc.processInstanceKey}): ${msg}`).slice(0, 400),
    });
  }
  const db = data.source().db;
  const escalationRows = [
    ...db
      .all<{ id: number; question: string | null; at: string; subject: string | null; pik: string | null }>(
        "SELECT e.id, e.question, e.asked_at AS at, e.pr_key AS subject, p.process_key AS pik FROM escalations e LEFT JOIN pull_requests p ON p.pr_key = e.pr_key WHERE e.asked_at > ? AND e.asked_at <= ?",
        [windowStart, windowEnd],
      )
      .map((r) => ({ ...r, src: "pr" })),
    ...db
      .all<{ id: number; question: string | null; at: string; subject: string | null; pik: string | null }>(
        "SELECT e.id, e.question, e.created_at AS at, e.feature_key AS subject, f.process_key AS pik FROM feature_escalations e LEFT JOIN feature_runs f ON f.feature_key = e.feature_key WHERE e.created_at > ? AND e.created_at <= ?",
        [windowStart, windowEnd],
      )
      .map((r) => ({ ...r, src: "feature" })),
  ];
  for (const e of escalationRows) {
    const q = e.question ?? "";
    signals.push({
      id: `escalation:${e.src}:${e.id}`,
      kind: "escalation",
      // The ONE canonical run identity (the subject's owning process instance), so an escalation and
      // the transcript/job/incident signals of the same execution count as ONE run (issue #1074
      // review). Fallback: the run SUBJECT (pr_key / feature_key), then the escalation's own id.
      runKey: canonicalRunKey(e.pik, e.subject ? `${e.src}:${e.subject}` : `${e.src}-escalation:${e.id}`),
      runUrl: escalationSubjectUrl(e.subject),
      fingerprint: normaliseMessage(q.split("\n")[0] ?? q),
      excerpt: redact(e.subject ? `[${e.subject}] ${q}` : q).replace(/\s+/g, " ").slice(0, 400),
    });
  }

  // Drop every signal an EARLIER sweep already recorded (issue #1074 review): an agent swept while
  // IDLE re-qualifies once its parent ends and supplies `completionDate`, and its transcript signals
  // would otherwise re-enter this window's digest + counts (the INSERT OR IGNORE below only fences the
  // rows, not the aggregation). Filtering here — before buildDigest/countByKind — fences all three.
  const recorded = recordedSignalIds(data, signals.map((s) => s.id));
  if (recorded.size > 0) {
    const fresh = signals.filter((s) => !recorded.has(s.id));
    signals.length = 0;
    signals.push(...fresh);
    for (const r of runs) r.signals = fresh.filter((s) => r.signalIds?.has(s.id)).length;
  }
  // A run re-read only through the overlap that yielded nothing new was already swept: drop it.
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i]?.overlapOnly && runs[i]?.signals === 0) runs.splice(i, 1);

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
    for (const r of fullyRead) {
      await t.exec("INSERT OR IGNORE INTO friction_swept_runs (run_key, run_instant, sweep_key, swept_at) VALUES (?, ?, ?, ?)", [
        r.key,
        r.instant,
        sweepKey,
        at,
      ]);
    }
    // Prune ledger rows the next sweep's read window can no longer reach.
    const horizon = new Date(Date.parse(windowEnd) - SWEEP_OVERLAP_MS).toISOString();
    await t.exec("DELETE FROM friction_swept_runs WHERE run_instant <= ?", [horizon]);
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
  /** The digest signal-group fingerprints this finding covers; the filer recounts them host-side. */
  signalFingerprints?: string[];
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
      signalFingerprints: Array.isArray(item.signalFingerprints)
        ? item.signalFingerprints.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
        : [],
    });
  }
  return { findings, malformed };
}

export interface FileDeps {
  github: FrictionGithub;
  config: FrictionConfig;
  window: { start: string; end: string };
  /** Host-side recount of the persisted signals behind `signalFingerprints` (this sweep's
   *  `friction_signals`): occurrences = matching rows, runs = distinct `run_key`. The filing threshold
   *  uses the SMALLER of this and the analyst's figure, so an inflated agent count never files. */
  observed: (signalFingerprints: readonly string[]) => { occurrences: number; runs: number };
  /** Whether this sweep still holds the singleton lease. Re-checked immediately before EVERY GitHub
   *  write: an expired holder whose successor took over must not file too (duplicate issues). */
  leaseHeld: () => boolean;
  /** Host-built evidence links (the `run_url` of each persisted signal behind `signalFingerprints`),
   *  deduplicated — appended to every issue body / recurrence comment, never left to the analyst. */
  evidenceLinks: (signalFingerprints: readonly string[]) => string[];
}

/** Thrown when the sweep lost its lease mid-filing: the worker stops and reports `failed`. */
export class LeaseLostError extends Error {}

/** Cap on host-built evidence links per issue/comment. */
export const MAX_EVIDENCE_LINKS = 10;

/** The distinct `run_url`s of this sweep's signals behind `signalFingerprints` (capped). */
export function signalRunUrls(data: DataLayer, sweepKey: string, signalFingerprints: readonly string[]): string[] {
  const fps = [...new Set(signalFingerprints)].slice(0, 200);
  if (sweepKey === "" || fps.length === 0) return [];
  return data
    .source()
    .db.all<{ u: string }>(
      `SELECT DISTINCT run_url AS u FROM friction_signals WHERE sweep_key = ? AND fingerprint IN (${fps.map(() => "?").join(", ")}) AND run_url IS NOT NULL AND run_url <> '' ORDER BY run_url LIMIT ?`,
      [sweepKey, ...fps, MAX_EVIDENCE_LINKS],
    )
    .map((r) => String(r.u));
}

/** Whether `holder` holds the sweep lease right now (unexpired). */
export function leaseHeldBy(data: DataLayer, holder: string, now: Date): boolean {
  const cur = readLease(data);
  return holder !== "" && cur?.holder === holder && !!cur.expires_at && Date.parse(cur.expires_at) > now.getTime();
}

function evidenceSection(links: readonly string[]): string[] {
  const uniq = [...new Set(links.filter((l) => /^https?:\/\//.test(l)))].slice(0, MAX_EVIDENCE_LINKS);
  return uniq.length === 0 ? [] : ["", "## Evidence runs", ...uniq.map((l) => `- ${l}`)];
}

/** Recount `signalFingerprints` from this sweep's persisted `friction_signals`. */
export function observedSignalCounts(data: DataLayer, sweepKey: string, signalFingerprints: readonly string[]): { occurrences: number; runs: number } {
  const fps = [...new Set(signalFingerprints)].slice(0, 200);
  if (sweepKey === "" || fps.length === 0) return { occurrences: 0, runs: 0 };
  const row = data
    .source()
    .db.all<{ n: number; r: number }>(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT run_key) AS r FROM friction_signals WHERE sweep_key = ? AND fingerprint IN (${fps.map(() => "?").join(", ")})`,
      [sweepKey, ...fps],
    )[0];
  return { occurrences: Number(row?.n ?? 0), runs: Number(row?.r ?? 0) };
}

export interface FileResult {
  created: string[];
  updated: string[];
  skipped: number;
}

function issueBody(f: FrictionFinding, window: { start: string; end: string }, links: readonly string[]): string {
  return redact(
    [
      fingerprintMarker(f.fingerprint),
      `**Fix surface:** ${f.fixSurface}  `,
      `**Target repo:** ${f.targetRepo}  `,
      `**Observed:** ${f.occurrences} occurrence(s) across ${f.runs} run(s), window ${window.start} → ${window.end}`,
      "",
      "## Evidence",
      f.evidence || "_(none supplied)_",
      ...evidenceSection(links),
      "",
      "## Proposed fix",
      f.proposedFix || "_(none supplied)_",
      "",
      "_Filed by the nano-workforce friction sweep (nanobpm/nano-workforce#1073)._",
    ].join("\n"),
  );
}

function recurrenceComment(f: FrictionFinding, window: { start: string; end: string }, links: readonly string[]): string {
  return redact(
    [
      `Seen again: ${f.occurrences} occurrence(s) across ${f.runs} run(s) in ${window.start} → ${window.end}.`,
      "",
      f.evidence || "_(no new evidence supplied)_",
      ...evidenceSection(links),
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
      // Sum, not max: merged findings usually cite DIFFERENT runs, and max() collapses N single-run
      // findings to 1. The sum is only an upper bound — the host recount below (COUNT DISTINCT
      // run_key) caps it to the true distinct-run figure, so shared runs never overcount.
      prev.runs += f.runs;
      prev.evidence = [prev.evidence, f.evidence].filter(Boolean).join("\n");
      prev.existingIssue = prev.existingIssue ?? f.existingIssue;
      prev.signalFingerprints = [...new Set([...(prev.signalFingerprints ?? []), ...(f.signalFingerprints ?? [])])];
    } else byFp.set(f.fingerprint, { ...f });
  }
  // Dedupe against EVERY friction issue, open or closed: a closed finding that recurs must get a
  // recurrence comment (and a reopen when it was closed as completed), never a duplicate issue.
  const openByFp = new Map<string, FrictionIssue>();
  let complete = false;
  for (let page = 1; page <= ISSUE_PAGE_CAP; page++) {
    const { issues, more } = await deps.github.listIssuesPage(deps.config.repo, FRICTION_LABEL, page);
    for (const issue of issues) {
      const fp = parseFingerprintMarker(issue.body);
      if (!fp) continue;
      const prev = openByFp.get(fp);
      // Prefer an open issue carrying the marker over a closed one.
      if (!prev || (prev.state === "closed" && issue.state !== "closed")) openByFp.set(fp, issue);
    }
    if (!more) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    throw new Error(`friction sweep: more than ${ISSUE_PAGE_CAP} pages of ${FRICTION_LABEL} issues — dedupe index incomplete, refusing to write`);
  }
  for (const f of byFp.values()) {
    // Match by fingerprint only: an agent-supplied `existingIssue` is untrusted — a stale or wrong
    // number would attach evidence to an unrelated finding and bypass the new-finding thresholds.
    const match = openByFp.get(f.fingerprint);
    // Never trust the analyst's counts alone: take the smaller of its figure and the host recount —
    // for recurrences too, and skip one the persisted signals do not support at all.
    const seen = deps.observed(f.signalFingerprints ?? []);
    f.occurrences = Math.min(f.occurrences, seen.occurrences);
    f.runs = Math.min(f.runs, seen.runs);
    if (match) {
      if (f.occurrences < 1 || f.runs < 1) {
        result.skipped++;
        continue;
      }
      if (!deps.leaseHeld()) throw new LeaseLostError("friction sweep lease lost before posting a recurrence comment");
      await deps.github.comment(deps.config.repo, match.number, recurrenceComment(f, deps.window, deps.evidenceLinks(f.signalFingerprints ?? [])));
      // A fix that was shipped (closed as completed) has regressed → reopen. Never reopen a
      // `not_planned` close: the operator decided not to act; the comment records the recurrence.
      if (match.state === "closed" && match.stateReason === "completed") {
        if (!deps.leaseHeld()) throw new LeaseLostError("friction sweep lease lost before reopening an issue");
        await deps.github.reopen(deps.config.repo, match.number);
      }
      result.updated.push(match.url || `https://github.com/${deps.config.repo}/issues/${match.number}`);
      continue;
    }
    if (f.occurrences < deps.config.minOccurrences || f.runs < deps.config.minRuns) {
      result.skipped++;
      continue;
    }
    if (!deps.leaseHeld()) throw new LeaseLostError("friction sweep lease lost before creating an issue");
    const made = await deps.github.createIssue(deps.config.repo, {
      title: redact(f.title).slice(0, 200),
      body: issueBody(f, deps.window, deps.evidenceLinks(f.signalFingerprints ?? [])),
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
  // One row per issue link so the Friction page can render each as a clickable grid link (detail
  // fields are plain text). Idempotent: a redelivered record writes the same keys.
  const db = data.source().db;
  for (const [action, urls] of [["opened", res.created], ["updated", res.updated]] as const) {
    for (const url of urls) {
      db.run("INSERT OR IGNORE INTO friction_filings (sweep_key, action, issue_url, created_at) VALUES (?, ?, ?, ?)", [sweepKey, action, url, at]);
    }
  }
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
 *  the ONE renderer of the summary wording (the form itself is static and links the Friction page). */
export function frictionSweepSummary(row: FrictionSweepRow, baseUrl: string): string {
  const split = (v: string | null) => (v ? v.split("\n").filter((s) => s !== "") : []);
  return summaryMarkdown(row, { created: split(row.created_issues), updated: split(row.updated_issues), skipped: row.skipped_count }, baseUrl);
}

/** Pure: a navigable GitHub link for an escalation subject key (`owner/repo#N`), or null. GitHub
 *  redirects `/issues/N` to the PR when N is a PR, so one form covers PR and feature subjects. */
export function escalationSubjectUrl(subject: string | null): string | null {
  const p = parsePr(subject);
  return p ? `https://github.com/${p.repo}/issues/${p.number}` : null;
}

/** The summary task's auto-close window (the `PT24H` boundary in friction-sweep.bpmn) plus slack. */
export const FRICTION_SUMMARY_SCAN_MS = 48 * 60 * 60 * 1000;

/** Pure: whether a sweep row can still hold an open summary task — filed within the scan window. The
 *  bpmn boundary auto-closes it 24h after filing, so older sweeps need no engine round trip. */
export function frictionSummaryMayBeOpen(row: Pick<FrictionSweepRow, "status" | "updated_at">, nowIso: string): boolean {
  if (row.status !== "filed") return false;
  // Measured from FILING (`updated_at`, stamped by recordFiled), not window_end: a slow analyst may
  // file long after collection, and the 24h boundary starts at filing.
  const end = Date.parse(row.updated_at);
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
  await frictionSweeps(data).update(sweepKey, { status: "failed", error: redact(`failed: ${error}`).slice(0, 2000), updated_at: now.toISOString() });
}
