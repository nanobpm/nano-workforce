// pr.issue-triage-apply — validate the agent's label proposals and apply the confident ones (issue #896).
//
// The agent's output is untrusted DATA. Every proposal goes through `validateProposal` (claim fence →
// only issues this tick collected; label allowlist → only labels the repo really has, re-read live
// here; deny list; per-issue cap; confidence threshold) before anything is written, and the write uses
// the app's own credential. Each candidate gets exactly one ledger row:
//   applied   — labels written;
//   escalated — valid but low-confidence: parked for the batched `issue-triage-review` user task;
//   rejected  — no usable proposal (none returned, or nothing applicable);
//   failed    — the label write (or the live label read) failed; retried on a later tick.
import type { AppJobHandler } from "@nanobpm/urban";
import { addIssueLabels, listRepoLabels } from "../../app/github.ts";
import {
  type IssueTriageProposal,
  parseCandidates,
  parseProposals,
  recordTriageDecision,
  validateProposal,
} from "../../app/issueTriage.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

type In = WorkerInputs["pr.issue-triage-apply"];
type Out = WorkerOutputs["pr.issue-triage-apply"] & Record<string, unknown>;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const processKey = job.processInstanceKey != null ? String(job.processInstanceKey) : null;
  const candidates = parseCandidates(job.variables.candidates);
  const claimed = new Set(candidates.map((c) => `${c.repo}#${c.issue}`));
  // First proposal per issue wins; proposals for unclaimed issues never match a candidate below.
  const byKey = new Map<string, IssueTriageProposal>();
  for (const p of parseProposals(job.variables.proposals)) {
    const key = `${p.repo}#${p.issue}`;
    if (!byKey.has(key)) byKey.set(key, p);
  }

  const token = process.env.GITHUB_TOKEN ?? "";
  const liveLabels = new Map<string, string[] | Error>();
  const labelsFor = async (repo: string): Promise<string[] | Error> => {
    let v = liveLabels.get(repo);
    if (v === undefined) {
      try {
        v = (await listRepoLabels(repo, token)) ?? new Error("no GitHub transport (gh absent and no GITHUB_TOKEN)");
      } catch (err) {
        v = new Error(errText(err));
      }
      liveLabels.set(repo, v);
    }
    return v;
  };

  let appliedCount = 0;
  let escalatedCount = 0;
  let rejectedCount = 0;
  for (const c of candidates) {
    const base = { repo: c.repo, issue: c.issue, title: c.title, url: c.url, processKey };
    const proposal = byKey.get(`${c.repo}#${c.issue}`);
    if (!proposal) {
      await recordTriageDecision(app.data, { ...base, status: "rejected", labels: [], reason: "agent returned no proposal" });
      rejectedCount++;
      continue;
    }
    const detail = { confidence: proposal.confidence, rationale: proposal.rationale, duplicateOf: proposal.duplicateOf ?? null };
    const allowed = await labelsFor(c.repo);
    if (allowed instanceof Error) {
      await recordTriageDecision(app.data, { ...base, ...detail, status: "failed", labels: [], reason: `label read failed: ${allowed.message}` });
      continue;
    }
    const verdict = validateProposal(proposal, claimed, allowed);
    if (verdict.action === "reject") {
      await recordTriageDecision(app.data, { ...base, ...detail, status: "rejected", labels: [], reason: verdict.reason });
      rejectedCount++;
    } else if (verdict.action === "escalate") {
      await recordTriageDecision(app.data, { ...base, ...detail, status: "escalated", labels: verdict.labels, reason: verdict.reason });
      escalatedCount++;
    } else {
      try {
        await addIssueLabels(c.repo, c.issue, verdict.labels, token);
        const reason = verdict.dropped.length > 0 ? `dropped: ${verdict.dropped.join(", ")}` : null;
        await recordTriageDecision(app.data, { ...base, ...detail, status: "applied", labels: verdict.labels, reason });
        appliedCount++;
      } catch (err) {
        await recordTriageDecision(app.data, { ...base, ...detail, status: "failed", labels: verdict.labels, reason: `label write failed: ${errText(err)}` });
      }
    }
  }
  app.log.info("issue-triage apply", { candidates: candidates.length, appliedCount, escalatedCount, rejectedCount });
  return { appliedCount, escalatedCount, rejectedCount };
};

export default handler;
