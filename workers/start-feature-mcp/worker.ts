// pr.start-feature-mcp — the admission step a MESSAGE-started `feature` instance runs first
// (issue #976).
//
// A tool call on the engine's process MCP (`start_feature`) correlates the `start-feature` message,
// starting an instance whose variables are the call's arguments — bypassing the `startFeature` API
// door's validation, read-model registration, idempotency, and variable seeding. This worker closes
// the gap by re-entering the ONE canonical path (`admitFeatureTool` → `admitPlan` + `startFeature`,
// the same code the API operation runs): it registers the `feature_runs` row and dispatches the real
// run instance (on the none start), idempotent on `feature_key`. This starter instance then
// terminates (feature.bpmn `EndMcp`). A duplicate tool call short-circuits at the canonical
// `alreadyRunning` gate — no second run. Invalid input throws, failing the job into an incident
// (never a silent blank-variable run).
import type { AppJobHandler } from "@nanobpm/urban";
import { admitFeatureTool } from "../../app/mcpStart.ts";

const handler: AppJobHandler = async (job, app) => {
  await admitFeatureTool(app.data, app.engine, job.variables);
  app.log.info("start-feature-mcp admitted", { featureKey: job.variables.issue });
};

export default handler;
