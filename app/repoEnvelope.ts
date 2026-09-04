// nano-workforce — the repository-provisioning envelope (`io.nanobpm.agentTask.repository`).
//
// The ONE canonical builder of the agent-task repository envelope the c8ctl nano worker harness
// consumes to provision an ISOLATED clone for an agent job — instead of the agent inheriting
// whatever directory the worker was launched from (which, with several copilot workers on one host,
// means concurrent jobs share — and clobber — one checkout; see issue #684). It lives in its own
// module (not service.ts) so BOTH the PR-based dispatch (`service.ts`: review-round / fix-ci /
// rebase) and the PRE-PR implementation dispatch (`feature.ts`: `startFeature`; `plan.ts`:
// `startPlan` → the epic's `implement-cell`) derive from this single implementation without a
// `plan.ts ↔ service.ts` import cycle (AGENTS.md "derivation over duplication — no drift surfaces").
import { readEnvOr } from "./contracts.ts";
import { isCommitSha } from "./world/index.ts";

/** The reserved namespace key the c8ctl nano worker harness reads the agent-task envelope from
 * (headers ∪ variables, deep-merged). See c8ctl `normalizeTaskEnvelope`. */
const AGENT_TASK_NS = "io.nanobpm.agentTask";

/** The ONE canonical `owner/repo` allowlist, shared by `repoEnvelopeVars` (which degrades to `{}` on a
 * miss) and `requireRepoEnvelopeVars` (which throws on a miss) so the two can never drift apart. The
 * owner is a GitHub login (alphanumeric + hyphen); the repo-name segment additionally allows `.` and
 * `_`. A trailing `.git` is rejected outright so we never emit a double-suffixed `…/owner/repo.git.git`,
 * and the anchored allowlist bars query/fragment/host-injection chars. */
const OWNER_REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
function isPlainOwnerRepo(repo: string): boolean {
  return OWNER_REPO_RE.test(repo) && !/\.git$/i.test(repo);
}

/** Raised by `requireRepoEnvelopeVars` when the repository-isolation envelope is REQUIRED on a fan-out
 * path but its inputs are unresolved (a blank base/head `ref`, or a `repo` that is not a plain
 * `owner/repo`). Issue #729: the fan-out dispatch paths must fail loudly here rather than let
 * `repoEnvelopeVars` silently emit `{}` and degrade to the shared launch-dir behaviour (issue #684's
 * field failure re-opened as a silent fallback). The API edge maps this to a clean 400 / launch error;
 * a caller that legitimately wants no clone must opt in EXPLICITLY (never reach this helper) so the
 * default can never silently share a checkout. */
export class RepoEnvelopeUnresolvedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`repository-isolation envelope is required but its input is unresolved: ${reason}`);
    this.name = "RepoEnvelopeUnresolvedError";
    this.reason = reason;
  }
}

