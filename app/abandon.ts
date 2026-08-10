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
//   - DERIVED, not a separate marker. `abandoned` is read straight off `pull_requests.status`,
//     which Urban's cancel primitive sets to 'abandoned' on cancel (via the `instanceTracking`
//     `onTerminated.set` patch, applied the instant the instance terminates). No new state to
//     keep in sync.
//   - ADVISORY. Like the blackboard, this never hard-locks; it narrows an unavoidable
//     check-then-push (TOCTOU) window to near-zero. Job fencing in the harness (issue #76 layer 2)
//     is what makes it airtight.
import type { DataLayer } from "@nanobpm/urban";
import { publicBaseUrl } from "./blackboard.ts";

/** The one app-row status that means "this run was cancelled". Convergence/merge terminal states
 * `converged`/`merged` are NOT abandonment — only an explicit cancel flips a live run here. */
export const ABANDONED_STATUS = "abandoned";

/** True when a PR's app-row status means the run was cancelled and the agent must not act. */
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
export function abandonUrl(
	token: string,
	base: string = publicBaseUrl(),
): string {
	return `${base}/hooks/abandon?token=${encodeURIComponent(token)}`;
}

/** Recover the capability token from an abandon URL — the inverse of `abandonUrl`. Returns
 * undefined when the input is absent or carries no `token` query param. A desync-heal uses this to
 * reconstruct a missing `pull_requests` row with the SAME token the running agent was already
 * handed (via the `abandonUrl` process variable), so its `curl -f "…/hooks/abandon?token=…"` abort
 * check keeps resolving instead of 404-ing on a freshly-minted token and aborting a live run. */
export function abandonTokenFromUrl(
	url: string | null | undefined,
): string | undefined {
	if (!url) return undefined;
	try {
		const t = new URL(url).searchParams.get("token");
		return t || undefined;
	} catch {
		return undefined;
	}
}

/** Resolve an abandon token back to its PR key, or undefined when the token is unknown. */
export async function prKeyForAbandonToken(
	data: DataLayer,
	token: string,
): Promise<string | undefined> {
	if (!token) return undefined;
	const row = await data
		.table<{ pr_key: string; abandon_token: string | null }>(
			"pull_requests",
			"pr_key",
		)
		.findOne({ abandon_token: token });
	return row?.pr_key;
}

/** The abandon status of a PR, or undefined when the token is unknown. */
export async function abandonStatusForToken(
	data: DataLayer,
	token: string,
): Promise<{ prKey: string; status: string; abandoned: boolean } | undefined> {
	if (!token) return undefined;
	const row = await data
		.table<{ pr_key: string; abandon_token: string | null; status: string }>(
			"pull_requests",
			"pr_key",
		)
		.findOne({ abandon_token: token });
	if (!row) return undefined;
	return {
		prKey: row.pr_key,
		status: row.status,
		abandoned: isAbandoned(row.status),
	};
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
  the window tiny.`;
}
