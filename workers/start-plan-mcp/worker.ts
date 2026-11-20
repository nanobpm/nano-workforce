// pr.start-plan-mcp — the admission step a MESSAGE-started `plan-fanout` instance runs first
// (issue #976).
//
// A tool call on the engine's process MCP (`start_plan_fanout`) correlates the `start-plan-fanout`
// message, starting an instance whose variables are the call's arguments — bypassing the
// `startPlanFanout` API door's validation, read-model registration, idempotency, and variable
// seeding. This worker closes the gap by re-entering the ONE canonical path (`admitPlanTool` →
// `admitPlan` + `startPlan`, the same code the API operation runs): it registers the `plans` row and
// dispatches the real epic instance (on the none start), idempotent on `plan_key`. This starter
// instance then terminates (plan-fanout.bpmn `EndMcp`). A duplicate tool call short-circuits at the
// canonical `alreadyRunning` gate — no second run. Invalid input throws, failing the job into an
// incident (never a silent blank-variable run).
import type { AppJobHandler } from "@nanobpm/urban";
import { admitPlanTool } from "../../app/mcpStart.ts";

const handler: AppJobHandler = async (job, app) => {
  await admitPlanTool(app.data, app.engine, job.variables);
  app.log.info("start-plan-mcp admitted", { planKey: job.variables.issue });
};

export default handler;