/** Build the repository slice of the agent-task envelope for an agent job. Delivered as a *process
 * variable* under the reserved `io.nanobpm.agentTask` key so the harness provisions an isolated
 * clone — instead of the agent inheriting whatever directory the worker was launched from (which
 * only happened to be a usable checkout for repos already present locally). `ref` is the branch the
 * harness checks out: the PR HEAD branch on the PR-based paths (review-round / fix-ci / rebase), or —
 * on the PRE-PR implementation path (`branchCreate` set) — the BASE branch, off which the harness
 * cuts the new feature branch. When `ref` is unresolved we emit nothing (no `repository.url`) so the
 * harness falls back to the legacy launch-dir behavior rather than silently cloning the repo's
 * default branch. The static `task.prompt` header on the service task deep-merges with this over the
 * same namespace.
 *
 * The clone is requested **branch-scoped and blobless** (`singleBranch: true` + `filter:
 * "blob:none"`) so large monorepos (e.g. `camunda/camunda`, ~1.16 GB) provision within the c8ctl
 * clone timeout instead of full-cloning the whole history (issue #287). `blob:none` is a *blobless*
 * partial clone (trees are still fetched up-front — a *treeless* clone would be `--filter=tree:0`); it
 * keeps the full *commit graph* (so `git merge-base` / the review 3-dot diff stays correct) while
 * fetching file blobs lazily — small upfront, correct diffs. `--depth 1` is deliberately NOT used:
 * it would drop the merge-base and break `git diff origin/<base>...HEAD`. When the PR base branch
 * is known we also emit `baseRef` so the harness fetches the base tip alongside the head, keeping
 * that base reachable for the diff.
 *
 * World-restore (issue #324, ADR 0062 Slice 4/5): when a PR already has a durable push-checkpoint,
 * the last pushed SHA is emitted under the `sha` key so a REPLACEMENT activation (a fresh worktree
 * after a lease loss) reconstructs the working tree to the EXACT pushed SHA — the inversion of the
 * round's outbound `git push` into an inbound `git fetch && git checkout <sha>` — rather than to a
 * branch tip that may have moved. The key is `sha` (not `commitSha`) because that is the field the
 * c8ctl worker harness actually reads to drive the checkout; the earlier `commitSha` key was a silent
 * no-op (issue #695). Omitted (no key) when the PR has no checkpoint yet, so a first activation clones the
 * head branch normally.
 *
 * Pre-PR provisioning (issue #684): the implementation path (feature.bpmn / plan-fanout's
 * `implement-cell`) dispatches its agent BEFORE any PR exists, so it passes `ref = base` and a
 * `branchCreate` naming the deterministic `feat/<task.id>` feature branch the harness cuts off that
 * base itself (the agent-guide's `feat/*` convention) — instead of the agent branching by hand — so
 * the isolated clone lands on the right branch deterministically across a resume. `branchCreate` is
 * omitted on the PR-based paths, which check out an existing head. */
export function repoEnvelopeVars(
  repo: string,
  ref: string | null,
  baseRef: string | null = null,
  commitSha: string | null = null,
  branchCreate: string | null = null,
): Record<string, unknown> {
  if (!ref) return {};
  // Defence in depth: every current caller derives `repo` from parsePr/parseIssue (regex-bounded to
  // `owner/repo`), but this is an exported helper the fan-out epic gives many new callers. A repo
  // that is not exactly `owner/repo` would build a bogus clone URL, so emit nothing (the harness
  // then falls back to the launch-dir behaviour) rather than handing the harness a malformed URL.
  if (!isPlainOwnerRepo(repo)) return {};
  return {
    [AGENT_TASK_NS]: {
      repository: {
        provider: "github",
        url: `https://github.com/${repo}.git`,
        ref,
        // Branch-scoped, blobless partial clone (issue #287): fetch only the head branch with lazy
        // blobs so large monorepos provision within the clone timeout. Single-branch + blob:none
        // (not --depth 1) preserves the commit graph so the review's `git diff origin/<base>...HEAD`
        // has a valid merge-base. Gated on c8ctl provisioner support (jwulf/c8ctl-plugin-nano#91).
        singleBranch: true,
        filter: "blob:none",
        // Raise the harness's 120s default clone timeout for large-repo provisioning (issue #694).
        // A branch-scoped blobless clone of a 24.6k-file monorepo (`camunda/camunda`) still
        // approaches/exceeds 120s, so we emit `cloneTimeoutMs` (default 600000 = 10 min, via the
        // `NANO_PR_CLONE_TIMEOUT_MS` knob) rather than let the harness fall back to its 120000ms
        // default. Emitted on ALL paths from this one builder, so BOTH the review-round path
        // (`service.ts` `submitPr`) and the merge path (`service.ts` `startMerge`) inherit it.
        cloneTimeoutMs: cloneTimeoutMs(),
        // The base branch this PR targets — emitted so the harness fetches its tip alongside the
        // single-branch head, keeping `origin/<base>` reachable for the diff. Omitted when unknown.
        ...(baseRef ? { baseRef } : {}),
        // World-restore (issue #324): the last pushed SHA a replacement activation reconstructs the
        // working tree to (inverting the round's push into a fetch+checkout). Emitted under the key
        // `sha` — the field the c8ctl worker harness actually reads (`provisionRepo` normalizes
        // `repo.sha` and drives `git fetch origin <sha>` + `git checkout --detach <sha>` off it); a
        // prior `commitSha` key was a silent no-op the harness never read (issue #695). Only emitted
        // when the value is a well-formed 40-hex commit SHA: it is forwarded to the harness as an
        // EXACT checkout target, so a non-SHA ref or a whitespace-tainted value could reconstruct to
        // an unintended ref (a moved branch tip) or fail provisioning. A malformed value degrades to
        // omission — the harness then clones the head branch tip, the pre-#324 behaviour. Omitted too
        // when the PR has no durable push-checkpoint yet.
        ...(isCommitSha(commitSha) ? { sha: commitSha } : {}),
        // Pre-PR provisioning (issue #684): the implementation path (feature.bpmn / plan-fanout's
        // implement-cell) dispatches its agent BEFORE any PR exists, so `ref` is the BASE branch, not a
        // head. `branchCreate` asks the harness to cut the deterministic `feat/<task.id>` feature branch
        // off that base itself (the agent-guide's `feat/*` convention) instead of the agent branching by
        // hand — making the isolated clone land on the right branch deterministically across a resume.
        // Omitted (no key) on the PR-based paths (review/fix-ci/rebase), which check out an existing head.
        ...(typeof branchCreate === "string" && branchCreate.trim() !== ""
          ? { branch: { create: branchCreate.trim() } }
          : {}),
      },
    },
  };
}

