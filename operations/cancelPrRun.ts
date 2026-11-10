// POST /app/api/actions/cancel-pr → operationId `cancelPrRun` (issue #943, PR #944 review).
//
// The page-facing twin of `cancelInstance` for the per-row Cancel button. The runtime's built-in
// `/app/actions/cancel` page action bypassed the app's termination-provenance write, so a deliberate
// UI cancel left an in-flight base status with no reason and `/status` reported it `orphaned`. Both
// doors now route through ONE implementation (`cancelTrackedRun`), which stamps provenance.
//
// Auth posture is preserved: like the built-in page action it replaces (and `retryIncident`), this
// door is INTENTIONALLY UNGUARDED by NANO_PR_WEBHOOK_SECRET — the `@nanobpm/urban` page runtime cannot
// attach x-hook-secret, so a guard would 401 every button press on a secured deployment. The guarded
// `/actions/cancel` stays the API/MCP door; this one is excluded from MCP (`x-mcp`).

import { defineOperation } from "../nano-generated/operations.ts";
import { cancelTrackedRun } from "./cancelInstance.ts";

export default defineOperation("cancelPrRun", async ({ body }, app) => cancelTrackedRun(app, body, "/actions/cancel-pr"));
