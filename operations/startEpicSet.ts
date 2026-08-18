// POST /app/api/actions/start/epic-set → operationId `startEpicSet` (issue #292, slice S2). The
// set/batch admission door: it admits a WHOLE set of epics plus the inter-epic dependency edges
// between them in ONE all-or-nothing call, whereas `startPlanFanout` admits exactly one issue.
//
// The door is transactional at the durable layer: it VALIDATES the entire submission before it
// persists anything. The order is load-bearing so a bad set fails "at the offending edge with nothing
// half-started":
//   1. Parse every epic reference and collect the submitted set's plan keys (400 on an unparseable
//      reference, or on EXACTLY-ONE-of issue|url being violated).
//   2. Pure, side-effect-free set validation (`validateEpicSet`): reference integrity (every edge
//      connects two epics IN the set), no self-edge, non-blank capability descriptor, and an acyclic
//      DAG. This runs BEFORE any `admitPlan` call, so a cycle / dangling edge is a clean 400 with no
//      base branch created and no edge written.
//   3. Run the existing `admitPlan` gate PER epic (base-branch rules + shared-base guard). The first
//      failure maps to its 4xx (400/409) via the shared `admitPlanErrorResponse`, before any edge is
//      persisted.
//   4. Only once every epic admits: persist the validated edges into `plan_deps` (S1's `recordPlanDep`,
//      itself idempotent), then return the admitted epics, the roots, and the persisted edges.
//
// This slice deliberately does NOT start any epic or seed any readiness gate — scheduling/lowering
// (starting roots, seeding the capability gate, binding the resolved version) is slice S3, which hooks
// into this admission flow. Re-submitting the identical set is a no-op (admitPlan is idempotent on an
// already-created base + an inactive plan; recordPlanDep collapses a duplicate edge).

import {
  admitPlan,
  admitPlanErrorResponse,
  EpicSetValidationError,
  type ParsedIssue,
  parseIssue,
  recordPlanDep,
  validateEpicSet,
} from "../app/plan.ts";
import { defineOperation } from "../nano-generated/operations.ts";

/** One parsed, admission-ready epic member: its parsed issue reference plus the per-epic admission
 * inputs (`baseBranch` and the two opt-in acknowledgements) `admitPlan` consumes. */
interface EpicMember {
  parsed: ParsedIssue;
  baseBranch: string;
  allowSharedBase: boolean;
  confirmDefaultBase: boolean;
}

