// pr.answer-escalation — retires the review-loop escalation the operator just answered.
//
// The review-loop escalation is a native `wait-answer` userTask (backed by `pr-escalation.form`).
// Completing that task resumes the token, but the engine folds the completed instance's variables
// away — so without this step the durable `escalations` audit row raised by `pr.persist-escalation`
// would stay `status="open"` forever, its `answer`/`answered_at` never recorded. That both loses the
// Q&A audit trail and (because `activePrs` derives `openEscalation` from the open-row status — the
// single source of truth, ADR "derivation over duplication") would keep surfacing a phantom open
// escalation on `/status` after it was answered.
//
// This mirrors the merge-loop's message-catch answer path (`answerEscalation` in app/service.ts):
// both answer the newest still-open `escalations` row, mark any duplicate open rows `stale` (a
// retry of `pr.persist-escalation` can leave more than one open), AND move the `pull_requests` row
// off `status="escalated"` back to `"converging"`, so an answered escalation is never left dangling
// and `/status` never shows an escalated PR with a null question or a phantom open row. The token
// resume itself is owned by the engine (userTask completion), so this worker only reconciles the
// durable rows; it returns no variables, leaving the submitted `answer` untouched so it flows on to
// the next review round.
import type { AppJobHandler } from "@nanobpm/urban";

interface Escalation extends Record<string, unknown> {
  id: number;
  pr_key: string;
  status: string;
  answer: string | null;
  answered_at: string | null;
}

// The PR-row fields this worker reconciles when an escalation is answered. Only `status`/`updated_at`
// are written (mirroring `answerEscalation`); the rest of the row is untouched.
interface PullRequest extends Record<string, unknown> {
  pr_key: string;
  status: string;
  updated_at: string;
}

interface In extends Record<string, unknown> {
  prKey: string;
  answer?: string;
}

// A string variable, or undefined when it is absent/blank. The form marks `answer` required, so a
// blank here would be an out-of-band completion; record it as NULL rather than an empty string.
function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

const handler: AppJobHandler<In> = async (job, app) => {
  const { prKey } = job.variables;
  const answer = nonBlank(job.variables.answer);
  const escs = app.data.table<Escalation>("escalations", "id");
  // Retire EVERY still-open escalation for this PR. `pr.persist-escalation` always INSERTs a new
  // open row, so a retry/duplicate activation can leave more than one open — answering only the
  // newest would leave an older duplicate `open`, a phantom `activePrs` keeps deriving while the PR
  // is still `escalated`. Answer the newest (it carries the operator's reply) and mark any remaining
  // open rows `stale`, mirroring `answerEscalation` and `submitPr`'s resubmit cleanup.
  const open = (await escs.find({ pr_key: prKey, status: "open" })).sort((a, b) => b.id - a.id);
  if (open.length > 0) {
    const ts = new Date().toISOString();
    await escs.update(open[0].id, {
      answer: answer ?? null,
      status: "answered",
      answered_at: ts,
    });
    for (const dup of open.slice(1)) {
      await escs.update(dup.id, { status: "stale" });
    }
    // Mirror the merge loop's `answerEscalation`: move the PR off `status="escalated"` back to
    // `"converging"` now that the question is answered. Without this the row stays `escalated` (with
    // a now-null derived `openEscalation`) until the re-entered round's `persist-round` runs — a
    // `/status` inconsistency and a divergence from the merge path both loops are meant to share.
    const prs = app.data.table<PullRequest>("pull_requests", "pr_key");
    await prs.update(prKey, { status: "converging", updated_at: ts });
  }
  return {};
};

export default handler;
