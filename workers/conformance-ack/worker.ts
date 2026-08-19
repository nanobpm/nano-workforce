// pr.conformance-ack — an operator acknowledged a conformance-review escalation (issue #216).
//
// When the spec-conformance audit finds the epic did NOT cleanly meet its spec, the `retro` process
// routes to the `conformance-escalation` operator user task (retro.bpmn), which parks the instance
// on the operators' inbox with `plan_conformance.review_status = 'reviewing'`. This worker fires once
// the operator completes that ack task: it settles the row at `reviewed` (so the inbox scan drops it)
// and folds the operator's optional disposition note into the audit `summary`. The instance then
// continues to the lessons (retro) synthesis, so the ack is NON-blocking — delivery already landed.
// Persistence goes through the record gateway (`app.data`), never hand-written SQL.
import type { AppJobHandler } from "@nanobpm/urban";
import { acknowledgeConformance } from "../../app/conformance.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  note?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

const handler: AppJobHandler<In, Record<string, never>> = async (job, app) => {
  const planKey = job.variables.planKey;
  const note = str(job.variables.note);

  await acknowledgeConformance(app.data, planKey, note);
  app.log.info("conformance-ack", { planKey, note: note ?? null });

  return {};
};

export default handler;