export default defineOperation("startEpicSet", async ({ body }, app) => {
  // A directly-invoked delegate (or a missing body) leaves `body` undefined — guard so that is a 400,
  // not a 500 from destructuring. The runtime validates a well-formed body against openapi.yaml.
  if (!body || typeof body !== "object" || !Array.isArray(body.epics)) {
    app.log.warn("start-epic-set rejected: missing or malformed request body");
    return { status: 400, body: { error: "request body is required: { epics: [...], deps?: [...] }" } };
  }
  const depsRaw = Array.isArray(body.deps) ? body.deps : [];

  // ── Step 1: parse every epic reference into an admission-ready member ───────────────────────────
  const members: EpicMember[] = [];
  const planKeys: string[] = [];
  for (const m of body.epics) {
    if (!m || typeof m !== "object") {
      app.log.warn("start-epic-set rejected: malformed epic entry");
      return { status: 400, body: { error: "each epic must be an object with issue|url and baseBranch" } };
    }
    // Enforce EXACTLY-ONE-of issue|url (the operation contract + the error message below). Read each
    // field through `in`-narrowing and validate it is a NON-BLANK STRING, so a key that is present
    // but null/blank (e.g. `{ issue: null, url: "…" }`) does NOT count as provided — it falls through
    // to the other field instead of bare key-presence silently winning.
    const issueVal = "issue" in m ? m.issue : undefined;
    const urlVal = "url" in m ? m.url : undefined;
    const hasIssue = typeof issueVal === "string" && issueVal.trim().length > 0;
    const hasUrl = typeof urlVal === "string" && urlVal.trim().length > 0;
    if (hasIssue && hasUrl) {
      app.log.warn("start-epic-set rejected: epic names both issue and url");
      return { status: 400, body: { error: "each epic needs exactly one of issue or url, not both" } };
    }
    const ref = hasIssue ? issueVal : hasUrl ? urlVal : undefined;
    if (typeof ref !== "string" || ref.trim().length === 0) {
      app.log.warn("start-epic-set rejected: epic missing issue/url");
      return { status: 400, body: { error: "each epic needs exactly one of issue or url (owner/repo#123 or an issue URL)" } };
    }
    const parsed = parseIssue(ref.trim());
    if (!parsed) {
      app.log.warn("start-epic-set rejected: unparseable epic reference", { ref });
      return { status: 400, body: { error: `could not parse epic "${ref}" (use owner/repo#123 or an issue URL)` } };
    }
    members.push({
      parsed,
      baseBranch: typeof m.baseBranch === "string" ? m.baseBranch : "",
      allowSharedBase: m.allowSharedBase === true,
      confirmDefaultBase: m.confirmDefaultBase === true,
    });
    planKeys.push(parsed.planKey);
  }

  // ── Step 2: pure set validation (reference integrity + DAG) — BEFORE any admitPlan side effect ──
  let edges: ReturnType<typeof validateEpicSet>;
  try {
    edges = validateEpicSet(planKeys, depsRaw);
  } catch (err) {
    if (err instanceof EpicSetValidationError) {
      app.log.warn("start-epic-set rejected: invalid set", { status: err.status, error: err.message });
      return { status: err.status, body: { error: err.message } };
    }
    throw err;
  }

  // ── Step 3: admit every epic through the existing gate (base rules + shared-base) ───────────────
  // Nothing durable is written yet, so the first admission failure is a clean 4xx with no edge
  // persisted. `selfPlanKey` excludes the epic's own active row so an idempotent re-submit does not
  // 409 against itself.
  const token = process.env.GITHUB_TOKEN ?? "";
  const admitted: { planKey: string; baseBranch: string }[] = [];
  for (const member of members) {
    try {
      const normalizedBase = await admitPlan(app.data, member.parsed.repo, member.baseBranch, token, {
        allowSharedBase: member.allowSharedBase,
        confirmDefaultBase: member.confirmDefaultBase,
        selfPlanKey: member.parsed.planKey,
      });
      admitted.push({ planKey: member.parsed.planKey, baseBranch: normalizedBase });
    } catch (err) {
      const mapped = admitPlanErrorResponse(err);
      if (mapped) {
        app.log.warn("start-epic-set rejected: epic admission gate", {
          planKey: member.parsed.planKey,
          status: mapped.status,
          error: mapped.error,
        });
        return {
          status: mapped.status,
          body: { error: `epic ${member.parsed.planKey}: ${mapped.error}` },
        };
      }
      throw err;
    }
  }

  // ── Step 4: persist the validated edges (idempotent). Only reached once the WHOLE set admitted. ─
  for (const edge of edges) {
    await recordPlanDep(app.data, {
      plan_key: edge.consumer,
      depends_on_plan_key: edge.producer,
      package: edge.package,
      capability_ref: edge.capabilityRef,
    });
  }

  // Roots = admitted epics with no inbound edge — the ones S3 will start immediately.
  const dependents = new Set(edges.map((e) => e.consumer));
  const roots = admitted.map((a) => a.planKey).filter((k) => !dependents.has(k));

  app.log.info("epic set admitted", {
    epics: admitted.length,
    edges: edges.length,
    roots: roots.length,
  });
  return {
    status: 202,
    body: {
      epics: admitted,
      roots,
      edges: edges.map((e) => ({
        consumer: e.consumer,
        producer: e.producer,
        package: e.package,
        capabilityRef: e.capabilityRef,
      })),
    },
  };
});