/** The REQUIRED-envelope guard for the fan-out dispatch paths (issue #729). Same signature and output
 * as `repoEnvelopeVars`, but THROWS `RepoEnvelopeUnresolvedError` on an unresolved input (a blank
 * base/head `ref`, or a `repo` that is not a plain `owner/repo`) instead of degrading to the silent
 * `{}` that leaves the agent job inheriting the worker's launch dir. Every fan-out seed
 * (`app/deliveryRunner.ts` `runDeliveryGraph`, `app/plan.ts` `startPlan`, `app/feature.ts`
 * `startFeature`) MUST route through this helper so a run that can't be isolated fails LOUDLY at seed
 * time — never silently shares (and clobbers) one checkout across concurrent workers on a host (issue
 * #684, re-opened as a silent fallback). A dispatch that legitimately wants no clone must opt in
 * EXPLICITLY at its door (e.g. delivery-graph `repoless: true`) and simply never call this. */
export function requireRepoEnvelopeVars(
  repo: string,
  ref: string | null,
  baseRef: string | null = null,
  commitSha: string | null = null,
  branchCreate: string | null = null,
): Record<string, unknown> {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new RepoEnvelopeUnresolvedError("base/head ref is blank — the harness has no branch to check out");
  }
  if (!isPlainOwnerRepo(repo)) {
    throw new RepoEnvelopeUnresolvedError(`repo is not an \`owner/repo\` reference: ${JSON.stringify(repo)}`);
  }
  const vars = repoEnvelopeVars(repo, ref, baseRef, commitSha, branchCreate);
  // repoEnvelopeVars degrades to `{}` on exactly the two conditions rejected above, so a non-empty
  // envelope is guaranteed here. Assert it so the degrade-vs-throw pair can never silently drift.
  if (Object.keys(vars).length === 0) {
    throw new RepoEnvelopeUnresolvedError(`envelope resolved empty for repo=${JSON.stringify(repo)} ref=${JSON.stringify(ref)}`);
  }
  return vars;
}

/** Resolve the clone timeout (ms) the harness applies to provisioning, from the one typed knob
 * `NANO_PR_CLONE_TIMEOUT_MS` (default 600000 = 10 min; issue #694). A branch-scoped blobless clone
 * of a large monorepo still approaches/exceeds the harness's 120s default, so we raise it here. A
 * non-numeric or non-positive override degrades to the registered default rather than emitting a
 * bogus (0 / NaN) timeout the harness would then treat as "use the 120s default". */
function cloneTimeoutMs(): number {
  const raw = Number(readEnvOr("NANO_PR_CLONE_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : Number(envDefaultCloneTimeoutMs);
}

/** The registered default, resolved once from the schema so the fallback stays single-sourced. */
const envDefaultCloneTimeoutMs = readEnvOr("NANO_PR_CLONE_TIMEOUT_MS", "600000", {});
