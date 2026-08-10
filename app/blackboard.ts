// nano-workforce — epic coordination blackboard (Tier 1, issues #51 / #49 D4).
//
// A per-plan advisory shared store. Implementer agents (`senior:feature`) READ it on dispatch and
// WRITE to it during/after their work — "I now also touch state.rs", "constraint X changed
// direction Y" — so parallel siblings in a wave can coordinate without a human relay. It is the
// machine-actionable substrate the #614 retro's "structured coordination channel" asked for.
//
// Design invariants:
//   - ADVISORY ONLY. Never gate a sequence flow on a blackboard read; the BPMN stays the
//     control-flow source of truth. This store is shared *knowledge*, read fresh, and is not part
//     of deterministic replay.
//   - IDEMPOTENT write-back. The engine may re-activate a job on retry, so a re-POST carrying a
//     stable `dedupe_key` is a no-op (backed by a unique index; we also short-circuit here).
//   - CAPABILITY URL. The per-plan token IS the credential; the agent curls the exact URL it was
//     handed (delivered in `appendPrompt`). Delivery is in-band (rides the prompt the harness
//     already forwards); use is out-of-band (a direct side-channel to `/hooks/blackboard`).
//
// Data access goes through the record gateway (`data.table`), never hand-written SQL — matching
// app/service.ts and app/plan.ts.
import type { DataLayer } from "@nanobpm/urban";

const now = () => new Date().toISOString();

export const BLACKBOARD_KINDS = ["file-claim", "constraint-change", "scope-change", "learning", "note"] as const;
export type BlackboardKind = (typeof BLACKBOARD_KINDS)[number];

/** The stored row shape (files is a JSON-encoded string of paths, or NULL). */
export interface BlackboardRow {
  id: number;
  plan_key: string;
  author_task: string;
  kind: string;
  files: string | null;
  body: string;
  wave: number | null;
  dedupe_key: string | null;
  created_at: string;
}

/** The parsed, agent-facing view of an entry (files decoded to an array). */
export interface BlackboardEntry {
  id: number;
  author_task: string;
  kind: string;
  files: string[];
  body: string;
  wave: number | null;
  created_at: string;
}

/** What a writer supplies to {@link appendEntry}. `files`/`wave`/`dedupe_key` are optional. */
export interface BlackboardInput {
  author_task?: string;
  kind?: unknown;
  files?: string[];
  body: string;
  wave?: number | null;
  dedupe_key?: string;
}

const KIND_SET = new Set<string>(BLACKBOARD_KINDS);

/** Coerce an arbitrary `kind` to a known value, defaulting to "note" for anything unrecognised. */
export function normalizeKind(kind: unknown): BlackboardKind {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  return typeof kind === "string" && KIND_SET.has(kind) ? (kind as BlackboardKind) : "note";
}

/** A URL-safe, unguessable capability token (192 bits of randomness, base64url, no padding). */
export function mintBlackboardToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The externally-reachable base URL agents use to reach this app. Must resolve from WHEREVER the
 * agent runs (co-located or remote/containerised), so it is configured, never hardcoded. */
