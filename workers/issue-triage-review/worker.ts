// pr.issue-triage-review — carry out the human's batched decision on low-confidence proposals (#896).
//
// Runs after the `issue-triage-review` user task. `apply` writes each parked proposal's labels after
// re-checking them against the repo's CURRENT labels (one may have been deleted since the tick). Labels
// are only ever ADDED, so anything a maintainer set by hand meanwhile is kept. `skip` (or a missing
// decision) records the issues as skipped so they are not proposed again.
import type { AppJobHandler } from "@nanobpm/urban";
import { addIssueLabels, listRepoLabels } from "../../app/github.ts";
import { applicableLabels, escalatedForInstance, recordTriageDecision } from "../../app/issueTriage.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

type In = WorkerInputs["pr.issue-triage-review"];

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function parseLabels(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

const handler: AppJobHandler<In, Record<string, unknown>> = async (job, app) => {
  const processKey = job.processInstanceKey != null ? String(job.processInstanceKey) : "";
  const decision = job.variables.decision === "apply" ? "apply" : "skip";
  const note = typeof job.variables.note === "string" && job.variables.note.trim() !== "" ? job.variables.note.trim().slice(0, 500) : null;
  const rows = processKey === "" ? [] : await escalatedForInstance(app.data, processKey);
  const token = process.env.GITHUB_TOKEN ?? "";
  const live = new Map<string, Set<string> | Error>();

  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    const base = {
      repo: r.repo, issue: r.issue_number, title: r.title, url: r.url, processKey,
      confidence: r.confidence, rationale: r.rationale, duplicateOf: r.duplicate_of,
    };
    const proposed = parseLabels(r.labels);
    if (decision === "skip") {
      await recordTriageDecision(app.data, { ...base, status: "skipped", labels: proposed, reason: note ? `skipped by reviewer: ${note}` : "skipped by reviewer" });
      skipped++;
      continue;
    }
    let allowed = live.get(r.repo);
    if (allowed === undefined) {
      try {
        const names = await listRepoLabels(r.repo, token);
        allowed = names === null ? new Error("no GitHub transport") : new Set(applicableLabels(names));
      } catch (err) {
        allowed = new Error(errText(err));
      }
      live.set(r.repo, allowed);
    }
    if (allowed instanceof Error) {
      await recordTriageDecision(app.data, { ...base, status: "failed", labels: proposed, reason: `label read failed: ${allowed.message}` });
      failed++;
      continue;
    }
    const labels = proposed.filter((l) => allowed.has(l));
    if (labels.length === 0) {
      await recordTriageDecision(app.data, { ...base, status: "rejected", labels: [], reason: "approved labels no longer exist on the repo" });
      continue;
    }
    try {
      await addIssueLabels(r.repo, r.issue_number, labels, token);
      await recordTriageDecision(app.data, { ...base, status: "applied", labels, reason: note ? `approved by reviewer: ${note}` : "approved by reviewer" });
      applied++;
    } catch (err) {
      await recordTriageDecision(app.data, { ...base, status: "failed", labels, reason: `label write failed: ${errText(err)}` });
      failed++;
    }
  }
  app.log.info("issue-triage review", { decision, rows: rows.length, applied, skipped, failed });
  return {};
};

export default handler;
