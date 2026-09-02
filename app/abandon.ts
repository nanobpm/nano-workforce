// nano-workforce — cooperative abandon check (issue #76).
//
// Cancelling a mid-flight convergence/merge run terminates the engine instance, but the external
// `senior:*` agent servicing the current job keeps running and would still push a commit, open a
// PR, or re-request a review. The engine signal (the discarded job → a failing `completeJob`)
// arrives only AFTER that side effect. This module gives every side-effecting agent a per-PR
// capability URL it curls RIGHT BEFORE an irreversible action; a cancelled run returns
// `abandoned: true` and the agent stops without touching git.
//
// Design invariants (mirroring the blackboard, app/blackboard.ts):
//   - CAPABILITY URL. The per-PR token IS the credential; the agent curls the exact URL it was
//     handed in its prompt. An unknown token is a 404 (never leaks which PRs exist).
//   - DERIVED, not a separate marker. `abandoned` is read off the PR's ADR-0065 derived tracking
//     VIEW (`pull_requests__tracking.derived_status`). Since urban 0.81.0 the `instanceTracking`
//     reconciler no longer WRITES 'abandoned' onto the base row on cancel; it feeds urban's instance
//     projection and the `onTerminated.set` edge is recomputed on every read as `derived_status`. So
//     an out-of-band cancel leaves the base `status` at its transient (e.g. `converging`) but the
//     derived view reports 'abandoned' immediately — reading the view keeps the abort-check correct
//     with no new state to sync. (`abandonClosedPr`, #352, still writes 'abandoned' onto the base
//     row directly; the view passes that worker-written terminal through unchanged.)
//   - ADVISORY. Like the blackboard, this never hard-locks; it narrows an unavoidable
//     check-then-push (TOCTOU) window to near-zero. Job fencing in the harness (issue #76 layer 2)
//     is what makes it airtight.
import type { DataLayer } from "@nanobpm/urban";
import { publicBaseUrl } from "./blackboard.ts";
import { trackingTargetFor } from "./instanceTracking.ts";

/** The one derived-status value meaning a PR is terminally abandoned — the run must not be worked on
 * further. Two disjoint producers surface a row here, and both are non-completion terminals that must
 * stop a servicing agent:
 *   1. an explicit **cancel** of a live convergence/merge run (Urban's cancel primitive terminates
 *      the instance; the `instanceTracking` `onTerminated.set` edge derives `abandoned` on read), and
 *   2. **`abandonClosedPr`** reconciling a wave-member PR that was **closed on GitHub without
 *      merging** (#352) — for both `pull_requests` and its `plan_tasks` — by writing the base row.
 * Convergence/merge terminal states `converged`/`merged` are NOT abandonment. In either abandoned
 * case a servicing agent should stop, so the abandon-check endpoint treating both as `abandoned:
 * true` is correct. */
export const ABANDONED_STATUS = "abandoned";

/** True when a PR's app-row status is terminally abandoned (run cancelled, or PR closed-unmerged)
 * and the agent must not act. */
export function isAbandoned(status: string | null | undefined): boolean {
  return status === ABANDONED_STATUS;
}

/** A URL-safe, unguessable capability token (192 bits of randomness, base64url, no padding).
 * Same shape as the blackboard token; kept local so the two channels stay independent. */
export function mintAbandonToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The capability URL for a PR's abandon check: the token rides the query string so the agent can
 * GET the exact string it was handed with no header assembly. */
export function abandonUrl(token: string, base: string = publicBaseUrl()): string {
  return `${base}/app/api/hooks/abandon?token=${encodeURIComponent(token)}`;
}

/** Recover the capability token from an abandon URL — the inverse of `abandonUrl`. Returns
 * undefined when the input is absent or carries no `token` query param. A desync-heal uses this to
 * reconstruct a missing `pull_requests` row with the SAME token the running agent was already
 * handed (via the `abandonUrl` process variable), so its `curl -f "…/app/api/hooks/abandon?token=…"` abort
 * check keeps resolving instead of 404-ing on a freshly-minted token and aborting a live run. */
