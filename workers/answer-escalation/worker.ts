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
// This mirrors the merge-loop's message-catch answer path (`answerEscalation` in app/service.ts),
// which already retires its row: both loops converge on the same rule — an answered escalation is
// recorded on the canonical `escalations` row, never left dangling. The token resume itself is owned
// by the engine (userTask completion), so this worker only reconciles the audit row; it returns no
// variables, leaving the submitted `answer` untouched so it flows on to the next review round.
import type { AppJobHandler } from "@nanobpm/urban";

interface Escalation extends Record<string, unknown> {
  id: number;
  pr_key: string;
  status: string;
  answer: string | null;
  answered_at: string | null;
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
  // Retire the latest still-open escalation for this PR (mirrors `answerEscalation`'s latest-open
  // selection). Only one should be open per park; picking the newest keeps a defensive extra row
  // from masking the one the operator just answered.
  const open = (await escs.find({ pr_key: prKey, status: "open" })).sort((a, b) => b.id - a.id)[0];
  if (open) {
    await escs.update(open.id, {
      answer: answer ?? null,
      status: "answered",
      answered_at: new Date().toISOString(),
    });
  }
  return {};
};

export default handler;
