// PR round + escalation history read model (issue #668, N4 of epic #664).
//
// "Why did this PR escalate?" / "what happened in prior rounds?" lives in the `rounds` and
// `escalations` tables — the SAME two tables the Convergence page (`pages/home.page.json`, the PR
// detail's "Rounds" and "Escalations" child grids) reads directly. Until now the only way to answer
// those questions off the UI was to ssh into the instance and query the DB by hand. This module is
// the ONE canonical reader over those tables so an MCP read tool (`getPrHistory`) can surface the
// same history without DB access.
//
// Derivation over duplication (AGENTS.md): this does NOT introduce a new projection table or a
// second source of truth. The Convergence page's "query" is declarative datasource JSON over the
// `rounds`/`escalations` tables (ordered rounds-by-round_no, escalations-by-id); this function reads
// those exact tables with the exact same orderings, so the tool and the page cannot drift onto
// different data.
import type { DataLayer } from "@nanobpm/urban";

/** A `rounds` row — the per-round convergence record the Convergence page's "Rounds" grid reads. */
interface RoundRow {
  id: number;
  pr_key: string;
  round_no: number;
  status: string | null;
  summary: string | null;
  worker: string | null;
  started_at: string;
  ended_at: string | null;
}

/** An `escalations` row — the escalation record the Convergence page's "Escalations" grid reads. */
interface EscalationRow {
  id: number;
  pr_key: string;
  round_no: number;
  kind: string;
  question: string;
  answer: string | null;
  status: string;
  worker: string | null;
  asked_at: string;
  answered_at: string | null;
}

/** The subset of a `pull_requests` row this module needs to resolve a processKey → prKey. */
interface PrKeyRow {
  pr_key: string;
  process_key: string | null;
}

/** One round in a PR's timeline: its status transition/outcome, owning worker, and timestamps. */
export interface PrHistoryRound {
  roundNo: number;
  status: string | null;
  worker: string | null;
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** One escalation in a PR's history: its kind, question/answer, status, and timestamps. */
export interface PrHistoryEscalation {
  roundNo: number;
  kind: string;
  worker: string | null;
  question: string;
  answer: string | null;
  status: string;
  askedAt: string;
  answeredAt: string | null;
}

/** A PR's full escalation + round history, as surfaced by the Convergence page's PR detail. */
export interface PrHistory {
  prKey: string;
  rounds: PrHistoryRound[];
  escalations: PrHistoryEscalation[];
}

const rounds = (data: DataLayer) => data.table<RoundRow>("rounds", "id");
const escs = (data: DataLayer) => data.table<EscalationRow>("escalations", "id");
const prs = (data: DataLayer) => data.table<PrKeyRow>("pull_requests", "pr_key");

/** Resolve an engine process-instance key to the PR it drives (unique per instance), or null. */
export async function prKeyForProcess(data: DataLayer, processKey: string): Promise<string | null> {
  const matches = await prs(data).find({ process_key: processKey });
  return matches[0]?.pr_key ?? null;
}

/** The canonical PR history read: rounds (round_no asc) + escalations (id asc, i.e. asked order) for
 * one PR, projected to the wire shape. An unknown `prKey` yields an empty history (no throw), so a
 * caller can distinguish "no history yet" from an error without a 404 round-trip. */
export async function prHistory(data: DataLayer, prKey: string): Promise<PrHistory> {
  const roundRows = (await rounds(data).find({ pr_key: prKey })).sort(
    (a, b) => a.round_no - b.round_no || a.id - b.id,
  );
  const escRows = (await escs(data).find({ pr_key: prKey })).sort((a, b) => a.id - b.id);
  return {
    prKey,
    rounds: roundRows.map((r) => ({
      roundNo: r.round_no,
      status: r.status ?? null,
      worker: r.worker ?? null,
      summary: r.summary ?? null,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? null,
    })),
    escalations: escRows.map((e) => ({
      roundNo: e.round_no,
      kind: e.kind,
      worker: e.worker ?? null,
      question: e.question,
      answer: e.answer ?? null,
      status: e.status,
      askedAt: e.asked_at,
      answeredAt: e.answered_at ?? null,
    })),
  };
}
