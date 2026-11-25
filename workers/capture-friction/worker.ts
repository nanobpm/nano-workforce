// pr.capture-friction — runs right after the implement-cell agent (issue #1101), on the COMMON
// post-agent path before the result gateway, so every outcome (opened, skipped, blocked, …)
// captures the agent's self-reported `friction` notes. Idempotent, best-effort; returns nothing.
import type { AppJobHandler } from "@nanobpm/urban";
import { captureFrictionFromJob } from "../../app/friction.ts";

const handler: AppJobHandler<Record<string, unknown>> = async (job, app) => {
  await captureFrictionFromJob(app.data, job);
  return {};
};

export default handler;
