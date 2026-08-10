// GitHub review fetch for the review-ready poller (SPEC §10).
//
// Two transports, selected by `NANO_PR_GITHUB_TRANSPORT` (auto | gh | token):
//   • gh    — shell out to the host `gh` CLI. It uses the user's own GitHub login, so the
//             poller reaches every repository the user can reach — including private repos
//             that no PAT is (or can be) issued for. This is the default on a workstation.
//   • token — HTTP `fetch` to api.github.com with `GITHUB_TOKEN`. Used in headless/CI where
//             no interactive `gh` login exists.
//   • auto  — prefer `gh` when the binary is present; otherwise fall back to `token`.
//
// The poller is app-side host glue (main.ts), so host-specific subprocess I/O is allowed here.
// Cross-runtime: runs under Node (`node:child_process`) and Deno (`Deno.Command`).

/** A GitHub pull-request review, narrowed to the fields the poller needs. */
export interface GhReview {
	id: number;
	state: string;
	submitted_at?: string;
}

export type GithubTransport = "gh" | "token" | "auto";

/** Resolve the configured transport, defaulting to `auto`. */
export function githubTransport(): GithubTransport {
	const t = (process.env.NANO_PR_GITHUB_TRANSPORT ?? "auto")
		.trim()
		.toLowerCase();
	return t === "gh" || t === "token" ? t : "auto";
}

interface DenoCommandCtor {
	new (
		command: string,
		options: { args: string[]; stdout: "piped"; stderr: "piped" },
	): {
		output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
	};
}

/** Run the host `gh` CLI with the given args (no shell — args are passed as a vector, so a
 * `repo`/`number` from the datastore cannot inject a command). Resolves stdout, rejects on a
 * non-zero exit with stderr as the message. */
async function runGh(args: string[]): Promise<string> {
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	const g = globalThis as { Deno?: { Command?: DenoCommandCtor } };
	if (g.Deno?.Command) {
		const { code, stdout, stderr } = await new g.Deno.Command("gh", {
			args,
			stdout: "piped",
			stderr: "piped",
		}).output();
		if (code !== 0) {
			throw new Error(
				new TextDecoder().decode(stderr).trim() || `gh exited ${code}`,
			);
		}
		return new TextDecoder().decode(stdout);
	}
	const { execFile } = await import("node:child_process");
	return await new Promise<string>((resolve, reject) => {
		execFile(
			"gh",
			args,
			{ maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) reject(new Error(String(stderr || "").trim() || err.message));
				else resolve(String(stdout));
			},
		);
	});
}

let ghAvailable: Promise<boolean> | undefined;
/** Whether the host `gh` CLI is present (memoized — probed at most once per process). */
function isGhAvailable(): Promise<boolean> {
	if (!ghAvailable) {
		ghAvailable = runGh(["--version"]).then(
			() => true,
			() => false,
		);
	}
	return ghAvailable;
}

/** Fetch the reviews for one PR via the configured transport. Throws on transport failure so
 * the caller can log-and-continue; returns `null` when no transport is usable (idle). */
export async function fetchPrReviews(
	repo: string,
	number: number | string,
	token: string,
): Promise<GhReview[] | null> {
	const mode = githubTransport();
	const useGh = mode === "gh" || (mode === "auto" && (await isGhAvailable()));
	const path = `repos/${repo}/pulls/${number}/reviews?per_page=100`;
	if (useGh) {
		const out = await runGh([
			"api",
			path,
			"-H",
			"Accept: application/vnd.github+json",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		return JSON.parse(out) as GhReview[];
	}
	if (!token) return null; // token mode with no token → poller idles
	const r = await fetch(`https://api.github.com/${path}`, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
		},
	});
	if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	return (await r.json()) as GhReview[];
}

// ── Copilot re-request (review-wait liveness) ───────────────────────────────
// A PR parked in `waiting_review` blocks on a *fresh* Copilot review. Copilot won't
// spontaneously re-review a round with no new commit, and routinely dismisses a re-request, so
// the poller must actively solicit the next round's review. Reliable re-request is the REST
// reviewers endpoint with the exact `[bot]` login below — the bare `Copilot` login and the
// GraphQL `requestReviews` mutation both silently no-op (GraphQL resolves Users only).

/** The exact reviewer login GitHub's REST reviewers endpoint accepts for the automated Copilot
 * reviewer. NOT the bare `Copilot` display login (which no-ops) and NOT the `copilot-swe-agent`
 * coding bot. */
