// Per-repo merge protocol (issue #43).
//
// Merlin's merge stage was repo-blind: it ran a plain `gh pr merge` and, on refusal, escalated to
// a human. That breaks on any repo with a frugal-CI + on-demand-queue posture — e.g.
// `Magikcraft/nano-bpm`, where auto-merge is OFF, CI runs only on `opened` (review-fix pushes do
// NOT re-run it), and the documented way to land is: produce a fresh head run (`gh pr ready` /
// close+reopen) → wait for it to go green → `@mergifyio queue`. See that repo's
// `AGENTS.md → ## Merging PRs`.
//
// This module lets a target repo PUBLISH its landing protocol in a form Merlin can execute
// deterministically. Discovery order (first hit wins):
//   1. a fenced ```merge-protocol JSON block inside the repo's `AGENTS.md` (preferred — the human
//      doc and the machine descriptor live together and can't drift), else
//   2. `.github/merge-protocol.json`.
// A repo that publishes neither keeps today's behaviour (DEFAULT_MERGE_PROTOCOL).

import { classifyEscalation, type EscalationDisposition } from "./escalationTaxonomy.ts";
import { fetchRepoFile } from "./github.ts";

/** How to give branch protection a fresh head `pull_request` run before landing. `none` = the
 * repo re-runs CI on every push, so no synthetic run is needed. `ready` = mark a draft ready
 * (`gh pr ready`). `reopen` = close+reopen. `ready-or-reopen` = ready when the PR is a draft,
 * otherwise reopen. */
export type FreshHeadRun = "none" | "ready" | "reopen" | "ready-or-reopen";

/** How to actually land the PR once its head checks are green. `gh-merge` = `gh pr merge`.
 * `admin` = `gh pr merge --admin` (bypass required checks). `mergify-queue` = post the enqueue
 * comment (`land.comment`, default `@mergifyio queue`) and wait for the queue to land it.
 * `ui` = a human clicks Merge (Merlin can't do it → escalate). */
export type LandMethod = "gh-merge" | "admin" | "mergify-queue" | "ui";

/** One required status check a repo declares in its merge protocol. `name` is the check-run /
 * status-context name exactly as GitHub reports it in the head `statusCheckRollup`.
 * `acceptedConclusions` are the conclusions that count as satisfied (default `["success"]`); a
 * change-gated check that is skipped for irrelevant PRs also lists `"skipped"` so a skip counts
 * as satisfied (required-when-run, skip-tolerant). */
export interface RequiredCheck {
  name: string;
  acceptedConclusions: string[];
}

export interface MergeProtocol {
  /** Does the repo auto-merge a PR once its checks go green? (Informational; Merlin never relies
   * on auto-merge — it lands deliberately.) */
  autoMerge: boolean;
  /** Whether/how to produce a fresh head CI run before landing. */
  freshHeadRun: FreshHeadRun;
  /** Wait for the head run to go green before landing (the poller does this anyway). */
  waitForChecks: boolean;
  /** How to land the PR. */
  land: { method: LandMethod; comment?: string };
  /** The checks that gate the merge. A repo publishing these lets the fresh-head-run remedy judge
   * "is the required CI run present on the head?" by *these* checks — not by total rollup length,
   * which an unrelated always-on check (e.g. Mergify's "Merge Queue") would otherwise satisfy. */
  requiredChecks: RequiredCheck[];
  /** Pointer to the human doc, for escalation messages. */
  doc?: string;
}

/** Absent-descriptor behaviour = exactly what Merlin did before #43: no synthetic head run, a
 * direct `gh pr merge`. Opting in is purely additive. */
export const DEFAULT_MERGE_PROTOCOL: MergeProtocol = {
  autoMerge: true,
  freshHeadRun: "none",
  waitForChecks: false,
  land: { method: "gh-merge" },
  requiredChecks: [],
};

/** Classify a repo's landing method against the canonical escalation taxonomy. A `ui` land
 * method is a `decision-required` escalation (only a human can click Merge); every
 * machine-landable method (gh-merge / admin / mergify-queue) is `transient` — the merge stage
 * lands it in-process without paging a human. Delegates to {@link classifyEscalation} so the
 * merge worker shares one source of truth with every other raise site. */
