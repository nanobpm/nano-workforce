// GET/POST /hooks/blackboard?token=<capabilityToken> — the epic coordination blackboard endpoint
// (Tier 1, issues #51 / #49 D4).
//
// This is a DIRECT side-channel for agents, distinct from the c8ctl-nano activation/completion
// channel. The per-plan capability token (query string) IS the credential: it scopes every read
// and write to exactly one plan, so no shared secret is needed — the agent curls the exact URL it
// was handed in its prompt. An unknown token is a 404 (never leaks which plans exist).
//
//   GET  → { planKey, entries: [ { id, author_task, kind, files, body, wave, created_at } ], cursor }
//          optional ?since=<id> returns only entries with id > since (incremental poll). `cursor` is
//          the plan's current head id; pass it back as `since` on the next poll (Tier 2).
//   POST → append one entry: { author_task?, kind?, files?, body, wave?, dedupe_key? }. Idempotent
//          on (plan, dedupe_key). Returns { id, inserted, conflicts } — `conflicts` lists prior
//          sibling `file-claim`s on the same file(s) (advisory first-writer-wins; never a lock).
import type { ActionHandler } from "@nanobpm/urban";
import {
	appendEntry,
	detectFileClaimConflicts,
	normalizeKind,
	planKeyForToken,
	readBlackboardPage,
} from "../app/blackboard.ts";

const handler: ActionHandler = async ({ req, body }, app) => {
	const token = (
		req.query.get("token") ??
		req.headers.get("x-blackboard-token") ??
		""
	).trim();
	if (!token)
		return { status: 400, body: { error: "missing blackboard token" } };
	const planKey = await planKeyForToken(app.data, token);
	if (!planKey)
		return { status: 404, body: { error: "unknown blackboard token" } };

	if (req.method === "GET") {
		const rawSince = req.query.get("since");
		const since =
			rawSince != null && /^\d+$/.test(rawSince) ? Number(rawSince) : undefined;
		const { entries, cursor } = await readBlackboardPage(app.data, planKey, {
			since,
		});
		return { status: 200, body: { planKey, entries, cursor } };
	}

	if (req.method === "POST") {
		// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
		const b = (body ?? {}) as Record<string, unknown>;
		const text = typeof b.body === "string" ? b.body.trim() : "";
		if (!text)
			return {
				status: 400,
				body: { error: "'body' (the note text) is required" },
			};
		const kind = normalizeKind(b.kind);
		const files = Array.isArray(b.files) ? b.files.map(String) : [];
		// Normalize once (trim + default to "system") so the value we send to appendEntry matches the
		// value we send to detectFileClaimConflicts. Otherwise an omitted/blank author_task is stored as
		// "system" but conflict detection sees "", and the caller's own prior "system" claims are wrongly
		// reported as sibling conflicts.
		const author_task =
			(typeof b.author_task === "string" ? b.author_task.trim() : "") ||
			"system";
		const res = await appendEntry(app.data, planKey, {
			author_task,
			kind,
			files,
			body: text,
			wave: typeof b.wave === "number" ? b.wave : null,
			dedupe_key: typeof b.dedupe_key === "string" ? b.dedupe_key : undefined,
		});
		// Advisory conflict-of-intent: surface prior sibling claims on the same file(s). Computed AFTER
		// the append and filtered to claims strictly before ours (id < res.id), so first-writer-wins is
		// decided by insertion order — a sibling that raced a claim in between is still caught, and our
		// own just-written row is never reported. Never blocks the append — the agent decides how to react.
		const conflicts =
			kind === "file-claim"
				? await detectFileClaimConflicts(app.data, planKey, {
						author_task,
						files,
						beforeId: Number(res.id),
					})
				: [];
		return {
			status: res.inserted ? 201 : 200,
			body: { id: Number(res.id), inserted: res.inserted, conflicts },
		};
	}

	return {
		status: 405,
		body: { error: "method not allowed (use GET or POST)" },
	};
};

export default handler;
