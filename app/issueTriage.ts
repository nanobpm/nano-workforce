// Issue triage (issue #896) — an opt-in, timer-driven loop that labels untriaged GitHub issues.
//
// The `issue-triage` process (resources/processes/issue-triage.bpmn) starts on a repeating TIMER start
// event (liveness modelled in the process, not the poller). Each tick:
//   1. `pr.issue-triage-collect` (app-side) — no-ops unless NANO_ISSUE_TRIAGE is on; otherwise collects up
//      to NANO_ISSUE_TRIAGE_MAX_ISSUES open, UNLABELLED, not-yet-triaged issues per configured repo.
//   2. `senior:issue-triage` (external agent) — returns PROPOSALS ONLY, as data (`IssueTriageProposal`).
//   3. `pr.issue-triage-apply` (app-side) — validates each proposal HERE (this module) and applies the
//      confident ones with the app's own GitHub credential; low-confidence ones are parked for a human.
//   4. `issue-triage-review` (human user task) — one batched decision per tick: apply or skip the parked
//      proposals; `pr.issue-triage-review` carries it out (re-validated against the repo's live labels).
//
// SECURITY MODEL: the agent never needs a write credential for triage — its output is untrusted data and
// every write is gated by the pure, fail-closed validation below (claim fence, label allowlist, deny
// list, cap, confidence threshold). Every decision is recorded in `issue_triage_decisions`, which also
// keeps an issue from being re-triaged on later ticks.
//
// This module owns the constants, the env readers, the ONE validation derivation and the ledger table.
// It deliberately imports nothing from the user-task / completion modules (they import it) so it can't
// form an import cycle.
import type { DataLayer } from "@nanobpm/urban";
import { readEnvOr } from "./contracts.ts";

export const ISSUE_TRIAGE_PROCESS_ID = "issue-triage";
export const ISSUE_TRIAGE_JOB_TYPE = "senior:issue-triage";

/** The batched human review user task (issue-triage.bpmn). HUMAN-only: never agent-answerable (so the
 *  escalation steward can never auto-approve label writes the confidence gate held back). */
export const ISSUE_TRIAGE_REVIEW_ELEMENT = "issue-triage-review";

/** Labels the triage loop must never apply, whatever the agent proposes — they drive workforce intake
 *  (`queued`/`dequeued`) or are otherwise workflow-significant. Compared case-insensitively. */
export const DENIED_LABELS: ReadonlySet<string> = new Set(["queued", "dequeued"]);

/** At most this many labels are applied to one issue per tick. Extra proposed labels are dropped. */
export const MAX_LABELS_PER_ISSUE = 3;

/** Proposals below this confidence are parked for human review instead of applied. */
export const MIN_AUTO_APPLY_CONFIDENCE = 0.7;

/** Body text handed to the agent is truncated to this many characters (bounds prompt size). */
export const MAX_BODY_CHARS = 4000;

// ── Env ──────────────────────────────────────────────────────────────────────────────────────────

/** Whether the triage loop is enabled. OFF unless explicitly turned on. */
export function issueTriageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(readEnvOr("NANO_ISSUE_TRIAGE", "off", env));
}

/** The configured `owner/repo` list (blank/duplicate entries dropped, order preserved). */
export function issueTriageRepos(env: Record<string, string | undefined> = process.env): string[] {
  const seen = new Set<string>();
  for (const part of readEnvOr("NANO_ISSUE_TRIAGE_REPOS", "", env).split(",")) {
    const repo = part.trim();
    if (repo !== "") seen.add(repo);
  }
  return [...seen];
}

/** The per-repo per-tick issue cap: a positive integer, clamped to [1, 100]; malformed → 20. */
export function issueTriageMaxIssues(env: Record<string, string | undefined> = process.env): number {
  const n = Number(readEnvOr("NANO_ISSUE_TRIAGE_MAX_ISSUES", "20", env));
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(100, Math.floor(n));
}

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────

/** One issue handed to the agent (serialised as a JSON string per entry on the job). `labels` is the
 *  repo's APPLICABLE label set (repo labels minus the deny list) — the only names the agent may pick. */
