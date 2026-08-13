// pr.record-blocked-ack — an operator acknowledged a blocked single-issue feature run (issue #172).
//
// A `blocked` outcome from `record-feature` is routed to the `feature-blocked` operator user task,
// which keeps the instance alive (parked at the operators' inbox) and holds the row at the
// NON-terminal `awaiting_operator` status so a re-dispatch of the same issue short-circuits instead
// of spawning an orphaned parallel run. This worker fires once the operator completes that task: it
// settles the row at the TERMINAL `blocked` status and records the operator's disposition note, so
// the same issue can be re-dispatched afterwards. Persistence goes through the record gateway
// (`app.data`), never hand-written SQL — matching the other record-* workers.
import type { AppJobHandler } from "@nanobpm/urban";
import { featureRuns } from "../../app/feature.ts";

interface In extends Record<string, unknown> {
  featureKey: string;
  note?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

const handler: AppJobHandler<In, Record<string, never>> = async (job, app) => {
  const featureKey = job.variables.featureKey;
  const note = str(job.variables.note);
  const ts = new Date().toISOString();

  await featureRuns(app.data).update(featureKey, {
    status: "blocked",
    delivery_label: note ? `operator: ${note}` : "acknowledged",
    updated_at: ts,
  });
  app.log.info("record-blocked-ack", { featureKey, note: note ?? null });

  return {};
};

export default handler;