export function publicBaseUrl(env: string | undefined = process.env.NANO_PR_PUBLIC_BASE_URL): string {
  // Cascade through the fallback chain, skipping any value that is unset OR blank/whitespace, so an
  // explicitly-set-but-empty NANO_PR_PUBLIC_BASE_URL can't yield a malformed capability URL.
  const base =
    [env, process.env.NANO_PR_BASE_URL, "http://localhost:3000"]
      .map((v) => v?.trim())
      .find((v): v is string => Boolean(v)) ?? "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

/** The capability URL for a plan's blackboard: the token rides the query string, so the agent can
 * GET/POST the exact string it was handed with no header assembly. */
export function blackboardUrl(token: string, base: string = publicBaseUrl()): string {
  return `${base}/hooks/blackboard?token=${encodeURIComponent(token)}`;
}

/** The coordination-protocol block appended (verbatim, via `appendPrompt`) to each implementer
 * agent's prompt. `appendPrompt` injects NO separator, so this owns its own leading rule. It
 * carries the concrete, curl-able URL for THIS plan plus the read/write contract. */
export function renderCoordinationBrief(url: string): string {
  return `

---

## Epic coordination blackboard

You are one of several agents implementing tasks for this epic in parallel. A shared, per-epic
**blackboard** lets you coordinate with your siblings without a human relay. It is ADVISORY: read it
for heads-ups, and post when your work affects others. It never blocks you.

Your blackboard endpoint (already scoped to this epic — no auth header needed):

    ${url}

**On start — READ it** to see what siblings have claimed, changed, or **learned**:

    curl -s "${url}"

Returns \`{ "planKey": "...", "cursor": <head-entry-id>, "entries": [ { "id", "author_task", "kind", "files", "body", "wave", "created_at" }, ... ] }\` (\`cursor\` is the head entry id, or \`0\` for an empty plan).
If an entry overlaps your slice (same file, a changed contract/constraint), adapt: coordinate,
rebase your plan, or if it genuinely blocks you, escalate with a \`question\` per your normal contract.
**Apply prior \`learning\` entries before you start** — a gotcha a sibling already hit (e.g. "run
\`make generate\` before \`cargo build\` or the build fails on a stale generated surface") saves you
from re-discovering it the hard way.

**When your work affects others — POST an entry** (do this as soon as it's true, not only at the end):

    curl -s -X POST "${url}" -H 'content-type: application/json' \\
      -d '{"author_task":"<your-task-id>","kind":"file-claim","files":["path/to/file"],"body":"why"}'

\`kind\` is one of: \`file-claim\` (you now edit a file outside your original slice),
\`constraint-change\` (you discovered a constraint that changes another task's direction),
\`scope-change\` (your contract/scope shifted), \`learning\` (see below), or \`note\`. Set
\`author_task\` to your task id. If a retry might make you re-POST the same fact, include a stable
\`"dedupe_key"\` so it collapses to one entry.

**Share what you learn — POST a \`learning\`.** Whenever you hit a **reusable, non-obvious gotcha**
that a sibling working this repo would also hit — a required build/codegen step, a test or lint
incantation, an environment/toolchain footgun, a workaround for a sharp edge — post it immediately
so nobody re-learns it independently, and so we can later lift the recurring ones into a script, CI,
or \`AGENTS.md\`. Keep the \`body\` concrete and actionable (the exact command / the exact cause), and
give it a stable \`"dedupe_key"\` (e.g. a short slug of the gotcha) so the same learning collapses to
one entry across retries and siblings:

    curl -s -X POST "${url}" -H 'content-type: application/json' \\
      -d '{"author_task":"<your-task-id>","kind":"learning","dedupe_key":"regen-before-build","body":"Run \`make generate\` before \`cargo build --features console\` — a stale generated surface fails the build with a confusing error."}'

A \`learning\` is advisory and never blocks anyone; it is knowledge for the fleet, not a claim on a file.

**Stay in sync while you work (this matters most while siblings run in parallel).** The GET
response includes a \`"cursor"\`. Re-read incrementally — before you start each new file, and at
least every few minutes on long tasks — passing the last cursor back as \`since\` so you fetch only
what's new:

    curl -s "${url}&since=<cursor>"

**React to a file-claim conflict.** When you POST a \`file-claim\`, the response includes
\`"conflicts"\`: any prior claims by siblings on the same file(s). First claim wins (advisory). If a
conflict names you as the later claimer, don't barge in — back off that file, post a \`note\` to
coordinate, or if it genuinely blocks you, escalate a \`question\` per your normal contract. Nothing
here is a hard lock; the merge step is the real safety net.`;
}

const blackboardTable = (data: DataLayer) => data.table<BlackboardRow>("plan_blackboard", "id");

/** Resolve a capability token back to its plan, or undefined when the token is unknown. */
export async function planKeyForToken(data: DataLayer, token: string): Promise<string | undefined> {
  if (!token) return undefined;
  const row = await data
    .table<{ plan_key: string; blackboard_token: string | null }>("plans", "plan_key")
    .findOne({ blackboard_token: token });
  return row?.plan_key;
}

function decodeFiles(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter((s) => s !== "") : [];
  } catch {
    return [];
  }
}

function toEntry(r: BlackboardRow): BlackboardEntry {
  return {
    id: r.id,
    author_task: r.author_task,
    kind: r.kind,
    files: decodeFiles(r.files).map((x) => x.trim()).filter((x) => x !== ""),
    body: r.body,
    wave: r.wave,
    created_at: r.created_at,
  };
}

/** One incremental read: the entries after `since` (write order) plus `cursor` — the plan's current
 * head id. An agent polling midflight (Tier 2) passes `cursor` back as the next `since`, so it pulls
 * only what siblings added since its last read. `cursor` is the true head even when `since` filters
 * every entry out, so a caller that is fully caught up learns it is caught up (cursor unchanged). */
export interface BlackboardPage {
  entries: BlackboardEntry[];
  cursor: number;
}

export async function readBlackboardPage(
  data: DataLayer,
  planKey: string,
  opts: { since?: number } = {},
): Promise<BlackboardPage> {
  const rows = await blackboardTable(data).find({ plan_key: planKey });
  const cursor = rows.reduce((max, r) => (r.id > max ? r.id : max), 0);
  const since = opts.since ?? 0;
  const entries = rows
    .filter((r) => r.id > since)
    .sort((a, b) => a.id - b.id)
    .map(toEntry);
  return { entries, cursor };
}

