// release-gate — decide whether the Release workflow may ship `main`'s commit (issue #1085).
//
// WHY: the previous gate read `commits/$SHA/check-runs` and took the newest result per name. On
// `main` the landed commit is the SAME SHA the merge queue built, so the queue's `merge_group`
// success already sits on it — a gate that fires before main's own CI has registered could
// release on the queue's result alone. This gate looks ONLY at jobs of workflow runs for the SHA
// whose event is `push` (main's own runs). A `merge_group` result can never satisfy it, and a
// missing push run counts as pending — except for a manual `workflow_dispatch`, which falls back
// to the SHA's `merge_group` jobs ONLY when no push run exists at all (the #722/#723 recovery).
//
// USAGE (in release.yml):
//   node --experimental-strip-types scripts/release-gate.ts <owner/repo> <sha>
// Prints `should_release=true|false` to stdout (append to $GITHUB_OUTPUT) and a markdown
// decision to $GITHUB_STEP_SUMMARY when set.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Required checks: the `main` ruleset's required set minus PR-only `Conventional PR title`. */
export const REQUIRED_CHECKS: readonly string[] = ["typecheck + test (Node)", "whole-repo invariants"];

export interface GateJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GateRun {
  id: number;
  event: string;
  head_sha: string;
  run_attempt?: number;
  jobs: GateJob[];
}

export interface CheckResult {
  name: string;
  /** `success`, a failing conclusion, `pending` (in flight), or `missing` (no push run yet). */
  state: string;
}

export interface GateDecision {
  release: boolean;
  checks: CheckResult[];
  /** Which run event the decision was read from (`merge_group` only via the dispatch fallback). */
  source?: string;
}

/**
 * Pure gate logic. Considers only runs with `event === "push"` for `sha`; per required check
 * name the latest job (max job id — a re-run attempt always gets a newer job id) wins.
 */
export function decideGate(
  sha: string,
  runs: readonly GateRun[],
  required: readonly string[] = REQUIRED_CHECKS,
  opts: { mergeGroupFallback?: boolean } = {},
): GateDecision {
  // Manual-recovery fallback (workflow_dispatch only): when the SHA has NO push run at all — the
  // #722/#723 dropped-`push:main` wedge — a human-dispatched gate may count the `merge_group` jobs
  // the queue attached to this exact SHA. Never used while any push run exists (push is
  // authoritative), and never for the automatic workflow_run/schedule triggers.
  const hasPush = runs.some((r) => r.event === "push" && r.head_sha === sha);
  const event = !hasPush && opts.mergeGroupFallback === true ? "merge_group" : "push";
  const latest = new Map<string, GateJob>();
  for (const run of runs) {
    if (run.event !== event || run.head_sha !== sha) continue;
    for (const job of run.jobs) {
      const prev = latest.get(job.name);
      if (prev === undefined || job.id > prev.id) latest.set(job.name, job);
    }
  }
  const checks = required.map((name): CheckResult => {
    const job = latest.get(name);
    if (job === undefined) return { name, state: "missing" };
    if (job.status !== "completed" || job.conclusion === null) return { name, state: "pending" };
    return { name, state: job.conclusion };
  });
  return { release: checks.every((c) => c.state === "success"), checks, source: event };
}

export function renderSummary(sha: string, d: GateDecision): string {
  const head = d.release
    ? `### ✅ Release gate: all required push checks green for \`${sha}\` — proceeding to semantic-release`
    : `### ⏸️ Release gate: NOT releasing \`${sha}\` — waiting on ${d.checks
        .filter((c) => c.state !== "success")
        .map((c) => `\`${c.name}\` (${c.state})`)
        .join(", ")}`;
  const rows = d.checks.map((c) => `| ${c.name} | ${c.state} |`).join("\n");
  const note =
    d.source === "merge_group"
      ? "Manual dispatch fallback: no `push` run exists for this SHA, so its merge-queue (`merge_group`) results were used."
      : "Only `push` runs on `main` count; merge-queue (`merge_group`) results are ignored.";
  return `${head}\n\n${note}\n\n| check | state (${d.source ?? "push"} run) |\n|---|---|\n${rows}\n`;
}

function ghJson(path: string): unknown[] {
  // `--slurp` wraps every page into one JSON array (no `--jq`, which gh rejects alongside it).
  const out = execFileSync("gh", ["api", "--paginate", "--slurp", path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const pages: unknown = JSON.parse(out);
  return Array.isArray(pages) ? pages : [pages];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function listOf(pages: unknown[], key: string): Record<string, unknown>[] {
  const all: Record<string, unknown>[] = [];
  for (const p of pages) {
    const arr = isRecord(p) ? p[key] : undefined;
    if (Array.isArray(arr)) for (const x of arr) if (isRecord(x)) all.push(x);
  }
  return all;
}

export function fetchRuns(repo: string, sha: string, event: string): GateRun[] {
  const runs = listOf(ghJson(`repos/${repo}/actions/runs?head_sha=${sha}&event=${event}&per_page=100`), "workflow_runs");
  return runs.map((r): GateRun => {
    const id = Number(r.id);
    const jobs = listOf(ghJson(`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`), "jobs").map(
      (j): GateJob => ({
        id: Number(j.id),
        name: String(j.name),
        status: String(j.status),
        conclusion: typeof j.conclusion === "string" ? j.conclusion : null,
      }),
    );
    return { id, event: String(r.event), head_sha: String(r.head_sha), jobs };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [repo, sha] = process.argv.slice(2);
  if (!repo || !sha) {
    console.error("usage: release-gate.ts <owner/repo> <sha>");
    process.exit(2);
  }
  const fallback = process.env.EVENT === "workflow_dispatch";
  const runs = fetchRuns(repo, sha, "push");
  if (fallback && runs.length === 0) runs.push(...fetchRuns(repo, sha, "merge_group"));
  const d = decideGate(sha, runs, REQUIRED_CHECKS, { mergeGroupFallback: fallback });
  for (const c of d.checks) console.error(`gate: '${c.name}' = ${c.state}`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, renderSummary(sha, d));
  console.log(`should_release=${d.release}`);
}
