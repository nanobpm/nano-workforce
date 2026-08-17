// GET /app/api/lineage → operationId `getLineage` (issue #245). Project user intent → progress as
// one lineage arc per origin request, so an operator or an external harness can see, in one place,
// that "issue #123 → implementation → PR #45 → converging (round 2) → merged" is a single thread of
// their intent — without opening the DB or joining the tables by hand. Read-only projection over the
// existing record-gateway joins (the same derivation the `lineage_threads` read table is built from).
//
// Optional `root` query param narrows to a single origin's thread (feature_key/plan_key, or a
// self-rooted pr_key for a human/webhook PR). Absent → every thread, active frontier first.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`):
// when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header.
import { getLineage, listLineage } from "../app/lineage.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getLineage", async ({ query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getLineage rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const rawRoot = query.root;
  const root = typeof rawRoot === "string" ? rawRoot.trim() : "";
  if (root) {
    const thread = await getLineage(app.data, root);
    const threads = thread ? [thread] : [];
    return { status: 200, body: { count: threads.length, threads } };
  }
  const threads = await listLineage(app.data);
  return { status: 200, body: { count: threads.length, threads } };
});
