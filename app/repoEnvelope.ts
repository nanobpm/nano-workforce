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
import { isPlausibleBranchName } from "./baseBranch.ts";
import { readEnvOr } from "./contracts.ts";
import { isCommitSha } from "./world/index.ts";

/** The reserved namespace key the c8ctl nano worker harness reads the agent-task envelope from
 * (headers ∪ variables, deep-merged). See c8ctl `normalizeTaskEnvelope`. */
export const AGENT_TASK_NS = "io.nanobpm.agentTask";

/** The ONE canonical `owner/repo` allowlist, shared by `repoEnvelopeVars` (which degrades to `{}` on a
 * miss) and `requireRepoEnvelopeVars` (which throws on a miss) so the two can never drift apart. The
 * owner is a GitHub login (alphanumeric + hyphen); the repo-name segment additionally allows `.` and
 * `_`. A trailing `.git` is rejected outright so we never emit a double-suffixed `…/owner/repo.git.git`,
 * and the anchored allowlist bars query/fragment/host-injection chars. */
const OWNER_REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
function isPlainOwnerRepo(repo: string): boolean {
  return OWNER_REPO_RE.test(repo) && !/\.git$/i.test(repo);
}

/** Exported predicate mirroring the internal `owner/repo` allowlist (the ONE shared by
 * `repoEnvelopeVars`/`requireRepoEnvelopeVars`), so a caller that must resolve a per-node effective
 * repository BEFORE seeding an envelope (delivery-graph per-node isolation, #739) uses exactly the same
 * gate — a node whose declared/defaulted repository is not a plain `owner/repo` is "unresolved" by the
 * identical rule the seed helper throws on, never a second divergent check. */
export function isResolvableRepo(repo: unknown): repo is string {
  return typeof repo === "string" && isPlainOwnerRepo(repo.trim());
}

/** The FLAT, dotted process-variable NAME a per-slice worker emits to attach the deterministic
 * `branch.create` to the implement-cell's agent-job envelope (issue #945). The c8ctl harness's
 * `collectEnvelopeFrom` reassembles the reserved namespace from BOTH the whole-object
 * `io.nanobpm.agentTask` variable (the whole-epic seed, which carries `repository` + `task` but no
 * per-slice `branch`) AND any dotted `io.nanobpm.agentTask.*` variables in scope, deep-merging them —
 * so a dotted-name variable set in the MI-child scope lands on the SAME envelope the seed started,
 * and `normalizeTaskEnvelope` then reads `branch.create` from the merged top level. A
 * `<zeebe:ioMapping>` target with dots canNOT produce this: it builds a NESTED
 * `{io:{nanobpm:{agentTask:…}}}` object the flat-key harness never reads (see {@link
 * flattenAgentTaskEnvelope}). Only a worker result key literally NAMED with this dotted string (the
 * engine propagates worker result variables verbatim, mapped or not) materialises the dotted
 * variable. */
export const AGENT_TASK_BRANCH_CREATE_VAR = `${AGENT_TASK_NS}.branch.create`;

/** The ONE canonical derivation of an implementation slice's deterministic pre-PR branch —
 * `feat/<taskId>` (the agent-guide's `feat/*` convention, resources/prompts/feature.md). This is the
 * single source of truth for BOTH the whole-run feature seed (`feature.ts` `startFeature`, where the
 * branch is known at seed time and rides the envelope's `branch.create` directly) AND the epic
 * plan-fanout's per-MI-child emission (`workers/caps-prepare`, which stamps it onto the implement-cell
 * envelope via {@link AGENT_TASK_BRANCH_CREATE_VAR} because each slice's `task.id` differs per child
 * and can't be named at the whole-epic seed). Issue #945: the plan-fanout implement-cell previously
 * carried NO `branch.create`, so every c8ctl retry cut a random `nano/agent-work/*` fallback branch
 * and the durable WIP checkpoint (keyed on `feat/<task.id>`) was never restored — each retry discarded
 * the prior session's work. Deriving it here once keeps the envelope and the prompt's branch
 * instruction (which tells the agent to use `feat/<task.id>`) from drifting into two sources.
 *
 * Returns `null` for a `taskId` whose derived branch is not a plausible git ref (mirrors the
 * delivery-runner's `feat/<node.id>` guard, #776): an ill-formed `branch.create` would turn the
 * isolation guarantee into a launch/checkout failure, so a blank/implausible id degrades to omission
 * (the pre-#945 agent-cuts-its-own-branch behaviour) rather than emit an unusable value. */
