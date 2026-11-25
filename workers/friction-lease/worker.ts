// pr.friction-lease — the friction sweep's FIRST step (issue #1073 operator scope): take the singleton
// DB lease so exactly one friction-sweep instance sweeps at a time. The R/PT12H timer start does not
// serialise firings, so a firing that finds the lease held by a live instance records a "skipped"
// sweep and the model ends it at its `skipped` end event. A lease whose holder expired or is no longer
// running (crashed / cancelled) is taken over — the watermark makes that safe (app/friction.ts).
import type { AppJobHandler } from "@nanobpm/urban";
import { acquireLease, frictionConfig, recordSkipped } from "../../app/friction.ts";

interface Out extends Record<string, unknown> {
  leaseAcquired: boolean;
  leaseHeldBy: string;
}

const handler: AppJobHandler<Record<string, unknown>, Out> = async (job, app) => {
  const holder = String(job.processInstanceKey ?? "");
  if (holder === "") throw new Error("pr.friction-lease: job has no processInstanceKey to hold the lease");
  const now = new Date();
  const res = await acquireLease(app.data, app.engine, holder, now, frictionConfig().leaseMs);
  if (!res.acquired) {
    await recordSkipped(app.data, holder, res.heldBy, now);
    app.log.info("friction sweep skipped: sweep already running", { holder, heldBy: res.heldBy });
  }
  return { leaseAcquired: res.acquired, leaseHeldBy: res.heldBy ?? "" };
};

export default handler;
