// nano-workforce — feature-intake readiness gate desugaring (issue #295).
//
// The intake-time half of the durable readiness gate for a SINGLE-issue feature run. A submitted
// feature may carry an optional `readiness` (one or more full {@link ReadinessProbe} descriptors) or
// the ergonomic shorthand `blockedOn` — a list of upstream issue/PR handles the feature must wait to
// land before its implementation agent is dispatched. This module turns either form into the SAME
// `readinessProbes` + `probeTimeout` process variables the (existing) readiness-gate preflight in
// `resources/processes/feature.bpmn` runs — reusing the production probe kinds, the escalation form,
// and the `capability` late-bind primitive verbatim (derivation over duplication). No new subsystem:
// this is intake plumbing on top of `app/readiness.ts` (#258) and the `capability` kind (#274).
//
// `blockedOn` desugars per handle:
//   • With a declared `consumerPackage` (the cross-repo case — e.g. a wfd feature gated on
//     `@nanobpm/engine-wasm` carrying `nanobpm/nano-bpm#631`) → a `capability` probe that resolves
//     "which published `pkg@version` FIRST carries this handle?" from publish provenance and
//     late-binds the resolved `pkg@version` back into the run (`resolvedArtifacts`), so the agent can
//     bump the consumer dependency to exactly that version.
//   • Without a `consumerPackage` (no published-artifact edge applies) → a `command` probe that goes
//     green once the referenced issue/PR is closed/merged (`gh api …/issues/<n> --jq .state`), the
//     "merged is enough" fallback.
//
// The derivation is pure (no I/O, no engine) so it is trivially unit-testable — the seam
// `startFeature` calls at submit to seed the gate.
import { parseIssue } from "./plan.ts";
import {
  DEFAULT_READINESS_TIMEOUT,
  parseProbe,
  type ReadinessProbe,
  readinessTimeout,
} from "./readiness.ts";
import { isoDurationToMs } from "./reviewWait.ts";

/** The raw intake shape a submitted feature may carry (all optional). `readiness` is one or more
 * full {@link ReadinessProbe} descriptors; `blockedOn` is the ergonomic shorthand — a list of
 * upstream `owner/repo#N` handles; `consumerPackage` is the npm package whose publish provenance the
 * `blockedOn` shorthand resolves the handles against (e.g. `@nanobpm/engine-wasm`). */
export interface FeatureReadinessInput {
  readonly readiness?: unknown;
  readonly blockedOn?: unknown;
  readonly consumerPackage?: unknown;
}

/** The desugared gate: the probes the feature must satisfy before it implements, and the single
 * ISO-8601 bound the preflight's escalation timers fire off (the LONGEST of the probes' derived
 * timeouts, so no probe is cut short). `probes` is empty when the feature declared no readiness —
 * the gate is then skipped and the run proceeds straight to implementation (behaviour unchanged). */