export function sliceBranchCreate(taskId: string | null | undefined): string | null {
  const id = typeof taskId === "string" ? taskId.trim() : "";
  if (id === "") return null;
  const branch = `feat/${id}`;
  return isPlausibleBranchName(branch) ? branch : null;
}

/** Flatten a repository-isolation envelope object (as built by {@link repoEnvelopeVars} —
 * `{ "io.nanobpm.agentTask": { repository: { … } } }`) into the FLAT, dotted `io.nanobpm.agentTask.*`
 * key → string-value pairs the c8ctl worker harness reads from a service task's `<zeebe:taskHeaders>`
 * (the same channel the retired `io.nanobpm.agentTask.task.prompt` header used; the harness deep-merges
 * headers ∪ variables and reconstructs the nested envelope from dotted keys — see `normalizeTaskEnvelope`).
 *
 * Header VALUES are strings (a Camunda job header is `string → string`), so scalar leaves are stringified
 * (`true`/`600000`/`https://…`); the harness coerces them back at the point of use. This is the ONLY
 * per-CELL delivery channel for the envelope: a `createInstance` variable can only seed the reserved
 * `io.nanobpm.agentTask` key ONCE at the run root (uniform for every cell), and a `<zeebe:ioMapping>`
 * target with dots creates a NESTED `{io:{nanobpm:{agentTask:…}}}` object the flat-key harness never
 * reads — so per-node isolation (#739) rides task headers, injected by the runner post-digest. Returns an
 * empty map for an empty/`{}` envelope (an unresolved/`repoless` cell → no headers, the launch-dir
 * fallback). */
export function flattenAgentTaskEnvelope(envelope: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string, value: unknown): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        walk(prefix === "" ? k : `${prefix}.${k}`, v);
      }
      return;
    }
    // Scalar leaf — a taskHeader value is a string, so stringify booleans/numbers verbatim; the harness
    // coerces (`singleBranch` truthy, `cloneTimeoutMs` numeric) at the point of use.
    if (typeof value === "string") out[prefix] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[prefix] = String(value);
  };
  walk("", envelope);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base)) return isPlainObject(over) ? deepMerge({}, over) : over;
  const out: Record<string, unknown> = { ...base };
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    const next = cur[k];
    // After the ensure-object step the slot is always a plain object; narrow via the type guard
    // (no `as` — the ban-`as` gate) so the descent stays type-safe.
    if (!isPlainObject(next)) {
      const fresh: Record<string, unknown> = {};
      cur[k] = fresh;
      cur = fresh;
    } else {
      cur = next;
    }
  }
  cur[path[path.length - 1]] = value;
}

/** Mirror of the c8ctl harness's `collectEnvelopeFrom`: reassemble the reserved namespace out of BOTH
 * a whole-object/JSON `io.nanobpm.agentTask` value AND flattened dotted `io.nanobpm.agentTask.*` keys
 * (the channel a per-slice worker's dotted-name result variable uses, issue #945), deep-merging the
 * two. This is the ONE consumer-side mirror shared by the round-trip contract tests
 * (`app/repoEnvelope.test.ts`) and the e2e fan-out proof (`e2e/plan-fanout.e2e.ts`) so producer and
 * consumer can never drift into two readings of where `branch.create` lives. */
function collectEnvelopeFrom(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(source)) return out;
  const whole = source[AGENT_TASK_NS];
  if (whole != null) {
    let val: unknown = whole;
    if (typeof whole === "string") {
      try {
        val = JSON.parse(whole);
      } catch {
        val = undefined;
      }
    }
    if (isPlainObject(val)) Object.assign(out, deepMerge(out, val));
  }
  const prefix = `${AGENT_TASK_NS}.`;
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!rest) continue;
    setPath(out, rest.split("."), value);
  }
  return out;
}

/** Mirror of the c8ctl harness's `normalizeTaskEnvelope` branch slice: deep-merge the envelope
 * recovered from `customHeaders` under that recovered from `variables` (variables win), then read
 * `branch` from the TOP LEVEL of the merged envelope (`isPlainObject(raw.branch)`), NEVER from
 * `raw.repository.branch`. Returns the consumer's recovered `branch.create` (`undefined` when the
 * producer put it somewhere the consumer doesn't look, or omitted it). This is the ONE place tests
 * assert "the harness sees this branch" — keeping producer (`repoEnvelopeVars` / the per-slice dotted
 * variable) and consumer pinned together (issues #882/#945). */