export function classifyMergeLanding(protocol: MergeProtocol): EscalationDisposition {
  return classifyEscalation({ kind: "merge-protocol", landMethod: protocol.land.method });
}

const FRESH_HEAD_RUNS: ReadonlySet<string> = new Set(["none", "ready", "reopen", "ready-or-reopen"]);
const LAND_METHODS: ReadonlySet<string> = new Set(["gh-merge", "admin", "mergify-queue", "ui"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}
/** Parse `requiredChecks`, tolerating both the rich object shape (`{ name, acceptedConclusions }`)
 * and a bare list of check names (each → `{ name, acceptedConclusions: ["success"] }`). Entries
 * without a usable `name` are dropped. Total — never throws. */
function requiredCheckArray(v: unknown): RequiredCheck[] {
  if (!Array.isArray(v)) return [];
  const out: RequiredCheck[] = [];
  for (const entry of v) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name === "") continue;
      out.push({ name, acceptedConclusions: ["success"] });
      continue;
    }
    if (!isRecord(entry)) continue;
    const name = str(entry.name)?.trim();
    if (name === undefined || name === "") continue;
    const accepted = strArray(entry.acceptedConclusions);
    out.push({
      name,
      acceptedConclusions: accepted && accepted.length > 0 ? accepted : ["success"],
    });
  }
  return out;
}
function oneOf<T extends string>(v: unknown, allowed: ReadonlySet<string>): T | undefined {
  const s = str(v);
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  return s !== undefined && allowed.has(s) ? (s as T) : undefined;
}

/** Narrow arbitrary parsed JSON onto a MergeProtocol, defaulting every missing/invalid field.
 * Never throws — an invalid descriptor degrades to the default rather than wedging the merge. */
export function parseMergeProtocol(raw: unknown): MergeProtocol {
  if (!isRecord(raw)) return { ...DEFAULT_MERGE_PROTOCOL };
  const landRaw = isRecord(raw.land) ? raw.land : {};
  const method = oneOf<LandMethod>(landRaw.method, LAND_METHODS) ?? DEFAULT_MERGE_PROTOCOL.land.method;
  const comment = str(landRaw.comment);
  return {
    autoMerge: bool(raw.autoMerge) ?? DEFAULT_MERGE_PROTOCOL.autoMerge,
    freshHeadRun: oneOf<FreshHeadRun>(raw.freshHeadRun, FRESH_HEAD_RUNS) ?? DEFAULT_MERGE_PROTOCOL.freshHeadRun,
    waitForChecks: bool(raw.waitForChecks) ?? DEFAULT_MERGE_PROTOCOL.waitForChecks,
    land: comment !== undefined ? { method, comment } : { method },
    requiredChecks: requiredCheckArray(raw.requiredChecks),
    doc: str(raw.doc),
  };
}

/** Extract the JSON body of the first ```merge-protocol fenced block in a markdown document, or
 * `null` if there is none. The info-string may carry a second word (```merge-protocol json). */
export function extractProtocolBlock(markdown: string): string | null {
  const m = markdown.match(/```merge-protocol(?:\s+\w+)?[ \t]*\r?\n([\s\S]*?)\r?\n```/);
  return m ? m[1] : null;
}

/** Strip `//` line comments so a lightly-commented (JSONC-ish) descriptor still parses. Only
 * whole-line comments are removed, to avoid mangling `//` inside a string value. */
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(stripLineComments(text));
  } catch {
    return undefined;
  }
}

// The descriptor changes rarely; cache per repo so a busy merge poller doesn't re-fetch it every
// pass. TTL keeps a mid-flight edit from being ignored for long.
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; protocol: MergeProtocol }>();

/** Clear the in-memory descriptor cache (tests). */
export function _clearMergeProtocolCache(): void {
  cache.clear();
}

/** Load a repo's merge protocol (AGENTS.md block first, then `.github/merge-protocol.json`).
 * Best-effort: any fetch/parse failure yields DEFAULT_MERGE_PROTOCOL, so a merge never wedges on
 * a missing or malformed descriptor. Results are cached per repo for a few minutes. */
