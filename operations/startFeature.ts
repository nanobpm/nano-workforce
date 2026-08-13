// POST /app/api/actions/start/feature → operationId `startFeature` (ADR 0058/0059, base /app/api).
// The ONE door for starting a SINGLE-issue feature run — the "missing middle" between Epics
// (startPlanFanout) and PR convergence (startConvergenceLoop): hand one issue to a single
// implementation agent that raises exactly one PR, then OPTIONALLY converge + merge (issue #172).
//
// The request body is FLAT (`{ issue | url, baseBranch, converge?, autoMerge? }`), not wrapped in a
// `variables` envelope — a purpose-built operation, not a generic engine "start process" call. The
// body is a `oneOf` — EXACTLY ONE of `issue` or `url` — so an empty or ambiguous target is a 400 at
// the edge; this delegate narrows the validated variant and keeps the issue-FORMAT parse guard.
//
// Base-branch handling is IDENTICAL to the epic path: it reuses `admitPlan` (ADR 0003) verbatim, so
// a feature run's PR is admitted through the same required+explicit / create-if-missing /
// confirm-default / shared-base rules, with the same typed-error → HTTP mapping.

import { startFeature } from "../app/feature.ts";
import { BaseBranchMustExistError } from "../app/github.ts";
import {
  admitPlan,
  DefaultBaseNotConfirmedError,
  InvalidBaseBranchError,
  MissingBaseBranchError,
  parseIssue,
  SharedBaseError,
} from "../app/plan.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("startFeature", async ({ body }, app) => {
  // The runtime validates a well-formed body against openapi.yaml, but a directly-invoked delegate
  // (or a missing body) leaves `body` undefined — guard so that becomes a 400, not a 500 from `in`.
  if (!body || typeof body !== "object") {
    app.log.warn("start-feature rejected: missing request body");
    return { status: 400, body: { error: "request body is required (owner/repo#123 or an issue URL)" } };
  }
  const raw = ("issue" in body ? body.issue : body.url).trim();
  const parsed = parseIssue(raw);
  if (!parsed) {
    app.log.warn("start-feature rejected: unparseable issue reference", { raw });
    return { status: 400, body: { error: "could not parse issue (use owner/repo#123 or an issue URL)" } };
  }
  // Base branch (ADR 0003): admit the launch through the same fail-fast `admitPlan` gate the epic
  // path uses BEFORE starting the run. A feature run also raises a PR against a base, so it honors
  // the identical admission policy and error → HTTP mapping.
  const rawBase = "baseBranch" in body && typeof body.baseBranch === "string" ? body.baseBranch : null;
  const allowSharedBase = "allowSharedBase" in body && body.allowSharedBase === true;
  const confirmDefaultBase = "confirmDefaultBase" in body && body.confirmDefaultBase === true;
  const token = process.env.GITHUB_TOKEN ?? "";
  let normalizedBase: string;
  try {
    normalizedBase = await admitPlan(app.data, parsed.repo, rawBase, token, {
      allowSharedBase,
      confirmDefaultBase,
      selfPlanKey: parsed.planKey,
    });
  } catch (err) {
    if (err instanceof MissingBaseBranchError) {
      app.log.warn("start-feature rejected: missing base branch");
      return {
        status: 400,
        body: { error: "baseBranch is required (name the branch the PR targets, e.g. main or epic/agent-protocol)" },
      };
    }
    if (err instanceof InvalidBaseBranchError) {
      app.log.warn("start-feature rejected: invalid base branch", { baseBranch: err.value });
      return {
        status: 400,
        body: { error: "invalid baseBranch (must be a plausible git branch name, e.g. main)" },
      };
    }
    if (err instanceof BaseBranchMustExistError) {
      app.log.warn("start-feature rejected: base branch does not exist", { baseBranch: err.branch });
      return {
        status: 400,
        body: {
          error:
            `baseBranch "${err.branch}" does not exist and is not an epic/* branch, so it is not ` +
            `auto-created — create it first, or use the epic/* convention`,
        },
      };
    }
    if (err instanceof DefaultBaseNotConfirmedError) {
      app.log.warn("start-feature rejected: default base not confirmed", { baseBranch: err.branch });
      return {
        status: 400,
        body: {
          error:
            `baseBranch "${err.branch}" is the repository default branch — the PR would target it ` +
            `directly. Re-submit with confirmDefaultBase: true to proceed`,
        },
      };
    }
    if (err instanceof SharedBaseError) {
      app.log.warn("start-feature rejected: shared base branch", { baseBranch: err.branch });
      return {
        status: 409,
        body: {
          error:
            `baseBranch "${err.branch}" is already in use by another active epic. Re-submit with ` +
            `allowSharedBase: true to stack on it, or name a distinct branch`,
        },
      };
    }
    throw err;
  }
  const converge = "converge" in body && body.converge === true;
  // Auto-merge is only meaningful as a follow-on to convergence; pin it off when converge is off so
  // the persisted row and the process variable can't disagree.
  const autoMerge = converge && "autoMerge" in body && body.autoMerge === true;
  const result = await startFeature(app.data, app.engine, parsed, normalizedBase, converge, autoMerge);
  app.log.info("feature run started", {
    featureKey: parsed.planKey,
    requestedBaseBranch: normalizedBase,
    converge,
    autoMerge,
    alreadyRunning: "alreadyRunning" in result && result.alreadyRunning === true,
  });
  return { status: 202, body: result };
});