export function recoverBranchCreate(
  customHeaders: Record<string, unknown>,
  variables: Record<string, unknown>,
): string | undefined {
  const merged = deepMerge(collectEnvelopeFrom(customHeaders), collectEnvelopeFrom(variables));
  // deepMerge of two plain-object envelope slices is always a plain object; narrow via the type guard
  // (no `as` — the ban-`as` gate). A non-object merge (impossible here) reads as "no branch".
  const raw = isPlainObject(merged) ? merged : {};
  const branch = isPlainObject(raw.branch) ? raw.branch : {};
  const create = branch.create;
  return create == null ? undefined : String(create);
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

/** Raised when a fan-out dispatch supplies a repository-isolation envelope (`repository`/`baseBranch`)
 * AND an explicit `repoless: true` opt-out at the same time (issue #729). The two are mutually
 * exclusive: `repoless: true` means "dispatch a genuinely checkout-less graph with NO envelope", so a
 * caller that also names a repo/base is contradictory. The dispatch door already rejects this shape
 * with a 400, but a PROGRAMMATIC caller that bypasses the door could still pass both — and silently
 * disable the very isolation the envelope guards (the runner would drop the repo/base and emit `{}`).
 * Failing loudly here too keeps the mutual exclusivity enforced at the seed point, not only at the HTTP
 * edge, so isolation can never be silently disabled by a conflicting-but-well-meant call. */
export class RepoEnvelopeConflictError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`repository-isolation envelope conflicts with an explicit repoless opt-out: ${reason}`);
    this.name = "RepoEnvelopeConflictError";
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
 * the isolated clone lands on the right branch deterministically across a resume. The PR-based paths
 * (review-round / fix-ci / rebase) ALSO pass `branchCreate = ref` (the PR HEAD branch, equal to
 * `ref`): without an explicit `branch.create` the harness's base-branch guard
 * (jwulf/c8ctl-plugin-nano#231) treats the checkout as base-like and cuts a throwaway
 * `nano/agent-work/<base>-<run>` fallback, stranding the round's commits OFF the PR; with
 * `ref == create == head` the harness does a no-op `checkout -B <head>` and commits/pushes to the PR
 * head branch itself. `branchCreate` is therefore emitted on both the pre-PR and PR-based paths (only
 * a blank/omitted value drops the key). */
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
      },
      // Pre-PR provisioning (issue #684): the implementation path (feature.bpmn / plan-fanout's
      // implement-cell) dispatches its agent BEFORE any PR exists, so `ref` is the BASE branch, not a
      // head. `branchCreate` asks the harness to cut the deterministic `feat/<task.id>` feature branch
      // off that base itself (the agent-guide's `feat/*` convention) instead of the agent branching by
      // hand — making the isolated clone land on the right branch deterministically across a resume.
      // The PR-based paths (review/fix-ci/rebase) ALSO pass `branchCreate = ref` (the PR head): without
      // it the harness's base-branch guard (jwulf/c8ctl-plugin-nano#231) cuts a throwaway
      // `nano/agent-work/*` fallback OFF the PR; with `ref == create == head` it commits/pushes to the
      // head branch. Only a blank/omitted value drops the key.
      //
      // `branch` is a TOP-LEVEL sibling of `repository` (issue #882) — the harness's
      // `normalizeTaskEnvelope` reads it from the envelope root (`isPlainObject(raw.branch)`), NOT from
      // `repository.branch`. Nesting it under `repository` was the two-sides-of-one-contract drift
      // (#227) that left `branch.create` silently unread (retries couldn't resume, pushes were
      // refused — nanobpm/nano-bpm#1344).
      ...(typeof branchCreate === "string" && branchCreate.trim() !== ""
        ? { branch: { create: branchCreate.trim() } }
        : {}),
      // Repo-provisioning auth gate (issue #770): c8ctl-plugin-nano (≥1.60.2) only resolves the
      // git credential (GITHUB_TOKEN, or the `gh` default when it's absent) for repository
      // provisioning when `task.allowPr` is truthy — `resolveJobSecrets` pulls the token behind that
      // flag. Without it, a repo-backed clone dies with `unable to get password from user` before the
      // agent even starts. So EVERY repo-backed envelope (this builder only runs past the `owner/repo`
      // guard above) opts the harness into auth-resolved provisioning. The repoless path emits `{}`
      // (no envelope, no `task`), so its behaviour — and its auth posture — is unchanged.
      task: { allowPr: true },
    },
  };
}