export function abandonTokenFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const t = new URL(url).searchParams.get("token");
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve an abandon token back to its PR key, or undefined when the token is unknown. Reads the
 * derived tracking VIEW (a strict superset of the base row) so this stays valid post-ADR-0065. */
export async function prKeyForAbandonToken(
  data: DataLayer,
  token: string,
): Promise<string | undefined> {
  if (!token) return undefined;
  const row = await data
    .table<{ pr_key: string; abandon_token: string | null }>(
      trackingTargetFor("pull_requests").view,
      "pr_key",
    )
    .findOne({ abandon_token: token });
  return row?.pr_key;
}

/** The abandon status of a PR, or undefined when the token is unknown. Reads the ADR-0065 derived
 * tracking VIEW's `derived_status`, so an out-of-band-cancelled run (whose base row is still
 * `converging`) is correctly reported `abandoned: true` the instant the instance terminates. */
export async function abandonStatusForToken(
  data: DataLayer,
  token: string,
): Promise<{ prKey: string; status: string; abandoned: boolean } | undefined> {
  if (!token) return undefined;
  const target = trackingTargetFor("pull_requests");
  const row = await data
    .table<
      { pr_key: string; abandon_token: string | null } & Record<string, unknown>
    >(target.view, "pr_key")
    .findOne({ abandon_token: token });
  if (!row) return undefined;
  const rawStatus = row[target.statusColumn];
  if (typeof rawStatus !== "string") {
    // Fail CLOSED: a missing/non-string derived_status must never be reported as
    // `abandoned:false`. The abort brief tells agents to proceed on a 200 with
    // `abandoned:false`, so surfacing this as a thrown error (→ 500, which trips the
    // agent's `curl -f` and aborts) is the safe direction for a cancelled run.
    throw new Error(
      `abandonStatusForToken: ${target.view}.${target.statusColumn} is not a string`,
    );
  }
  const status = rawStatus;
  return { prKey: row.pr_key, status, abandoned: isAbandoned(status) };
}

/** The instruction block appended (verbatim, via `appendPrompt`) to each side-effecting agent's
 * prompt. It owns its own leading rule (the FEEL that injects it concatenates with no separator),
 * and carries the concrete, curl-able URL for THIS run plus the abort contract. */
export function renderAbandonBrief(url: string): string {
  return `

---

## Abort if this run was cancelled

This run can be **cancelled** by a human while you work. If it is, the orchestration instance is
gone and your eventual job completion will fail — so any commit, PR, or review you produce would be
an **orphaned side effect** on a run nobody is waiting for.

**Before every irreversible action — before you \`git push\`, open or update a PR, request a review,
or merge — check whether the run is still wanted:**

    curl -fsS "${url}"

On success it returns \`{ "prKey": "...", "status": "...", "abandoned": true|false }\`. The \`-f\` is
important: it makes \`curl\` **exit non-zero on an HTTP error** (e.g. a 404 when the run has been torn
down), instead of silently printing an error body with exit 0.

- **Abort** — make no commits, push nothing, open no PR, request no review — if EITHER the command
  **fails** (non-zero exit: the run was cancelled/torn down or the endpoint is unreachable) OR the
  JSON reports \`"abandoned": true\`. Leave the working tree as-is and exit. A failure when you later
  try to complete the job is EXPECTED after a cancel — do not treat it as an error to retry.
- **Proceed** only when the command **succeeds** AND reports \`"abandoned": false\` — and re-check
  right before the push, since a cancel can land at any moment. Checking as late as possible keeps
  the window tiny.

**Run this check yourself, inline, with your own shell tool.** Do **not** delegate it to a
sub-agent, helper, or a separate "run this command" task: a sub-agent may have **no shell**, in which
case it cannot run \`curl\`, produces no output, and the worker's idle timeout will kill the round.
One inline \`curl\` in your own turn is all this needs.

**If you have no way to run a shell command at all, SKIP this check and proceed.** This check is a
best-effort optimisation, not a hard gate: a separate orchestrator layer **independently enforces
cancellation** (it fences your job's completion on a cancelled run), so skipping the check only
widens a tiny race — it never creates an orphaned run. Never stall, thrash, or fail the round trying
to run \`curl\` through a tool you do not have; a skipped check is strictly better than a hung one.`;
}
