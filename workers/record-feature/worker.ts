// pr.record-feature — the single-issue `implement` block has finished (issue #172).
//
// The `senior:feature` agent reported one of `opened` / `blocked` / `skipped` (resources/prompts/feature.md);
// anything else — including a missing status, or an `escalated` status that fell through to abandon
// (the human abandoned or the SLA fired) — is treated as `blocked`: we must not assume a PR was
// opened. This worker:
//   • resolves the run's terminal status from the agent result,
//   • records the PR key + outcome on the `feature_runs` row,
//   • emits `featureStatus` + `prKey` so the `converge?` gateway can decide whether to hand the
//     opened PR off to the convergence loop.
//
// Enrollment itself lives in the separate `pr.converge-feature` worker (gated by the `converge?`
// branch) so the hand-off is legible in the process, not buried in a persistence step.
//
// This is ALSO the one point every PR-delivering path passes through — the agent's own `opened`,
// a retry's `opened`, and the implement-cell reconcile step's ADOPTED `opened` all land here — so
// it is the canonical host-side writer of the idempotent "PR opened" comment on the claimed issue
// (issue #907, app/issuePrLink.ts): a claimed single-issue run (`claimIssue`) that delivered a
// keyed PR gets exactly one `🤖 Pull request opened: #n` comment on its issue, however the PR was
// delivered. Epic slices never set `claimIssue`, so they never comment on the parent epic. The
// comment is best-effort — a failure never fails the run; the owed link is persisted and the
// poller's retry pass (app/service.ts → retryOutstandingIssuePrLinks) re-attempts it.
//
// Issue #967: before a self-reported `blocked` is persisted (which routes the run to the
// `feature-blocked` operator inbox via `gw-blocked`), the worker RECONCILES with the remote
// (app/featureReconcile.ts): the agent's `feat/<task.id>` branch may be pushed and ahead of base
// with only the PR step missing — a machine-observable, recoverable outcome the process can check
// for itself (`agentResult` carries `branch`/`headSha`, but the remote is the authority). A
// delivered branch resolves to `opened` + a PR key (adopting an existing open PR, or opening a
// draft one from the branch) and continues to the converge path; only a run with NO commit to
// deliver parks for a human.
import type { AppJobHandler } from "@nanobpm/urban";
import { blockedFeatureQuestion, type FeatureRunStatus, featureRuns, recordFeatureEscalation } from "../../app/feature.ts";
import { reconcileBlockedFeature, shouldReconcileBlockedFeature } from "../../app/featureReconcile.ts";
import { compareCommits, createPullRequest, fetchBranchHead, listPrsForHead } from "../../app/github.ts";
import { requestIssuePrLink } from "../../app/issuePrLink.ts";
import { KEYLESS_OPENED_SUMMARY } from "../../app/plan.ts";
import { parsePr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordFeatureIn` in feature.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-feature"];
interface Out extends Record<string, unknown> {
  featureStatus: FeatureRunStatus;
  prKey: string | null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

// The implementation agent reports one of these; anything else is `blocked` (we never assume a PR).
type AgentStatus = "opened" | "blocked" | "skipped";
const isAgentStatus = (s: string): s is AgentStatus => s === "opened" || s === "blocked" || s === "skipped";

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const featureKey = job.variables.featureKey;
  let rawStatus = str(job.variables.status);
  let deliveredPr = str(job.variables.pr);
  let reconciled = false;
  // Issue #967: a self-reported `blocked` is reconciled against the remote BEFORE it is persisted
  // (and routed to `feature-blocked`). The branch/headSha the agent reported ride the reserved
  // `io.nanobpm.agentResult` envelope; the remote lookup is the authority. Only a `blocked` report
  // triggers the reconcile — every other status routes untouched (no GitHub I/O).
  // Issue #1011 review: a `blocked` that is really a keyless `opened` the implement-cell could NOT
  // reconcile (stamped with KEYLESS_OPENED_SUMMARY by `reconcileImplement`) reaches here only via an
  // Abandon / escalation-SLA auto-abandon. That human/SLA decision must stand — never let the blocked
  // recovery adopt/create a PR over it and proceed to convergence.
  // Issue #1081 review — the general case of the same class: ANY cell that ended through an Abandon
  // (operator or escalation-SLA auto-abandon) carries `cellResolution = "abandon"` (the cell's
  // human-escalation resolution, output-mapped by feature.bpmn). E.g. a `blocked` WITH a question now
  // escalates; abandoning it must not let blocked-delivery recovery adopt/create a PR over that decision.
  const abandonedEscalation = str(job.variables.cellResolution) === "abandon";
  const abandonedKeyless = (str(job.variables.summary) ?? "").startsWith(KEYLESS_OPENED_SUMMARY);
  if (!abandonedEscalation && !abandonedKeyless && shouldReconcileBlockedFeature(rawStatus)) {
    // Framework-injected (`io.nanobpm.agentResult`) — read through the Record-typed seam, like the
    // other agent-result consumers (workers/persist-escalation et al.); it is not an envelope field.
    // biome-ignore lint/plugin: runtime/framework contract boundary for the reserved agent-result envelope
    const vars = job.variables as Record<string, unknown>;
    const agentResult = vars["io.nanobpm.agentResult"];
    const headSha =
      agentResult !== null && typeof agentResult === "object" && "headSha" in agentResult ? agentResult.headSha : undefined;
    const taskId = job.variables.task?.id;
    const res = await reconcileBlockedFeature(
      {
        status: rawStatus,
        subjectKey: featureKey,
        taskId,
        baseBranch: job.variables.baseBranch,
        headSha,
      },
      {
        branch: fetchBranchHead,
        compare: compareCommits,
        listPrs: listPrsForHead,
        createPr: (repo, head, base, title, body, draft, token) =>
          createPullRequest(repo, head, base, title, body, token, { draft }),
      },
      process.env.GITHUB_TOKEN ?? "",
    );
    if (res.featureStatus !== "blocked") {
      // The remote contradicted the self-report: the branch WAS delivered. Route exactly as an
      // agent-reported `opened` from here on (converge hand-off, issue PR link, terminal row).
      rawStatus = res.featureStatus;
      deliveredPr = res.prKey ?? deliveredPr;
      reconciled = true;
    }
    app.log.info("record-feature: blocked reconcile", {
      featureKey,
      reconciled,
      featureStatus: res.featureStatus,
      prKey: res.prKey,
    });
  }
  const status: AgentStatus = rawStatus && isAgentStatus(rawStatus) ? rawStatus : "blocked";
  const summary = str(job.variables.summary);
  // Only trust a PR ref when the agent reports it actually opened one — OR when the blocked
  // reconcile itself delivered the PR (issue #967: the agent reported `blocked`, so its `pr` field
  // was never trusted, but the reconcile's adopted/opened PR is the delivery).
  const parsed = status === "opened" && deliveredPr ? parsePr(deliveredPr) : null;
  // A keyless "opened" cannot be handed off, but a PR was still raised — keep the status `opened`
  // (the run is complete), just with no `pr_key` to converge.
  const prKey = parsed?.prKey ?? null;
  const featureStatus: FeatureRunStatus = status;
  // A `blocked` outcome is routed (via the `blocked?` gateway) to the `feature-blocked` operator user
  // task, which keeps the instance ALIVE until a human acknowledges it. Persist the row as the
  // NON-terminal `awaiting_operator` for that parked window so a re-dispatch of the same issue
  // short-circuits (no orphaned parallel run); `record-blocked-ack` writes the terminal `blocked`
  // once the operator completes the task. `opened`/`skipped` are already terminal — persist as-is.
  const rowStatus: FeatureRunStatus = status === "blocked" ? "awaiting_operator" : status;
  const ts = new Date().toISOString();

  await featureRuns(app.data).update(featureKey, {
    status: rowStatus,
    pr_key: prKey,
    outcome: summary ?? null,
    updated_at: ts,
  });
  app.log.info("record-feature", { featureKey, featureStatus, rowStatus, prKey });
  // Issue #1081: persist WHY the run is blocked so the `feature-blocked` inbox task renders the agent's
  // reported question (else summary) — appended to the same `feature_escalations` audit log the
  // projection reads, as the newest row for this feature. Never blank (canonical builder fallback).
  if (status === "blocked") {
    await recordFeatureEscalation(app.data, {
      featureKey,
      question: blockedFeatureQuestion({ question: job.variables.question, summary }),
      jobKey: job.jobKey,
    });
  }

  // Issue #907: announce the delivered PR on the claimed issue — ONE idempotent comment, posted by
  // the HOST so every delivery path (agent-opened, retry-opened, reconcile-adopted) covers it.
  // Only a claimed single-issue run (`claimIssue`) with a keyed PR qualifies; epic slices never set
  // `claimIssue`, so they never comment on the parent epic. The ISSUE target comes from the run row
  // (`repo` + `issue_number`), never from the PR's repository, so a cross-repo PR still lands on the
  // claimed issue. Best-effort: a failed attempt leaves the owed link for the poller to retry and
  // never fails the run.
  const link = await requestIssuePrLink(
    {
      featureKey,
      prKey,
      claimIssue: job.variables.claimIssue,
    },
    app.data,
  );
  if (link !== "skipped") app.log.info("record-feature: issue PR link", { featureKey, prKey, link });

  return { featureStatus, prKey };
};

export default handler;
