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
import { type FeatureReadiness, parseFeatureReadiness } from "../app/featureReadiness.ts";
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
  // The `oneOf` variant is normally narrowed by OpenAPI validation, but a directly-invoked delegate
  // can pass a missing/mistyped `issue`/`url` — guard so that stays a 400, not a 500 from `.trim()`.
  const target = "issue" in body ? body.issue : "url" in body ? body.url : undefined;
  if (typeof target !== "string") {
    app.log.warn("start-feature rejected: issue/url must be a string");
    return { status: 400, body: { error: "issue or url must be a string (owner/repo#123 or an issue URL)" } };
  }
  const raw = target.trim();
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
    // No `selfPlanKey`: a feature run creates a `feature_runs` row, NOT a `plans` row, so there is no
    // own plan to exclude from the shared-base guard (rule 4). Passing `parsed.planKey` here would
    // exclude an ACTIVE EPIC sharing the same `owner/repo#N` key, silently bypassing shared-base
    // protection. Feature-run idempotency is enforced separately by `startFeature` on `feature_runs`.
    normalizedBase = await admitPlan(app.data, parsed.repo, rawBase, token, {
      allowSharedBase,
      confirmDefaultBase,
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
  // Optional operator steering threaded to the implementation agent's prompt. Empty/whitespace is
  // normalized to null downstream (startFeature) so it never appends an empty instruction block.
  const customInstructions = "customInstructions" in body && typeof body.customInstructions === "string"
    ? body.customInstructions
    : null;
  // Intake-time readiness gate (issue #295): desugar the optional `readiness` descriptors and/or the
  // `blockedOn` shorthand (resolved against `consumerPackage`) into the probes + bound the run parks
  // on before implementing. A malformed gate (bad descriptor, unparseable handle, blank package) is a
  // 400 at the edge — it must never wait forever at runtime.
  // Type the local as the parser's OWN return type (not a hand-written subset): `parseFeatureReadiness`
  // derives `probes`, `probeTimeout` AND `probePollEvery` together, and all three must be threaded to
  // the run. A narrower local silently drops a field the parser produced (issue #579: `probePollEvery`
  // was dropped, so every gated start 500'd on startFeature's invariant) without TypeScript flagging it,
  // because the narrower shape is structurally assignable from the wider return.
  let readiness: FeatureReadiness;
  try {
    readiness = parseFeatureReadiness({
      readiness: "readiness" in body ? body.readiness : undefined,
      blockedOn: "blockedOn" in body ? body.blockedOn : undefined,
      consumerPackage: "consumerPackage" in body ? body.consumerPackage : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid readiness gate";
    app.log.warn("start-feature rejected: invalid readiness gate", { message });
    return { status: 400, body: { error: message } };
  }
  // Validate the gate's timing bounds at the EDGE, before dispatch: a non-empty probe set is
  // load-bearing together with a non-blank `probeTimeout` (preflight escalation timers + pr.readiness-probe)
  // and `probePollEvery` (preflight retry cadence). `parseFeatureReadiness` always derives all three
  // together, so this only fires for a mis-derived/hand-seeded gate — but validating here turns that
  // into a caller-meaningful 400 rather than a bare-Error 500 from startFeature's internal invariant.
  if (readiness.probes.length > 0) {
    const missingBounds: string[] = [];
    if ((readiness.probeTimeout ?? "").trim() === "") missingBounds.push("a timeout");
    if ((readiness.probePollEvery ?? "").trim() === "") missingBounds.push("a poll cadence");
    if (missingBounds.length > 0) {
      app.log.warn("start-feature rejected: readiness gate missing timing bound", {
        missing: missingBounds,
        probes: readiness.probes.length,
      });
      return {
        status: 400,
        body: {
          error:
            `readiness gate is malformed: ${readiness.probes.length} probe(s) but the request did not ` +
            `resolve to ${missingBounds.join(" and ")}. A gated start (readiness/blockedOn) must resolve ` +
            `to a non-blank timeout and poll cadence`,
        },
      };
    }
  }
  const result = await startFeature(
    app.data,
    app.engine,
    parsed,
    normalizedBase,
    converge,
    autoMerge,
    customInstructions,
    { probes: readiness.probes, probeTimeout: readiness.probeTimeout, probePollEvery: readiness.probePollEvery },
  );
  app.log.info("feature run intake", {
    featureKey: parsed.planKey,
    requestedBaseBranch: normalizedBase,
    converge,
    autoMerge,
    hasCustomInstructions: typeof customInstructions === "string" && customInstructions.trim() !== "",
    readinessProbes: readiness.probes.length,
    outcome: result.outcome,
    alreadyRunning: result.alreadyRunning,
  });
  // Discriminated intake outcome (issue #704): a `noop-terminal` means the engine accepted the start
  // but returned no instance key, so NOTHING was dispatched. That is not a success — surface it as a
  // 502 so the feature page renders "nothing started" distinctly (a red error banner), never a bare
  // green success for a submit that started no instance. `started` / `already-active` are both
  // legitimate 202s (the latter short-circuited a genuinely-live run).
  if (result.outcome === "noop-terminal") {
    app.log.error("feature run intake dispatched no engine instance", { featureKey: parsed.planKey });
    return {
      status: 502,
      body: {
        error:
          `feature run for ${parsed.planKey} started no engine instance — the engine returned no ` +
          `instance key, so nothing was dispatched. Retry, or check the engine.`,
      },
    };
  }
  return { status: 202, body: result };
});
