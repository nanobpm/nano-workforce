// npm run reconcile:contracts — the contract reconciliation pass runner (issue #227, ADR 0004).
//
// A sibling to the L2 retro: read the whole blackboard (`agentic_blackboard`) plus the durable
// contract registry (`app/contracts.ts`) and report synonyms / contradictions / mock-vs-real skew.
// Advisory by design — it PRINTS a report (an escalation / merge candidate) and exits 0, so it can
// run periodically without gating CI. The registry-only, mechanically-enforceable half is the hard
// gate `scripts/check-contracts.ts`; this pass adds the blackboard-vs-registry view.
//
// It reads the app sqlite datasource (NANO_APP_DB_URL, default `file:./app.db`) directly through
// node:sqlite. If the datasource or the blackboard table is absent, it still runs the static
// registry reconciliation.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BLACKBOARD_TABLE } from "@nanobpm/agentic/blackboard";
import {
  type ContractSignal,
  formatReconciliationReport,
  reconcileContracts,
} from "../app/contractReconcile.ts";
import type { ContractCategory } from "../app/contracts.ts";

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // Advisory-only pass: a malformed %-escape in NANO_APP_DB_URL must never fail the build. Fall
    // back to the raw segment so reconciliation still runs (worst case: the file simply isn't found).
    return s;
  }
}

export function fileUrlToPath(u: string): string | undefined {
  if (!u.startsWith("file:")) return undefined;
  if (u.startsWith("file://")) {
    let pathname: string;
    try {
      pathname = new URL(u).pathname;
    } catch {
      // Advisory-only pass: a malformed file:// URL must never fail the build. Give up on this
      // input (worst case the file simply isn't found) rather than throwing out of reconciliation.
      return undefined;
    }
    const p = safeDecodeURIComponent(pathname);
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
  }
  const p = safeDecodeURIComponent(u.slice("file:".length));
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
}

function parseRef(dedupeKey: string | null): { category?: ContractCategory; name?: string } {
  if (!dedupeKey) return {};
  const idx = dedupeKey.indexOf(":");
  if (idx <= 0) return {};
  const category = dedupeKey.slice(0, idx).trim();
  const name = dedupeKey.slice(idx + 1).trim();
  if (!name) return {};
  if (category === "env" || category === "wire" || category === "type" || category === "capability-url") {
    return { category, name };
  }
  return {};
}

function loadSignals(): ContractSignal[] {
  const url = process.env.NANO_APP_DB_URL ?? "file:./app.db";
  const path = fileUrlToPath(url);
  if (!path || !existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // biome-ignore lint/plugin: external node:sqlite row shape at the DB boundary — the column list is fixed by the SELECT above.
    const rows = db
      .prepare(
        `SELECT author_task, body, dedupe_key FROM ${BLACKBOARD_TABLE} WHERE kind = 'contract' ORDER BY id ASC`,
      )
      .all() as { author_task: string; body: string; dedupe_key: string | null }[];
    return rows.map((r) => ({ authorTask: r.author_task, body: r.body, ...parseRef(r.dedupe_key) }));
  } catch {
    // No blackboard table (bare/unmigrated db) — reconcile the registry alone.
    return [];
  } finally {
    db.close();
  }
}

function main(): void {
  const report = reconcileContracts(loadSignals());
  console.log(formatReconciliationReport(report));
  // Advisory: never fail the build. The hard, registry-only gate is `npm run check:contracts`.
}

if (import.meta.main) main();
