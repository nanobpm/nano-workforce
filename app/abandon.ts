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
import { OWNER_TERMINATED_COLUMN } from "./prTrackingReadModel.ts";

/** The one derived-status value meaning a PR is terminally abandoned — the run must not be worked on
 * further. Two disjoint producers surface a row here, and both are non-completion terminals that must
 * stop a servicing agent:
 *   1. an explicit **cancel** of a live convergence/merge run (Urban's cancel primitive terminates
 *      the instance; the `instanceTracking` `onTerminated.set` edge derives `abandoned` on read) —
 *      but ONLY when the PR did NOT land: the merge-aware derivation (app/prTrackingReadModel.ts,
 *      issue #959) folds a terminated-but-MERGED PR to `merged`, never `abandoned`, and
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
  // `derived_status` reports a landed PR as `merged` even when its run was terminated (issue #959),
  // so termination is read from its own column: a terminated owner ALWAYS aborts the agent.
  const ownerTerminated = Boolean(row[OWNER_TERMINATED_COLUMN]);
  return { prKey: row.pr_key, status, abandoned: isAbandoned(status) || ownerTerminated };
}

/** How an agent-facing URL behaves when the worker cannot reach the app (issue #981). The app's
 * address is one global string (`NANO_WORKFORCE_BASE_URL`) baked into job variables, but the engine
 * endpoint is per-worker — so an off-LAN worker can take a job whose URLs it cannot reach. Every URL
 * handed to an agent must therefore be either DISPLAY-only (never called by the agent) or ADVISORY
 * with a defined unreachable behaviour: no agent step may need an app URL to succeed. */
export type AgentUrlReachability = "display-only" | "advisory";

/** The ONE registry of every app URL handed to an agent (via a process variable or a brief), and its
 * reachability class. `app/agentUrls.test.ts` asserts every `*Url`/`*UrlBase` variable seeded for
 * an agent is declared here and that each advisory brief states its unreachable behaviour. */
export const AGENT_FACING_URLS: Readonly<Record<string, AgentUrlReachability>> = {
  abandonUrl: "advisory", // cancel check — fence-check + `gh pr view` are the primary signal
  blackboardUrl: "advisory", // sibling coordination — off-LAN agents just lose it
  transcriptUrlBase: "display-only", // linked from PR comments / UI, never fetched by the agent
  proposalReviewUrl: "display-only", // human review link for a delivery-graph proposal
  frictionLinks: "display-only", // friction-sweep run/page links in the digest + operator summary (#1073)
};

/** The instruction block appended (verbatim, via `appendPrompt`) to each side-effecting agent's
 * prompt. It owns its own leading rule (the FEEL that injects it concatenates with no separator),
 * and carries the concrete, curl-able URL for THIS run plus the abort contract.
 *
 * Issue #981: the PRIMARY cancel signal is the worker's lease fence (`fence-check` / `$NANO_FENCE`,
 * c8ctl-plugin-nano#320), which goes through the worker's own authenticated engine connection, plus
 * `gh pr view` for a PR closed on GitHub. The app URL is an extra check: honoured when it answers,
 * ignored when it cannot connect. Only a worker WITHOUT the fence falls back to the fail-closed URL
 * check, so LAN workers on older plugins behave exactly as before. */
export function renderAbandonBrief(url: string): string {
  return `

---

## Abort if this run was cancelled

This run can be **cancelled** by a human while you work. If it is, the orchestration instance is
gone and your eventual job completion will fail — so any commit, PR, or review you produce would be
an **orphaned side effect** on a run nobody is waiting for.

**Before every irreversible action — before you \`git push\`, open or update a PR, request a review,
or merge — check whether the run is still wanted**, as late as possible (a cancel can land at any
moment, so re-check right before the push):

1. **The worker fence (primary).** If the \`fence-check\` command is available (\`command -v
   fence-check\`, else \`node "$NANO_FENCE_CHECK"\` when that variable is set, else
   \`c8 nano fence-check\`), run it. It re-checks your job through the worker's own engine
   connection:
   - exit **0** → the job is still held; continue to step 2.
   - exit **1** → the job is lost (the run was cancelled): **abort**.
   - exit **75** (or any other code) → inconclusive (e.g. this job has no checker socket/token,
     as in a container job). If \`$NANO_FENCE\` is set, use the fence file instead (below);
     otherwise treat the fence as inconclusive. Either way **still run step 2**.

   If no usable \`fence-check\` is available but \`$NANO_FENCE\` is set, the fence is still in use: **abort** if
   the file \`$NANO_FENCE\` exists, otherwise treat the job as held.
2. **The PR (when you have one).** Run \`gh pr view <number> --repo <repo> --json state\` and
   **abort** if it reports \`CLOSED\` (a PR closed on GitHub without merging is abandoned even though
   the engine run is still alive). If \`gh\` **fails** or returns no readable state, the PR check is
   *inconclusive*: the fence cannot see a GitHub-side close, so you then **require** a successful
   app check in step 3 (an unreachable URL → **abort**).
3. **The app status URL:**

       curl -sS --connect-timeout 5 --max-time 15 -w '\\nHTTP %{http_code}\\n' "${url}"

   Read the body and status straight from this command's output (never via a shared temp file —
   concurrent jobs on the host would overwrite it). It returns \`{ "prKey": "...", "status": "...", "abandoned": true|false }\`.
   - It **answers** with \`"abandoned": true\`, or with HTTP **404** (token unknown: the run was torn
     down) → **abort**.
   - It answers with \`"abandoned": false\` → proceed.
   - It **cannot connect** (DNS failure, connection refused, timeout — e.g. this worker is off the
     app's LAN) or returns another error:
     - **with the fence in use** (\`fence-check\` exit 0, or the \`$NANO_FENCE\` file absent),
       the PR check conclusive (or there is no PR yet), and the fence said *held* → **proceed**. The URL is only an extra check; the fence and \`gh\` are authoritative.
     - **without the fence** (an older worker, neither available) or when the fence was
       inconclusive with no \`$NANO_FENCE\` file to consult, or the PR check was inconclusive →
       **abort** (fail closed, as before).

To **abort**: make no commits, push nothing, open no PR, request no review. Leave the working tree
as-is and exit. A failure when you later try to complete the job is EXPECTED after a cancel — do not
treat it as an error to retry.

**Run these checks yourself, inline, with your own shell tool.** Do **not** delegate it to a
sub-agent, helper, or a separate "run this command" task: a sub-agent may have **no shell**, in which
case it cannot run \`curl\`, produces no output, and the worker's idle timeout will kill the round.
A few inline commands in your own turn are all this needs.

**Having no way to run a shell command at all is NOT a failed check — SKIP this check and proceed.**
The abort rules above are about the checks *running and reporting* a torn-down run; they do **not**
mean "abort because you have no shell to run them with". This check is a best-effort optimisation,
not a hard gate: the harness that runs your job also fences a cancelled run's completion, so a
skipped check only widens a tiny race — it does not by itself create an orphaned run.
Never stall, thrash, hang, or fail the round trying to run \`curl\` through a tool you do not have;
a skipped check is strictly better than a hung one.`;
}