export interface FeatureReadiness {
  readonly probes: ReadinessProbe[];
  readonly probeTimeout: string | null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** A valid GitHub `owner/repo` slug: both segments are restricted to the characters GitHub itself
 * allows (alphanumerics, `-`, `_`, `.`). `parseIssue`'s shorthand branch matches `[^#]+` for the
 * slug, so it would otherwise admit shell metacharacters (`;`, `$( )`, backticks, spaces) that get
 * interpolated verbatim into the `command` probe's `exec` string (and the `capability` target).
 * Constraining the slug here shuts that injection surface for the whole `blockedOn` desugaring. */
const GITHUB_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Normalise a single `blockedOn` handle into a `capability` (with `consumerPackage`) or `command`
 * (fallback) probe. The handle MUST parse as a full `owner/repo#N` reference — a bare `repo#N`
 * cannot name a provenance source repo unambiguously, so it fails loudly here rather than desugaring
 * to a probe that can never resolve. */
function desugarHandle(handle: string, consumerPackage: string | null): ReadinessProbe {
  const parsed = parseIssue(handle.trim());
  if (!parsed) {
    throw new Error(
      `feature readiness: blockedOn handle '${handle}' must be a full 'owner/repo#123' reference ` +
        "(a bare 'repo#123' cannot name the upstream provenance repo)",
    );
  }
  // `parsed.number` is numeric (via `Number`), but `parsed.repo` is an unconstrained slug that lands in
  // a shell `command` target — reject anything that isn't a plain GitHub `owner/repo` before we build it.
  if (!GITHUB_SLUG.test(parsed.repo)) {
    throw new Error(
      `feature readiness: blockedOn handle '${handle}' has an invalid 'owner/repo' slug — only ` +
        "alphanumerics, '-', '_' and '.' are allowed in each segment",
    );
  }
  if (consumerPackage) {
    // The `capability` edge (#274): resolve which published `<consumerPackage>@version` first carries
    // this upstream handle and late-bind that `pkg@version` back into the run. The provenance source
    // repo is the handle's own repo (where the upstream lands and publishes).
    return {
      kind: "capability",
      target: `github-releases:${parsed.repo}`,
      match: { package: consumerPackage, capabilityRef: parsed.planKey },
      // A stuck/never-publishing upstream must ESCALATE (bounded) — never fail or proceed unbound.
      onTimeout: "escalate",
    };
  }
  // Fallback (no published-artifact edge): "merged is enough". `gh` reads its token from the ambient
  // env (like the `github-check`/`capability` kinds), and PRs are issues in the REST API, so a single
  // `/issues/<n>` state check covers both an issue being closed and a PR being merged (→ closed).
  return {
    kind: "command",
    target: `gh api repos/${parsed.repo}/issues/${parsed.number} --jq .state`,
    match: { stdoutIncludes: "closed" },
    onTimeout: "escalate",
  };
}

/** Parse + desugar a feature's optional intake readiness into the gate's `readinessProbes` +
 * `probeTimeout`. Accepts EITHER the full `readiness` descriptor list OR the `blockedOn` shorthand
 * (or both — they concatenate). Returns an empty probe set (gate skipped) when neither is present.
 *
 * Throws a descriptive error on a malformed descriptor (via {@link parseProbe}), a `blockedOn` entry
 * that is not a string, an unparseable handle, or a `consumerPackage` that is present but blank — a
 * mis-declared gate must fail loudly at submit, never wait forever at runtime. */
export function parseFeatureReadiness(
  input: FeatureReadinessInput | null | undefined,
  env: Record<string, string | undefined> = process.env,
): FeatureReadiness {
  const probes: ReadinessProbe[] = [];
  if (input && input.consumerPackage !== undefined && !isNonEmptyString(input.consumerPackage)) {
    throw new Error("feature readiness: 'consumerPackage' must be a non-blank package name when supplied");
  }
  const consumerPackage = input && isNonEmptyString(input.consumerPackage) ? input.consumerPackage.trim() : null;

  if (input?.readiness !== undefined && input.readiness !== null) {
    if (!Array.isArray(input.readiness)) {
      throw new Error("feature readiness: 'readiness' must be an array of probe descriptors");
    }
    for (const raw of input.readiness) probes.push(parseProbe(raw));
  }

  if (input?.blockedOn !== undefined && input.blockedOn !== null) {
    if (!Array.isArray(input.blockedOn)) {
      throw new Error("feature readiness: 'blockedOn' must be an array of 'owner/repo#123' handles");
    }
    for (const raw of input.blockedOn) {
      if (!isNonEmptyString(raw)) {
        throw new Error("feature readiness: each 'blockedOn' entry must be a non-blank 'owner/repo#123' handle");
      }
      probes.push(desugarHandle(raw, consumerPackage));
    }
  }

  if (probes.length === 0) return { probes: [], probeTimeout: null };

  // One bound governs the whole preflight's escalation timers — the LONGEST of the probes' derived
  // timeouts (via the canonical `readinessTimeout`), so no probe is cut short. Mirrors the epic
  // lowering (app/planLowering.ts) so the feature and epic gates derive the bound identically.
  const probeTimeout = probes
    .map((p) => readinessTimeout(p, env))
    .reduce((a, b) => (isoDurationToMs(b, DEFAULT_READINESS_TIMEOUT) > isoDurationToMs(a, DEFAULT_READINESS_TIMEOUT) ? b : a));
  return { probes, probeTimeout };
}
