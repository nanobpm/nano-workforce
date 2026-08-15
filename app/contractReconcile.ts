// nano-workforce — the contract reconciliation pass (issue #227, ADR 0004).
//
// A sibling to the L2 epic retro / cross-epic pass. Where the retro distils *learnings*, this pass
// reconciles *contracts*: it reads the whole blackboard (every `contract` signal siblings posted)
// alongside the durable contract registry (`app/contracts.ts`) and flags —
//
//   - SYNONYMS: two declarations of one thing under different names (the #223 env-key failure mode),
//   - CONTRADICTIONS: one name declared with two different meanings/owners,
//   - MOCK-vs-REAL SKEW: a contract signalled in-flight on the blackboard that never landed in the
//     durable registry (a live signal with no durable truth — the pair the issue says must both hold).
//
// The pass is PURE and advisory: it returns a report. The caller (a reconciliation agent, or the CI
// check `scripts/check-contracts.ts` for the registry-only static half) decides whether to surface an
// escalation / merge candidate. Nothing here mutates the blackboard or the registry.

import {
  allContracts,
  type Contract,
  type ContractCategory,
  detectDeclarationConflicts,
  rejectedEnvSynonyms,
} from "./contracts.ts";

/** An in-flight contract signal, as posted to the blackboard `contract` kind. `category`/`name` come
 * from the `<category>:<name>` `dedupe_key` convention; `body` carries the human semantics. */
export interface ContractSignal {
  readonly authorTask: string;
  readonly category?: ContractCategory;
  readonly name?: string;
  readonly body: string;
}

/** One reconciliation finding. */
export interface ReconciliationFinding {
  readonly kind: "synonym" | "contradiction" | "rejected-synonym" | "mock-vs-real-skew";
  readonly detail: string;
  /** The contract name(s) the finding concerns. */
  readonly names: string[];
  /** Whoever raised the divergence, when known (a blackboard author, or "registry" for a static one). */
  readonly source: string;
}

export interface ReconciliationReport {
  readonly findings: ReconciliationFinding[];
  /** Convenience: true when there is nothing to reconcile (findings is empty). */
  readonly clean: boolean;
}

/** Reconcile the durable registry against itself (the static half): synonyms among registry entries
 * of one category, and any rejected synonym that somehow re-entered the registry. Used both by the
 * full pass and by the CI check (which runs with no blackboard). */
export function reconcileRegistry(contracts: Contract[] = allContracts()): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];
  const rejected = rejectedEnvSynonyms();
  for (const c of contracts) {
    if (c.category === "env" && rejected.has(c.name)) {
      findings.push({
        kind: "rejected-synonym",
        detail: `Registry entry '${c.name}' is a retired synonym of '${rejected.get(c.name)}' — remove it.`,
        names: [c.name, rejected.get(c.name) ?? ""],
        source: "registry",
      });
    }
  }
  // Pairwise synonym detection within the registry: reuse the declaration detector so the definition
  // of "synonym" lives in ONE place (app/contracts.ts). Compare each entry against the others; dedupe
  // symmetric pairs by only reporting name < otherName.
  for (const c of contracts) {
    const others = contracts.filter((o) => o.name !== c.name);
    for (const conflict of detectDeclarationConflicts({ category: c.category, name: c.name, semantics: c.semantics }, others)) {
      if (conflict.kind !== "synonym") continue;
      if (c.name >= conflict.existingName) continue; // report each pair once
      findings.push({
        kind: "synonym",
        detail: conflict.detail,
        names: [c.name, conflict.existingName],
        source: "registry",
      });
    }
  }
  return findings;
}

/** The full pass: reconcile the accumulated blackboard `contract` signals against the durable
 * registry, plus the registry against itself. */
export function reconcileContracts(
  signals: ContractSignal[],
  contracts: Contract[] = allContracts(),
): ReconciliationReport {
  const findings: ReconciliationFinding[] = [...reconcileRegistry(contracts)];
  const byName = new Map(contracts.map((c) => [c.name, c]));

  for (const sig of signals) {
    // A structured signal (has category+name) can be checked against the registry precisely.
    if (sig.category && sig.name) {
      const conflicts = detectDeclarationConflicts(
        { category: sig.category, name: sig.name, semantics: sig.body },
        contracts,
      );
      for (const conflict of conflicts) {
        findings.push({
          kind: conflict.kind === "synonym" ? "synonym" : conflict.kind === "contradiction" ? "contradiction" : "rejected-synonym",
          detail: `${sig.authorTask}: ${conflict.detail}`,
          names: [conflict.proposedName, conflict.existingName].filter(Boolean),
          source: sig.authorTask,
        });
      }
      // Mock-vs-real skew: an in-flight signal for a contract that never landed in the durable
      // registry. The blackboard is the live signal; the registry is the durable truth. A signal
      // with no registry entry is exactly the divergence-only-at-runtime risk the issue names.
      // BUT a signal already flagged as a synonym or rejected synonym must NOT also be reported as
      // skew: the correct action is to reuse the existing canonical contract, not to "land" the
      // proposed (synonymous/retired) name in the registry — so a skew finding there is noise that
      // contradicts the synonym advice.
      const isSynonymish = conflicts.some((c) => c.kind === "synonym" || c.kind === "rejected-synonym");
      if (!byName.has(sig.name) && !isSynonymish) {
        findings.push({
          kind: "mock-vs-real-skew",
          detail: `${sig.authorTask}: signalled contract '${sig.category}:${sig.name}' on the blackboard but it is not in the durable registry — land it in app/contracts.ts or it stays a mock-only agreement.`,
          names: [sig.name],
          source: sig.authorTask,
        });
      }
    }
  }
  return { findings, clean: findings.length === 0 };
}

/** Render a report as a short, human/agent-readable text block (for an escalation body or a log). */
export function formatReconciliationReport(report: ReconciliationReport): string {
  if (report.clean) return "Contract reconciliation: no synonyms, contradictions, or mock-vs-real skew found.";
  const lines = report.findings.map((f) => `- [${f.kind}] ${f.detail}`);
  return `Contract reconciliation found ${report.findings.length} issue(s):\n${lines.join("\n")}`;
}