/** Build the repository-isolation envelope for ONE delivery-graph `agent` cell (#739), keyed under the
 * reserved {@link AGENT_TASK_NS} namespace exactly like {@link repoEnvelopeVars}, but with the delivery
 * per-node semantics: the `repository.url` is emitted whenever `repo` is a plain `owner/repo` (so the
 * harness clones it) EVEN WHEN no base branch is known, and `ref`/`baseRef` are emitted only when `base`
 * is present. This is the key difference from {@link repoEnvelopeVars} (which emits NOTHING without a
 * `ref`): a cross-repo graph node carries only its `owner/repo` (an issue ref names no branch), so when
 * neither the node nor the run declares a base the cell must still provision an isolated clone — of the
 * repository's DEFAULT branch. The harness `provisionRepo` omits `--branch` when `ref` is blank, so a
 * `ref`-less envelope clones the default branch. Returns `{}` for a `repo` that is not a plain
 * `owner/repo` (an unresolved cell — the runner's invariant rejects the run before this degrades to a
 * launch-dir share). Blobless single-branch shaping + `cloneTimeoutMs` (issues #287/#694) are emitted on
 * every cell.
 *
 * Deterministic isolation branch (issue #776): `branchCreate` (the per-node `feat/<node.id>`) is emitted
 * as `branch.create` so the harness cuts the isolation branch ITSELF — mirroring the single-feature path
 * (`repoEnvelopeVars`/`feature.ts`) — instead of delegating branch-cutting to agent prompt discipline. A
 * forgetful agent that never branched used to commit on the checked-out BASE branch; its `git push
 * origin <base>` was then rejected non-fast-forward and the whole run's work was stranded (merlin job
 * 20974; harness counterpart jwulf/c8ctl-plugin-nano#231). Emitting `branch.create` makes it impossible
 * for a cell to leave its agent committing on the base. Emitted independently of `ref`: when the base is
 * unknown the harness cuts the branch off the cloned default tip; when known, off `ref`. Omitted for a
 * blank `branchCreate` (falls back to the pre-#776 agent-cuts-its-own-branch behaviour). Delivery-graph
 * agent cells are single-instance, so a static per-node `feat/<node.id>` never collides across siblings
 * (the MI-child collision the issue flags does not arise in the current single-instance cells). */
export function agentNodeRepoEnvelope(repo: string, base: string | null, branchCreate: string | null = null): Record<string, unknown> {
  if (!isPlainOwnerRepo(repo)) return {};
  const ref = typeof base === "string" && base.trim() !== "" ? base.trim() : null;
  const create = typeof branchCreate === "string" && branchCreate.trim() !== "" ? branchCreate.trim() : null;
  return {
    [AGENT_TASK_NS]: {
      repository: {
        provider: "github",
        url: `https://github.com/${repo}.git`,
        singleBranch: true,
        filter: "blob:none",
        cloneTimeoutMs: cloneTimeoutMs(),
        // A per-node base (declared, or defaulted from the run level) — the branch the harness cuts its
        // `feat/<node.id>` off. Omitted when unknown so the harness clones the repo's default branch.
        ...(ref ? { ref, baseRef: ref } : {}),
      },
      // The deterministic isolation branch the harness cuts (issue #776), so the agent can never be
      // left committing on the checked-out base branch. Off `ref` when known, else off the default tip.
      // `branch` is a TOP-LEVEL sibling of `repository` (issue #882) — the harness's
      // `normalizeTaskEnvelope` reads it from the envelope root, NOT from `repository.branch`, so the
      // flattened per-cell header is `io.nanobpm.agentTask.branch.create` (not `…repository.branch.create`).
      ...(create ? { branch: { create } } : {}),
      // Repo-provisioning auth gate (issue #770): as in `repoEnvelopeVars`, a repo-backed cell must
      // opt the harness into git-credential resolution (`task.allowPr`) or the clone fails with
      // `unable to get password from user`. Emitted on every resolved cell (past the `owner/repo`
      // guard above); an unresolved/`repoless` cell returns `{}` and carries no `task`.
      task: { allowPr: true },
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
