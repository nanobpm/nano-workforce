// pr.issue-triage-collect — the first step of a daily issue-triage tick (issue #896).
//
// The `issue-triage` process starts on a repeating TIMER start event, so every tick lands here with no
// variables. This step decides whether the tick does anything:
//   • NANO_ISSUE_TRIAGE off (the default) → no-op;
//   • a previous tick still between collect and apply (its agent is running) → no-op (overlap guard). A
//     previous tick PARKED on its human review task does not block: its issues are already in the
//     ledger, so the new tick can't collect them again;
//   • otherwise collect up to NANO_ISSUE_TRIAGE_MAX_ISSUES open, unlabelled issues per configured repo
//     that the ledger hasn't decided yet, each carrying the repo's applicable labels.
// It also seeds `agentSlaTimeout`, which a timer-started instance would otherwise not have, for the
// agent task's SLA boundary.
import type { AppJobHandler } from "@nanobpm/urban";
import { AGENT_SLA_TIMEOUT } from "../../app/agentSla.ts";
import { isRepoSlug, listOpenIssues, listRepoLabels } from "../../app/github.ts";
import {
  applicableLabels,
  decidedTriageKeys,
  ISSUE_TRIAGE_PROCESS_ID,
  issueTriageDecisions,
  issueTriageEnabled,
  issueTriageMaxIssues,
  issueTriageRepos,
  MAX_BODY_CHARS,
  type TriageCandidate,
} from "../../app/issueTriage.ts";
import type { WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

type Out = WorkerOutputs["pr.issue-triage-collect"] & Record<string, unknown>;

const handler: AppJobHandler<Record<string, unknown>, Out> = async (job, app) => {
  const idle = (skippedReason: string): Out => ({ candidateCount: 0, candidates: [], agentSlaTimeout: AGENT_SLA_TIMEOUT, skippedReason });
  if (!issueTriageEnabled()) return idle("disabled");
  const repos = issueTriageRepos();
  if (repos.length === 0) return idle("no repos configured");

  const selfKey = job.processInstanceKey != null ? String(job.processInstanceKey) : "";
  const active = await app.engine.searchProcessInstances({ processDefinitionId: ISSUE_TRIAGE_PROCESS_ID, state: "ACTIVE" });
  const parkedForReview = new Set(
    (await issueTriageDecisions(app.data).all()).filter((r) => r.status === "escalated" && r.process_key).map((r) => String(r.process_key)),
  );
  const running = active.filter((i) => String(i.processInstanceKey) !== selfKey && !parkedForReview.has(String(i.processInstanceKey)));
  if (running.length > 0) {
    app.log.info("issue-triage collect: previous tick still running — no-op", { running: running.length });
    return idle("previous tick still running");
  }

  const token = process.env.GITHUB_TOKEN ?? "";
  const max = issueTriageMaxIssues();
  const decided = await decidedTriageKeys(app.data);
  const candidates: TriageCandidate[] = [];
  for (const repo of repos) {
    if (!isRepoSlug(repo)) {
      app.log.warn("issue-triage collect: ignoring invalid repo slug", { repo });
      continue;
    }
    try {
      const labels = await listRepoLabels(repo, token);
      const issues = await listOpenIssues(repo, max * 5, token);
      if (labels === null || issues === null) {
        app.log.warn("issue-triage collect: no GitHub transport (gh absent and no GITHUB_TOKEN)", { repo });
        continue;
      }
      const allowed = applicableLabels(labels);
      const fresh = issues.filter((i) => i.labels.length === 0 && !decided.has(`${repo}#${i.number}`)).slice(0, max);
      for (const i of fresh) {
        candidates.push({ repo, issue: i.number, title: i.title, body: i.body.slice(0, MAX_BODY_CHARS), url: i.url, labels: allowed });
      }
    } catch (err) {
      // One unreachable repo must not stall the others; it is simply retried next tick.
      app.log.warn("issue-triage collect: repo read failed", { repo, error: err instanceof Error ? err.message : String(err) });
    }
  }
  app.log.info("issue-triage collect", { repos: repos.length, candidates: candidates.length });
  return {
    candidateCount: candidates.length,
    candidates: candidates.map((c) => JSON.stringify(c)),
    agentSlaTimeout: AGENT_SLA_TIMEOUT,
  };
};

export default handler;