export async function loadMergeProtocol(repo: string, token: string): Promise<MergeProtocol> {
  const hit = cache.get(repo);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.protocol;

  let protocol = DEFAULT_MERGE_PROTOCOL;
  try {
    const agents = await fetchRepoFile(repo, "AGENTS.md", token).catch(() => null);
    const block = agents ? extractProtocolBlock(agents) : null;
    if (block !== null) {
      protocol = parseMergeProtocol(parseJsonLoose(block));
    } else {
      const json = await fetchRepoFile(repo, ".github/merge-protocol.json", token).catch(() => null);
      if (json !== null) protocol = parseMergeProtocol(parseJsonLoose(json));
    }
  } catch {
    protocol = DEFAULT_MERGE_PROTOCOL;
  }

  cache.set(repo, { at: Date.now(), protocol });
  return protocol;
}

export interface FreshHeadRunAttempt {
  /** Current PR head commit. A rebase produces a new value, which starts a new landing attempt. */
  headRefOid?: string | null;
  /** Head commit for which this landing attempt already produced a synthetic run. */
  lastActionHeadRefOid?: string | null;
}

/** Count of the protocol's required checks currently present on the head (in any state). This is
 * the signal the fresh-head-run remedy actually wants — "has the required CI run happened?" — as
 * opposed to the raw rollup length, which an unrelated always-on check (e.g. Mergify's "Merge
 * Queue") inflates. A required check matches by exact name against the head `statusCheckRollup`. */
export function presentRequiredCheckCount(protocol: MergeProtocol, presentCheckNames: string[]): number {
  const present = new Set(presentCheckNames);
  return protocol.requiredChecks.filter((c) => present.has(c.name)).length;
}

/** The "does a head run already exist?" count to feed {@link freshHeadRunAction}. When the repo
 * declares `requiredChecks`, judge presence by *those* checks — so an incidental always-on check
 * (Mergify) never masks a genuinely-missing required run and wedges the merge. When it declares
 * none, fall back to the total rollup length (legacy behaviour, default repos unchanged). Token
 * mode (`totalChecks < 0`, checks unenumerable) stays `-1` so the remedy remains conservative and
 * never reopens blind. */
export function headRunPresenceCount(
  protocol: MergeProtocol,
  state: { totalChecks: number; presentCheckNames: string[] },
): number {
  if (state.totalChecks < 0) return -1; // token mode → unknown → conservative
  if (protocol.requiredChecks.length === 0) return state.totalChecks;
  return presentRequiredCheckCount(protocol, state.presentCheckNames);
}

/** Whether the merge poller should produce a synthetic fresh head run *now*, and how.
 *
 * Fires only when the protocol asks for a fresh run AND the PR currently has **no required head
 * run** (`headRunCount === 0`) while GitHub still reports it un-landable-but-not-conflicting
 * (`waiting`). That is exactly the frugal-CI stuck state: review converged, the last push produced
 * no run, so branch protection's required checks read as *expected* forever. `headRunCount` is the
 * required-check-aware presence count from {@link headRunPresenceCount} — NOT the raw rollup
 * length — so an incidental always-on check (e.g. Mergify's "Merge Queue") does not read as "a run
 * already exists". Once the required run is present (`headRunCount > 0`, pending or done), or this
 * same head already got its nudge, this returns `null`, so the poller never re-triggers inside one
 * landing attempt. A rebase changes `headRefOid`, so the decision is re-derived and can fire again
 * for the fresh post-rebase head. A genuinely-failing check (`blocked`) is left to the fix-ci arm,
 * a conflict (`conflict`) to the rebase arm (#42). */
export function freshHeadRunAction(
  protocol: MergeProtocol,
  verdict: "ready" | "waiting" | "conflict" | "blocked",
  headRunCount: number,
  isDraft: boolean,
  attempt: FreshHeadRunAttempt = {},
): "ready" | "reopen" | null {
  if (protocol.freshHeadRun === "none") return null;
  if (verdict !== "waiting") return null; // ready = go land; blocked/conflict = other arms
  if (headRunCount !== 0) return null; // required run already present (or unknown in token mode) → wait
  if (attempt.headRefOid && attempt.headRefOid === attempt.lastActionHeadRefOid) return null;
  switch (protocol.freshHeadRun) {
    case "ready":
      return isDraft ? "ready" : null;
    case "reopen":
      return "reopen";
    case "ready-or-reopen":
      return isDraft ? "ready" : "reopen";
    default:
      return null;
  }
}
