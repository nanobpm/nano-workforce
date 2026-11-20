// pr.start-convergence-mcp — the admission step a MESSAGE-started `convergence-loop` instance runs
// first (issue #976).
//
// A tool call on the engine's process MCP (`start_convergence_loop`) correlates the
// `start-convergence-loop` message, starting an instance whose variables are the call's arguments —
// bypassing the `startConvergenceLoop` API door's validation, read-model registration, idempotency,
// and variable seeding. This worker closes the gap by re-entering the ONE canonical path
// (`admitConvergenceTool` → `submitPr`, the same code the API operation runs): it registers the
// `pull_requests` row and dispatches the real convergence instance (on the none start), idempotent
// on `pr_key`. This starter instance then terminates (convergence-loop.bpmn `EndMcp`). A duplicate
// tool call short-circuits at the canonical `alreadyRunning` gate — no second run. Invalid input
// throws, failing the job into an incident (never a silent blank-variable run).
import type { AppJobHandler } from "@nanobpm/urban";
import { admitConvergenceTool } from "../../app/mcpStart.ts";

const handler: AppJobHandler = async (job, app) => {
  await admitConvergenceTool(app.data, app.engine, job.variables);
  app.log.info("start-convergence-mcp admitted", { prKey: job.variables.pr });
};

export default handler;