export const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";

/** The `requested_reviewers` GET surfaces the pending Copilot reviewer under its *display* login
 * `Copilot`, whereas the POST requires the `[bot]` login above — so a pending check must match
 * either spelling. */
function isCopilot(login: string | undefined): boolean {
	return login === "Copilot" || login === COPILOT_REVIEWER;
}

/** Whether Copilot is currently a *pending* (requested-but-not-yet-submitted) reviewer on the PR.
 * The poller uses this to avoid re-requesting a review that is already in flight. `null` when no
 * transport is usable (poller idles); throws on a genuine transport failure. */
export async function hasPendingCopilotReviewer(
	repo: string,
	number: number | string,
	token: string,
): Promise<boolean | null> {
	const path = `repos/${repo}/pulls/${number}/requested_reviewers`;
	let users: { login?: string }[];
	if (await useGh()) {
		const out = await runGh([
			"api",
			path,
			"-H",
			"Accept: application/vnd.github+json",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		users = (JSON.parse(out) as { users?: { login?: string }[] }).users ?? [];
	} else {
		if (!token) return null;
		const r = await fetch(`https://api.github.com/${path}`, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		});
		if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		users = ((await r.json()) as { users?: { login?: string }[] }).users ?? [];
	}
	return users.some((u) => isCopilot(u.login));
}

/** Request a fresh Copilot review on the PR (REST reviewers endpoint, exact `[bot]` login), so
 * the process's `review-ready` catch can eventually fire. Returns `"requested"` on success,
 * `"unavailable"` when Copilot is not an assignable reviewer on that repo (HTTP 422 — e.g.
 * Copilot review not enabled there), or `null` when no transport is usable. Never throws for the
 * 422 "not assignable" case; only a genuine transport failure propagates. */
export async function requestCopilotReview(
	repo: string,
	number: number | string,
	token: string,
): Promise<"requested" | "unavailable" | null> {
	const path = `repos/${repo}/pulls/${number}/requested_reviewers`;
	if (await useGh()) {
		try {
			await runGh([
				"api",
				path,
				"-X",
				"POST",
				"-f",
				`reviewers[]=${COPILOT_REVIEWER}`,
			]);
			return "requested";
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// gh surfaces the 422 as its HTTP status and/or the "Unprocessable"/"not be requested"
			// body; treat any of those as "Copilot isn't assignable here" rather than a hard failure.
			if (
				/\b422\b|unprocessable|cannot be requested|not.*(assignable|be requested)/i.test(
					msg,
				)
			) {
				return "unavailable";
			}
			throw err;
		}
	}
	if (!token) return null;
	const r = await fetch(`https://api.github.com/${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: JSON.stringify({ reviewers: [COPILOT_REVIEWER] }),
	});
	if (r.ok) return "requested";
	if (r.status === 422) return "unavailable";
	throw new Error(
		`github ${r.status} ${r.statusText}: ${(await r.text()).slice(0, 300)}`.trim(),
	);
}

// ── Merge stage (SPEC §11) ──────────────────────────────────────────────────
// The same two-transport model (gh | token) backs the merge stage: read a PR's merge state to
// decide when it is landable, and perform the merge (directly or via the repo's merge queue).

/** Whether to use the `gh` CLI for this pass, honouring `NANO_PR_GITHUB_TRANSPORT`. */
async function useGh(): Promise<boolean> {
	const mode = githubTransport();
	return mode === "gh" || (mode === "auto" && (await isGhAvailable()));
}

/** PR metadata we read once at submit: the title (to label the row) and the body (to scan for a
 * `Depends-on:` line). `null` when no transport is usable. */
export interface PrMeta {
	title: string | null;
	body: string;
}

export async function fetchPrMeta(
	repo: string,
	number: number | string,
	token: string,
): Promise<PrMeta | null> {
	if (await useGh()) {
		const out = await runGh([
			"pr",
			"view",
			String(number),
			"--repo",
			repo,
			"--json",
			"title,body",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const j = JSON.parse(out) as { title?: string; body?: string };
		return { title: j.title ?? null, body: j.body ?? "" };
	}
	if (!token) return null;
	const r = await fetch(
		`https://api.github.com/repos/${repo}/pulls/${number}`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		},
	);
	if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	const j = (await r.json()) as { title?: string; body?: string };
	return { title: j.title ?? null, body: j.body ?? "" };
}

/** A PR's merge state, narrowed to what the merge poller needs to classify landability.
 * `mergeStateStatus` uses GitHub's vocabulary (CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE |
 * DRAFT | HAS_HOOKS | UNKNOWN). `failingChecks` is `-1` when the transport can't enumerate
 * checks (token mode) so the classifier stays conservative. `failingCheckNames` lists those
 * failing gates (empty in token mode) so the CI-fix agent knows what to make green. */
export interface PrState {
	merged: boolean;
	mergeStateStatus: string;
	failingChecks: number;
	failingCheckNames: string[];
	/** Total head check runs of any state (pending/failed/passed). `0` = no run exists at all (the
	 * frugal-CI stuck state the fresh-head-run remedy targets); `-1` when the transport can't
	 * enumerate checks (token mode). */
	totalChecks: number;
	/** Whether the PR is a draft (a fresh head run is produced by marking it ready, not reopen). */
	isDraft: boolean;
	/** Current head commit. Used to scope one-shot merge-protocol nudges to a landing attempt. */
	headRefOid: string | null;
}

/** Map GitHub's REST `mergeable_state` (lower-case) onto the GraphQL `mergeStateStatus`
 * vocabulary the classifier speaks, so both transports feed one code path. */
function normalizeMergeState(s: string): string {
	return (s || "unknown").toUpperCase();
}

interface RollupEntry {
	status?: string;
	conclusion?: string;
	state?: string;
	name?: string;
	context?: string;
	workflowName?: string;
}
/** Names of the checks whose result is a hard failure (as opposed to pending/success). Covers
 * both the CheckRun shape (`conclusion` + `name`/`workflowName`) and the legacy StatusContext
 * shape (`state` + `context`). The names are what the CI-fix agent is handed so it knows which
 * gates to make green; `failingChecks` (the count) is derived from this list. */
function failingCheckNames(rollup: RollupEntry[]): string[] {
	const bad = new Set([
		"FAILURE",
		"TIMED_OUT",
		"CANCELLED",
		"ACTION_REQUIRED",
		"STARTUP_FAILURE",
		"ERROR",
	]);
	const names: string[] = [];
	for (const c of rollup) {
		const v = (c.conclusion || c.state || "").toUpperCase();
		if (bad.has(v))
			names.push(c.name || c.context || c.workflowName || "check");
	}
	return names;
}

export async function fetchPrState(
	repo: string,
	number: number | string,
	token: string,
): Promise<PrState | null> {
	if (await useGh()) {
		const out = await runGh([
			"pr",
			"view",
			String(number),
			"--repo",
			repo,
			"--json",
			"state,mergedAt,mergeStateStatus,statusCheckRollup,isDraft,headRefOid",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const j = JSON.parse(out) as {
			state?: string;
			mergedAt?: string | null;
			mergeStateStatus?: string;
			statusCheckRollup?: RollupEntry[];
			isDraft?: boolean;
			headRefOid?: string | null;
		};
		const rollup = j.statusCheckRollup ?? [];
		const names = failingCheckNames(rollup);
		return {
			merged: j.state === "MERGED" || !!j.mergedAt,
			mergeStateStatus: (j.mergeStateStatus || "UNKNOWN").toUpperCase(),
			failingChecks: names.length,
			failingCheckNames: names,
			totalChecks: rollup.length,
			isDraft: !!j.isDraft,
			headRefOid: j.headRefOid ?? null,
		};
	}
	if (!token) return null;
	const r = await fetch(
		`https://api.github.com/repos/${repo}/pulls/${number}`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		},
	);
	if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	const j = (await r.json()) as {
		merged?: boolean;
		merged_at?: string | null;
		mergeable_state?: string;
		draft?: boolean;
		head?: { sha?: string | null };
	};
	return {
		// The single-PR GET returns a `merged` boolean (unlike the list endpoint); we also honour
		// `merged_at` so this mirrors the gh branch's `state === "MERGED" || mergedAt` rule.
		merged: !!j.merged || !!j.merged_at,
		mergeStateStatus: normalizeMergeState(j.mergeable_state ?? "unknown"),
		failingChecks: -1, // REST here doesn't enumerate checks → classifier treats BLOCKED as "wait"
		failingCheckNames: [], // …and the CI-fix agent gets no per-check list in token mode
		totalChecks: -1, // …and the fresh-head-run remedy stays conservative (never reopens blind)
		isDraft: !!j.draft,
		headRefOid: j.head?.sha ?? null,
	};
}

/** The changed file paths of a PR (for the D2 conflict-scan, #58). `gh` returns them directly;
 * the token transport pages `/pulls/{n}/files` (100/page, capped). Returns `null` when no
 * transport is usable (idle), an empty array for a PR with no files. */
export async function fetchPrFiles(
	repo: string,
	number: number | string,
	token: string,
): Promise<string[] | null> {
	if (await useGh()) {
		const out = await runGh([
			"pr",
			"view",
			String(number),
			"--repo",
			repo,
			"--json",
			"files",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const j = JSON.parse(out) as { files?: { path?: string }[] };
		return (j.files ?? []).map((f) => f.path ?? "").filter((p) => p !== "");
	}
	if (!token) return null;
	const paths: string[] = [];
	// Cap the paging so a freak huge PR can't spin the scan; 5×100 files is far past any real slice.
	const MAX_PAGES = 5;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const r = await fetch(
			`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
			{
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
				},
			},
		);
		if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const batch = (await r.json()) as { filename?: string }[];
		for (const f of batch) if (f.filename) paths.push(f.filename);
		// A short final page means we've read every file — the list is complete.
		if (batch.length < 100) return paths;
		// A full page on the last allowed page is only truncated if GitHub says there's more. Trust the
		// `Link` header's `rel="next"` rather than page size, so an exact multiple of 100 (e.g. exactly
		// 500 files, no next page) is returned as complete instead of throwing a false positive. When
		// the cap genuinely truncates, throw so the caller can log-and-skip rather than recording
		// exclusions from an incomplete (under-approximated) file set that could miss real overlaps.
		if (
			page === MAX_PAGES &&
			/<[^>]*>;\s*rel="next"/.test(r.headers.get("link") ?? "")
		) {
			throw new Error(
				`github pr files truncated: ${repo}#${number} exceeds ${MAX_PAGES * 100}-file paging cap`,
			);
		}
	}
	return paths;
}

/** The PR head ref/sha for D3's trial-merge gate. `null` when no transport is usable. */
export async function fetchPrHead(
	repo: string,
	number: number | string,
	token: string,
): Promise<{ headRef: string | null; headSha: string | null } | null> {
	if (await useGh()) {
		const out = await runGh([
			"pr",
			"view",
			String(number),
			"--repo",
			repo,
			"--json",
			"headRefName,headRefOid",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const j = JSON.parse(out) as {
			headRefName?: string | null;
			headRefOid?: string | null;
		};
		return { headRef: j.headRefName ?? null, headSha: j.headRefOid ?? null };
	}
	if (!token) return null;
	const r = await fetch(
		`https://api.github.com/repos/${repo}/pulls/${number}`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		},
	);
	if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	const j = (await r.json()) as {
		head?: { ref?: string | null; sha?: string | null };
	};
	return { headRef: j.head?.ref ?? null, headSha: j.head?.sha ?? null };
}

/** The PR's current base branch ref — the branch this PR would land *into*. `null` when no
 * transport is usable (idle). Used by the dead-end-base guard (#60) so we never land a PR into a
 * base that has itself already merged to the default branch. */
export async function fetchPrBase(
	repo: string,
	number: number | string,
	token: string,
): Promise<string | null> {
	if (await useGh()) {
		const out = await runGh([
			"pr",
			"view",
			String(number),
			"--repo",
			repo,
			"--json",
			"baseRefName",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const j = JSON.parse(out) as { baseRefName?: string };
		return j.baseRefName ?? null;
	}
	if (!token) return null;
	const r = await fetch(
		`https://api.github.com/repos/${repo}/pulls/${number}`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		},
	);
	if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	const j = (await r.json()) as { base?: { ref?: string } };
	return j.base?.ref ?? null;
}

const defaultBranchCache = new Map<
	string,
	{ at: number; name: string | null }
>();
const DEFAULT_BRANCH_TTL_MS = 5 * 60_000;

/** The repo's default branch (e.g. `main`), memoized per repo for 5 min. A PR that targets the
 * default branch can never be a dead-end, so the guard short-circuits on it. `null` when no
 * transport is usable. */
export async function fetchDefaultBranch(
	repo: string,
	token: string,
): Promise<string | null> {
	const hit = defaultBranchCache.get(repo);
	if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.name;
	let name: string | null = null;
	if (await useGh()) {
		const out = await runGh([
			"repo",
			"view",
			repo,
			"--json",
			"defaultBranchRef",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const j = JSON.parse(out) as { defaultBranchRef?: { name?: string } };
		name = j.defaultBranchRef?.name ?? null;
	} else if (token) {
		const r = await fetch(`https://api.github.com/repos/${repo}`, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		});
		if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const j = (await r.json()) as { default_branch?: string };
		name = j.default_branch ?? null;
	} else {
		return null; // no transport → leave the cache untouched so a later call can resolve it
	}
	defaultBranchCache.set(repo, { at: Date.now(), name });
	return name;
}

/** Whether a branch has already *landed* — i.e. it is the head of a `MERGED` PR. Returns:
 *   • `landed`  — a merged PR exists from this branch → the branch is a dead-end target
 *   • `open`    — an open PR exists from it (still alive)
 *   • `unknown` — no PR references it, or no transport (ambiguous → never treated as dead-end)
 * The guard blocks a merge only on a positive `landed` signal, so a valid stacked merge is never
 * wrongly held. */
export async function baseBranchLanded(
	repo: string,
	branch: string,
	token: string,
): Promise<"landed" | "open" | "unknown"> {
	if (await useGh()) {
		const out = await runGh([
			"pr",
			"list",
			"--repo",
			repo,
			"--head",
			branch,
			"--state",
			"all",
			"--json",
			"state",
			"--limit",
			"20",
		]);
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const arr = JSON.parse(out) as { state?: string }[];
		if (arr.some((p) => (p.state ?? "").toUpperCase() === "MERGED"))
			return "landed";
		if (arr.some((p) => (p.state ?? "").toUpperCase() === "OPEN"))
			return "open";
		return "unknown";
	}
	if (!token) return "unknown";
	const owner = repo.split("/")[0];
	const r = await fetch(
		`https://api.github.com/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=20`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		},
	);
	if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	const arr = (await r.json()) as {
		state?: string;
		merged_at?: string | null;
	}[];
	if (
		arr.some((p) => p.merged_at || (p.state ?? "").toUpperCase() === "MERGED")
	)
		return "landed";
	if (arr.some((p) => (p.state ?? "").toLowerCase() === "open")) return "open";
	return "unknown";
}

/** A settled landability verdict, or `waiting` when GitHub hasn't determined it yet (or is
 * still running checks / awaiting review). The poller only advances the process on a settled
 * verdict; `waiting` means re-poll later. */
export type Mergeability = "ready" | "waiting" | "conflict" | "blocked";

export function classifyMergeability(s: PrState): Mergeability {
	switch (s.mergeStateStatus) {
		case "CLEAN":
		case "HAS_HOOKS":
		case "UNSTABLE": // only non-required checks failing — still mergeable
		case "BEHIND": // out of date; a queue rebases, a direct merge is still allowed
			return "ready";
		case "DIRTY":
			return "conflict";
		case "BLOCKED":
			// A required check failed -> a human must act. Pending checks / awaiting review -> wait.
			// When we can't enumerate checks (failingChecks < 0, token mode) stay conservative: wait.
			return s.failingChecks > 0 ? "blocked" : "waiting";
		default: // UNKNOWN / "" — GitHub is still computing mergeability
			return "waiting";
	}
}

export type MergeMethod = "squash" | "merge" | "rebase";
export interface MergeOptions {
	method: MergeMethod;
	admin: boolean;
}
export interface MergeResult {
	outcome: "merged" | "queued" | "blocked";
	detail: string;
}

/** Attempt to land the PR. Returns `merged` (landed now), `queued` (added to the repo's merge
 * queue — the poller then watches for it to land), or `blocked` (GitHub refused — a human must
 * resolve it, then reply to retry). `null` when no transport is usable. Never throws for a
 * refused merge; only a genuine transport failure propagates. */
export async function mergePr(
	repo: string,
	number: number | string,
	token: string,
	opts: MergeOptions,
): Promise<MergeResult | null> {
	const methodFlag = `--${opts.method}`;
	if (await useGh()) {
		const args = ["pr", "merge", String(number), "--repo", repo, methodFlag];
		if (opts.admin) args.push("--admin");
		try {
			const out = await runGh(args);
			// gh prints "… will be added to the merge queue" when the branch requires one.
			if (/merge queue/i.test(out))
				return { outcome: "queued", detail: out.trim() };
			return { outcome: "merged", detail: out.trim() || "merged" };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// A merge-queue-required branch surfaces as an error on older gh; treat as queued when the
			// message says so, otherwise it is a genuine block (conflict, failing gate, perms).
			if (/added to the merge queue|enqueued/i.test(msg))
				return { outcome: "queued", detail: msg };
			return { outcome: "blocked", detail: msg };
		}
	}
	if (!token) return null;
	const r = await fetch(
		`https://api.github.com/repos/${repo}/pulls/${number}/merge`,
		{
			method: "PUT",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
			},
			body: JSON.stringify({ merge_method: opts.method }),
		},
	);
	if (r.ok) {
		// A 2xx from the REST merge endpoint does not guarantee the PR has *landed*: the body's
		// `merged` flag is authoritative, and a merge-queue-required branch is enrolled (not merged)
		// in this pass. Trust `merged` when true; otherwise verify the PR's actual state and report
		// `queued` when it hasn't landed yet, so the merge-loop waits for `merge-landed` rather than
		// marking it merged prematurely.
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const body = (await r.json().catch(() => ({}))) as { merged?: boolean };
		if (body.merged) return { outcome: "merged", detail: "merged" };
		const st = await fetchPrState(repo, number, token).catch(() => null);
		if (st?.merged) return { outcome: "merged", detail: "merged" };
		return {
			outcome: "queued",
			detail: "merge accepted; PR not yet landed (awaiting merge queue)",
		};
	}
	const detail =
		`github ${r.status} ${r.statusText}: ${(await r.text()).slice(0, 300)}`.trim();
	return { outcome: "blocked", detail };
}

// ── Merge-protocol execution helpers (issue #43) ────────────────────────────
// Two capabilities the frugal-CI + on-demand-queue landing protocol needs, on top of the plain
// `gh pr merge` above: (a) read an arbitrary file from the target repo to discover its published
// merge protocol, and (b) produce a fresh head `pull_request` run + enqueue via a comment.

/** Read a text file from the *target* repo (default branch) via the configured transport, or
 * `null` when it doesn't exist / no transport is usable. Used to discover a repo's published
 * merge-protocol descriptor (see app/mergeProtocol.ts). Never throws on a 404 — a repo without
 * the file simply has no descriptor. */
export async function fetchRepoFile(
	repo: string,
	path: string,
	token: string,
): Promise<string | null> {
	const apiPath = `repos/${repo}/contents/${path}`;
	if (await useGh()) {
		try {
			return await runGh([
				"api",
				apiPath,
				"-H",
				"Accept: application/vnd.github.raw",
			]);
		} catch {
			return null; // 404 / not found → no descriptor
		}
	}
	if (!token) return null;
	const r = await fetch(`https://api.github.com/${apiPath}`, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github.raw",
		},
	});
	if (!r.ok) return null;
	return await r.text();
}

/** Produce a fresh head `pull_request` run so branch protection has a run to count. `ready` marks
 * a draft ready (`gh pr ready`); `reopen` closes then reopens the PR (the `reopened` event fires a
 * fresh run). gh transport only — headless token mode can't reliably drive these, so it no-ops
 * (the poller then simply keeps waiting, i.e. today's behaviour). Best-effort: resolves even on
 * failure so a transient error never wedges the merge-loop. */
export async function ensureFreshHeadRun(
	repo: string,
	number: number | string,
	action: "ready" | "reopen",
): Promise<boolean> {
	if (!(await useGh())) return false;
	const n = String(number);
	try {
		if (action === "ready") {
			await runGh(["pr", "ready", n, "--repo", repo]);
		} else {
			await runGh(["pr", "close", n, "--repo", repo]);
			await runGh(["pr", "reopen", n, "--repo", repo]);
		}
		return true;
	} catch {
		return false;
	}
}

/** Post a comment on the PR (e.g. `@mergifyio queue`) to enqueue it in the repo's merge queue.
 * gh transport shells out; token mode posts an issue comment via REST. Returns whether the
 * comment was accepted. */
export async function enqueueViaComment(
	repo: string,
	number: number | string,
	token: string,
	comment: string,
): Promise<boolean> {
	const n = String(number);
	if (await useGh()) {
		try {
			await runGh(["pr", "comment", n, "--repo", repo, "--body", comment]);
			return true;
		} catch {
			return false;
		}
	}
	if (!token) return false;
	const r = await fetch(
		`https://api.github.com/repos/${repo}/issues/${n}/comments`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
			},
			body: JSON.stringify({ body: comment }),
		},
	);
	return r.ok;
}