/** A plan's entries in write order (id asc). `since` returns only entries with `id > since`. */
export async function readBlackboard(
  data: DataLayer,
  planKey: string,
  opts: { since?: number } = {},
): Promise<BlackboardEntry[]> {
  return (await readBlackboardPage(data, planKey, opts)).entries;
}

/** An advisory conflict-of-intent: a sibling has already claimed a file this writer is about to
 * claim. Reported per (file, prior claim) so the later claimer can back off, coordinate, or escalate.
 * First-writer-wins is advisory only — the blackboard NEVER locks; merge-time gates are the real
 * safety net. */
export interface ClaimConflict {
  file: string;
  author_task: string;
  id: number;
  body: string;
  created_at: string;
}

/** Prior `file-claim` entries by OTHER authors on this plan that overlap `files`. Used by the
 * endpoint to surface conflicts on a `file-claim` POST; a writer's own earlier claim is never a
 * conflict with itself. Pass `beforeId` to restrict to strictly prior claims (`id < beforeId`) —
 * the endpoint computes conflicts AFTER inserting its own claim and sets `beforeId` to that new id,
 * so first-writer-wins is decided by insertion order and a sibling claim that raced in concurrently
 * is still surfaced (its row exists by the time we read) without ever matching our own just-written
 * row. */
export async function detectFileClaimConflicts(
  data: DataLayer,
  planKey: string,
  opts: { author_task?: string; files: string[]; beforeId?: number },
): Promise<ClaimConflict[]> {
  const want = new Set((opts.files ?? []).map((f) => String(f).trim()).filter((s) => s !== ""));
  if (want.size === 0) return [];
  const me = opts.author_task?.trim() || "";
  const beforeId = opts.beforeId;
  const rows = await blackboardTable(data).find({ plan_key: planKey, kind: "file-claim" });
  const out: ClaimConflict[] = [];
  for (const r of rows.slice().sort((a, b) => a.id - b.id)) {
    if (beforeId != null && r.id >= beforeId) continue;
    if ((r.author_task || "") === me) continue;
    for (const f of new Set(decodeFiles(r.files).map((x) => x.trim()).filter((x) => x !== ""))) {
      if (want.has(f)) {
        out.push({ file: f, author_task: r.author_task, id: r.id, body: r.body, created_at: r.created_at });
      }
    }
  }
  return out;
}

/** Append an entry, idempotently. A blank `body` is rejected. When a `dedupe_key` is supplied and
 * an entry already exists for it on this plan, the write is a no-op and the existing id is
 * returned (`inserted: false`) — so an engine job retry re-POSTing the same fact never duplicates. */
export async function appendEntry(
  data: DataLayer,
  planKey: string,
  input: BlackboardInput,
): Promise<{ inserted: boolean; id: number | bigint }> {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new Error("blackboard entry requires a non-empty body");
  const table = blackboardTable(data);
  const dedupe_key = input.dedupe_key?.trim() || undefined;
  if (dedupe_key) {
    const existing = await table.findOne({ plan_key: planKey, dedupe_key });
    if (existing) return { inserted: false, id: existing.id };
  }
  const files = (input.files ?? []).map(String).map((s) => s.trim()).filter((s) => s !== "");
  try {
    const id = await table.insert({
      plan_key: planKey,
      author_task: input.author_task?.trim() || "system",
      kind: normalizeKind(input.kind),
      files: files.length ? JSON.stringify(files) : null,
      body,
      wave: typeof input.wave === "number" ? input.wave : null,
      dedupe_key: dedupe_key ?? null,
      created_at: now(),
    });
    return { inserted: true, id };
  } catch (err) {
    // Idempotent write-back under concurrency: two POSTs sharing a dedupe_key can both miss the
    // findOne pre-check above, then one loses the race on the UNIQUE (plan_key, dedupe_key) index.
    // Convert that collision into a no-op by re-reading the winner's row, so a retry never 500s.
    if (dedupe_key && isUniqueViolation(err)) {
      const existing = await table.findOne({ plan_key: planKey, dedupe_key });
      if (existing) return { inserted: false, id: existing.id };
    }
    throw err;
  }
}

/** True only for a UNIQUE / PRIMARY-KEY / duplicate violation — never a foreign-key or other
 * constraint failure. We match the *specific* violation (extended SQLite codes, or the specific
 * words) rather than the bare word "constraint", so a `FOREIGN KEY constraint failed` (real data
 * corruption, not a benign duplicate) is always rethrown rather than silently swallowed. */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" &&
    /(unique|primary key) constraint failed|duplicate/i.test(message);
}