export interface TriageCandidate {
  repo: string;
  issue: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

/** The agent's proposed classification of one issue (registered in app/contracts.ts TYPE_CONTRACTS;
 *  the planned pre-plan classifier gate #242 reuses this shape). */
export interface IssueTriageProposal {
  repo: string;
  issue: number;
  labels: string[];
  /** 0..1 — the agent's confidence in the label set as a whole. */
  confidence: number;
  rationale: string;
  /** `owner/repo#N` of an existing issue this one duplicates, if the agent believes so (advisory —
   *  recorded and shown to a human, never acted on automatically). */
  duplicateOf?: string;
}

/** The host's verdict on one proposal. */
export type TriageVerdict =
  | { action: "apply"; labels: string[]; dropped: string[] }
  | { action: "escalate"; labels: string[]; dropped: string[]; reason: string }
  | { action: "reject"; reason: string };

const triageKey = (repo: string, issue: number) => `${repo}#${issue}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse the agent's `proposals` output (a JSON string encoding an array — the job envelope carries
 *  lists as serialised strings). FAIL-CLOSED: anything unparseable yields `[]`, and each malformed
 *  entry is skipped (never throws, so one bad entry can't incident the apply task). */
export function parseProposals(raw: unknown): IssueTriageProposal[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: IssueTriageProposal[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { repo, issue, labels, confidence, rationale, duplicateOf } = entry;
    if (typeof repo !== "string" || !Number.isInteger(issue) || typeof issue !== "number") continue;
    if (!Array.isArray(labels) || typeof confidence !== "number" || !Number.isFinite(confidence)) continue;
    out.push({
      repo,
      issue,
      labels: labels.filter((l): l is string => typeof l === "string"),
      confidence: Math.max(0, Math.min(1, confidence)),
      rationale: typeof rationale === "string" ? rationale.slice(0, 500) : "",
      ...(typeof duplicateOf === "string" && duplicateOf.trim() !== "" ? { duplicateOf: duplicateOf.trim().slice(0, 200) } : {}),
    });
  }
  return out;
}

/** Parse the collect step's `candidates` (an array of JSON strings, or one JSON string of an array). */
export function parseCandidates(raw: unknown): TriageCandidate[] {
  const items: unknown[] = typeof raw === "string" ? safeParseArray(raw) : Array.isArray(raw) ? raw : [];
  const out: TriageCandidate[] = [];
  for (const item of items) {
    const v: unknown = typeof item === "string" ? safeParse(item) : item;
    if (!isRecord(v)) continue;
    if (typeof v.repo !== "string" || typeof v.issue !== "number" || !Array.isArray(v.labels)) continue;
    out.push({
      repo: v.repo,
      issue: v.issue,
      title: typeof v.title === "string" ? v.title : "",
      body: typeof v.body === "string" ? v.body : "",
      url: typeof v.url === "string" ? v.url : "",
      labels: v.labels.filter((l): l is string => typeof l === "string"),
    });
  }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function safeParseArray(s: string): unknown[] {
  const v = safeParse(s);
  return Array.isArray(v) ? v : [];
}

/** The applicable label set for a repo: its labels minus the deny list (case-insensitive). */
export function applicableLabels(repoLabels: readonly string[]): string[] {
  return repoLabels.filter((l) => !DENIED_LABELS.has(l.toLowerCase()));
}

/** THE validation derivation (pure, fail-closed). A proposal is applied only when it targets an issue
 *  this tick actually claimed, names only labels the repo really has (and that aren't denied), and is
 *  confident enough. `allowed` is the repo's live applicable label set; label matching is
 *  case-insensitive but the repo's own spelling is what gets written. */
export function validateProposal(
  proposal: IssueTriageProposal,
  claimed: ReadonlySet<string>,
  allowed: readonly string[],
  minConfidence: number = MIN_AUTO_APPLY_CONFIDENCE,
): TriageVerdict {
  if (!claimed.has(triageKey(proposal.repo, proposal.issue))) {
    return { action: "reject", reason: "issue was not claimed by this triage run" };
  }
  const byLower = new Map(allowed.filter((l) => !DENIED_LABELS.has(l.toLowerCase())).map((l) => [l.toLowerCase(), l]));
  const labels: string[] = [];
  const dropped: string[] = [];
  for (const proposed of proposal.labels) {
    const real = byLower.get(proposed.trim().toLowerCase());
    if (real === undefined || labels.includes(real)) {
      dropped.push(proposed);
      continue;
    }
    if (labels.length >= MAX_LABELS_PER_ISSUE) {
      dropped.push(proposed);
      continue;
    }
    labels.push(real);
  }
  if (labels.length === 0) return { action: "reject", reason: "no applicable labels proposed" };
  if (proposal.confidence < minConfidence) {
    return { action: "escalate", labels, dropped, reason: `confidence ${proposal.confidence.toFixed(2)} below ${minConfidence}` };
  }
  return { action: "apply", labels, dropped };
}

// ── Ledger ───────────────────────────────────────────────────────────────────────────────────────

/** `applied` — labels written; `escalated` — parked for the human review task; `skipped` — the human
 *  chose not to apply; `rejected` — the proposal failed validation (or the agent proposed nothing);
 *  `failed` — the label write itself failed. Every status excludes the issue from later ticks except
 *  `failed`, which is retried. */
export type TriageStatus = "applied" | "escalated" | "skipped" | "rejected" | "failed";

export interface IssueTriageDecision extends Record<string, unknown> {
  triage_key: string;
  repo: string;
  issue_number: number;
  title: string | null;
  url: string | null;
  status: TriageStatus;
  /** JSON array of the labels applied (or, for `escalated`, the labels awaiting review). */
  labels: string;
  confidence: number | null;
  rationale: string | null;
  duplicate_of: string | null;
  reason: string | null;
  process_key: string | null;
  created_at: string;
  updated_at: string;
}

export const issueTriageDecisions = (data: DataLayer) => data.table<IssueTriageDecision>("issue_triage_decisions", "triage_key");

/** Keys (`owner/repo#N`) of issues already decided — excluded from collection. `failed` writes are
 *  retried, so they are NOT in the set. */
export async function decidedTriageKeys(data: DataLayer): Promise<Set<string>> {
  const rows = await issueTriageDecisions(data).all();
  return new Set(rows.filter((r) => r.status !== "failed").map((r) => r.triage_key));
}

/** Upsert one decision (idempotent on `owner/repo#N`, so a job retry overwrites in place). */
export async function recordTriageDecision(
  data: DataLayer,
  d: { repo: string; issue: number; title?: string | null; url?: string | null; status: TriageStatus; labels: string[]; confidence?: number | null; rationale?: string | null; duplicateOf?: string | null; reason?: string | null; processKey?: string | null },
): Promise<void> {
  const key = triageKey(d.repo, d.issue);
  const ts = new Date().toISOString();
  const fields = {
    repo: d.repo,
    issue_number: d.issue,
    title: d.title ?? null,
    url: d.url ?? null,
    status: d.status,
    labels: JSON.stringify(d.labels),
    confidence: d.confidence ?? null,
    rationale: d.rationale ?? null,
    duplicate_of: d.duplicateOf ?? null,
    reason: d.reason ?? null,
    process_key: d.processKey ?? null,
    updated_at: ts,
  };
  const tbl = issueTriageDecisions(data);
  if (await tbl.get(key)) await tbl.update(key, fields);
  else await tbl.insert({ triage_key: key, created_at: ts, ...fields });
}

/** The escalated (awaiting-review) decisions parked by one triage instance. */
export async function escalatedForInstance(data: DataLayer, processKey: string): Promise<IssueTriageDecision[]> {
  return (await issueTriageDecisions(data).find({ process_key: processKey })).filter((r) => r.status === "escalated");
}

/** The batched review question shown in the Tasks inbox for one parked triage instance. */
export function triageReviewQuestion(rows: readonly IssueTriageDecision[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map((r) => {
    const labels = safeParseArray(r.labels).filter((l): l is string => typeof l === "string").join(", ");
    const conf = typeof r.confidence === "number" ? ` (confidence ${r.confidence.toFixed(2)})` : "";
    const dup = r.duplicate_of ? ` — possible duplicate of ${r.duplicate_of}` : "";
    const why = r.rationale ? `: ${r.rationale}` : "";
    return `- ${r.repo}#${r.issue_number} ${r.title ?? ""} → [${labels}]${conf}${dup}${why}`;
  });
  return `Low-confidence label proposals (${rows.length}). Apply all, or skip all:\n${lines.join("\n")}`;
}
