// pr.friction-release — releases the friction sweep's singleton DB lease (issue #1073). Runs BEFORE the
// operator summary task (an unread summary must never block the next sweep) and on every other way the
// sweep ends — no-op, collect/file failure, analyst SLA elapsed. Idempotent, and only the holder can
// release (a taken-over holder never frees its successor's lease).
import type { AppJobHandler } from "@nanobpm/urban";
import { releaseLease } from "../../app/friction.ts";

const handler: AppJobHandler<Record<string, unknown>, Record<string, never>> = async (job, app) => {
  const holder = String(job.processInstanceKey ?? "");
  const released = holder !== "" && (await releaseLease(app.data, holder, new Date()));
  app.log.info("friction lease released", { holder, released });
  return {};
};

export default handler;
