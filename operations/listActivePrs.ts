// GET /app/api/status → operationId `listActivePrs` (ADR 0058 OpenAPI surface, mounted under base /app/api).
// List the PRs currently in flight (every tracked PR not converged/abandoned) so an operator or an
// external automation harness can see active work — and grab a `processKey` to cancel — without
// opening the DB or the UI. Read-only projection over the datasource.
//
// The runtime validates the (empty) request against openapi.json; the optional shared-secret guard
// stays HERE (the runtime does not enforce OpenAPI `security`): when NANO_PR_WEBHOOK_SECRET is set,
// callers must present it via the x-hook-secret header. Unset → open (unchanged default).
import { defineOperation } from "@nanobpm/urban";
import { type ActivePr, activePrs } from "../app/service.ts";
import { envVar } from "../app/version.ts";

// Cross-runtime env read (Node `process.env` OR Deno `Deno.env`): reading via `process.env` alone
// would silently disable the guard under Deno/compiled runtimes where `process` is absent, leaving
// the endpoint open even when NANO_PR_WEBHOOK_SECRET is set. Captured once, at module load.
const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

type Res = { count: number; prs: ActivePr[] } | { error: string };

export default defineOperation<
	{
		params: Record<string, string>;
		query: Record<string, string | string[] | undefined>;
		body: undefined;
	},
	Res
>("listActivePrs", async ({ req }, app) => {
	if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
		return { status: 401, body: { error: "unauthorized" } };
	}
	const prs = await activePrs(app.data);
	return { status: 200, body: { count: prs.length, prs } };
});
