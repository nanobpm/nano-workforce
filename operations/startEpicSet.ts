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
//   3. Run the existing `admitPlan` gate PER epic (base-branch rules + shared-base guard), PLUS an
//      in-request intra-set shared-base guard (two members of the same set cannot silently grab the
//      same custom base, which admitPlan's durable-only rule 4 would miss). The first failure maps to
//      its 4xx (400/409) via the shared `admitPlanErrorResponse`, before anything is persisted.
//   4. Once every epic admits: STAGE the admitted set — each epic into `admitted_epics` and each
//      validated edge into `admitted_plan_deps` — then LOWER it (issue #292 slice S3): start every
//      ROOT immediately, start every DEPENDENT behind its leading capability readiness-gate, and
//      materialize the durable `plan_deps` edges. Returns the admitted epics, the roots, the gated
//      dependents, and the materialized edges.
//
// The FK-free staging (step 4a) survives a crash between admission and lowering: `lowerAdmittedSet`
// reads `admitted_epics` / `admitted_plan_deps` and creates the durable `plans` row (via `startPlan`)
// before recording each `plan_deps` edge, so the `plan_deps.plan_key REFERENCES plans(plan_key)` FK
// is satisfied by construction. Re-submitting the identical set is a no-op: `admitPlan` is idempotent
// on an already-created base + inactive plan, the staging records collapse a duplicate epic/edge, and
// lowering neither double-starts an epic nor re-seeds a gate (`startPlan` short-circuits a running
// plan) nor duplicates a durable edge.

import { fetchDefaultBranch } from "../app/github.ts";
import {
  admitPlan,
  admitPlanErrorResponse,
  EpicSetValidationError,
  type ParsedIssue,
  parseIssue,
  recordAdmittedEpic,
  recordAdmittedPlanDep,
  SharedBaseError,
  validateEpicSet,
} from "../app/plan.ts";
import { lowerAdmittedSet } from "../app/planLowering.ts";
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
  // `deps` is optional, but when provided it MUST be an array. A non-array `deps` (e.g. `deps: {…}`)
  // would otherwise be silently coerced to `[]` — admitting the set while dropping every declared
  // edge — so reject it with a clean 400 rather than losing the caller's intent.
  if (body.deps != null && !Array.isArray(body.deps)) {
    app.log.warn("start-epic-set rejected: deps is not an array");
    return { status: 400, body: { error: "deps must be an array of dependency edges when provided" } };
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
  const admitted: { parsed: ParsedIssue; baseBranch: string }[] = [];
  // Intra-set shared-base guard: admitPlan's rule 4 only inspects DURABLE `plans` rows, and S2
  // materializes none, so two members of THIS set reaching for the same custom integration branch
  // would both slip past it and silently defeat ADR 0003 rule 4. Track each admitted member's
  // custom (non-default) base per repo and reject a second, non-opted-in claim on it — mirroring the
  // durable guard (the already-admitted member occupies the base regardless of its own flag; only a
  // newcomer that sets `allowSharedBase: true` may stack on it). The default branch is exempt, just
  // as it is in rule 4.
  const claimedBases = new Map<string, Set<string>>();
  for (const member of members) {
    try {
      const normalizedBase = await admitPlan(app.data, member.parsed.repo, member.baseBranch, token, {
        allowSharedBase: member.allowSharedBase,
        confirmDefaultBase: member.confirmDefaultBase,
        selfPlanKey: member.parsed.planKey,
      });
      const defaultBranch = await fetchDefaultBranch(member.parsed.repo, token);
      const isDefaultBase = defaultBranch !== null && normalizedBase === defaultBranch;
      if (!isDefaultBase) {
        const claimed = claimedBases.get(member.parsed.repo);
        if (member.allowSharedBase !== true && claimed?.has(normalizedBase)) {
          throw new SharedBaseError(member.parsed.repo, normalizedBase);
        }
        if (claimed) claimed.add(normalizedBase);
        else claimedBases.set(member.parsed.repo, new Set([normalizedBase]));
      }
      admitted.push({ parsed: member.parsed, baseBranch: normalizedBase });
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

  // ── Step 4: STAGE the admitted set + validated edges FK-free (idempotent), THEN lower it (step 5).
  // Staging first keeps the door crash-safe: `admitted_epics` / `admitted_plan_deps` carry exactly
  // what `lowerAdmittedSet` needs to materialize the durable `plans` + `plan_deps` graph, so a crash
  // between staging and lowering loses nothing (a re-dispatch re-reads the staging). The staging
  // tables are FK-free (no `plans` row need exist yet); lowering creates the `plans` row before
  // recording each `plan_deps` edge, so the FK holds by construction. Each admitted epic (INCLUDING
  // roots) is staged; each validated edge is staged. Only reached once the WHOLE set admitted.
  for (const a of admitted) {
    await recordAdmittedEpic(app.data, {
      plan_key: a.parsed.planKey,
      repo: a.parsed.repo,
      issue_number: a.parsed.number,
      issue_url: a.parsed.url,
      base_branch: a.baseBranch,
    });
  }
  for (const edge of edges) {
    await recordAdmittedPlanDep(app.data, {
      plan_key: edge.consumer,
      depends_on_plan_key: edge.producer,
      package: edge.package,
      capability_ref: edge.capabilityRef,
    });
  }

  // ── Step 5: LOWER the admitted set into a running schedule (issue #292, slice S3). Now that the
  // whole set has admitted and staged, materialize it: start every ROOT immediately, start every
  // DEPENDENT behind its leading capability readiness-gate (seeded from its inbound edges), and
  // materialize the durable `plan_deps` edges. Idempotent — a re-submitted set neither double-starts
  // an epic nor re-seeds a gate nor duplicates an edge (see lowerAdmittedSet).
  const lowered = await lowerAdmittedSet(app.data, app.engine, planKeys);

  app.log.info("epic set admitted + lowered", {
    epics: admitted.length,
    edges: edges.length,
    roots: lowered.roots.length,
    dependents: lowered.dependents.length,
  });
  return {
    status: 202,
    body: {
      epics: admitted.map((a) => ({ planKey: a.parsed.planKey, baseBranch: a.baseBranch })),
      roots: lowered.roots,
      dependents: lowered.dependents,
      edges: edges.map((e) => ({
        consumer: e.consumer,
        producer: e.producer,
        package: e.package,
        capabilityRef: e.capabilityRef,
      })),
    },
  };
});
