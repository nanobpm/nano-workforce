// nano-workforce — epic coordination blackboard (Tier 1, issues #51 / #49 D4).
//
// A per-plan advisory shared store. Implementer agents (`senior:feature`) READ it on dispatch and
// WRITE to it during/after their work — "I now also touch state.rs", "constraint X changed
// direction Y" — so parallel siblings in a wave can coordinate without a human relay.
//
// H4 (#147, ADR 0056) GENERALISED the storage onto `@nanobpm/agentic/blackboard`'s first-class,
// capability-scoped `BlackboardStore` (table `agentic_blackboard`) — the SAME store the new
// agentic-channel `blackboard` family serves, over the SAME app SQLite DataLayer. This module is now
// the app-side ADAPTER: it keeps the exact HTTP-hook surface (snake_case entries, `plan_key` scope,
// token→plan resolution) callers already depend on — `operations/{appendBlackboard,readBlackboard}`,
// `app/retro.ts`, `app/plan.ts`, `workers/record-wave` — while the append/read/dedupe/conflict
// SEMANTICS live once in the shared store (no drift surface). The idempotency, `file-claim`
// conflict reporting, and `since`/cursor incremental-read behaviour are identical to before because
// the store is a faithful port of the original `plan_blackboard` logic.
//
// Design invariants (unchanged):
//   - ADVISORY ONLY. Never gate a sequence flow on a blackboard read; the BPMN stays the
//     control-flow source of truth. This store is shared *knowledge*, read fresh, and is not part
//     of deterministic replay.
//   - IDEMPOTENT write-back. The engine may re-activate a job on retry, so a re-POST carrying a
//     stable `dedupe_key` is a no-op (backed by a unique index; the store also short-circuits).
//   - CAPABILITY URL. The per-plan token IS the credential; the agent curls the exact URL it was
//     handed (delivered in `appendPrompt`). Delivery is in-band (rides the prompt the harness
//     already forwards); use is out-of-band (a direct side-channel to `/app/api/hooks/blackboard`).
//
// Storage goes through the shared `BlackboardStore` over the app DataLayer's raw synchronous SQLite
// handle (`data.source().db`) — the same physical database the record gateway (`data.table`) uses,
// so the HTTP hook and the agentic channel share one connection and one table.

import { BlackboardStore, type SqliteDb } from "@nanobpm/agentic/blackboard";
import type { DataLayer } from "@nanobpm/urban";

// Re-export the storage vocabulary from the shared package so there is ONE canonical definition of
// the kinds, the kind-normaliser, and the unique-violation predicate — the app never keeps a
// parallel copy that could drift from the store's own semantics.
export type { BlackboardKind } from "@nanobpm/agentic/blackboard";
export { BLACKBOARD_KINDS, isUniqueViolation, normalizeKind } from "@nanobpm/agentic/blackboard";

/** The parsed, agent-facing view of an entry (files decoded to an array). Snake_case is the
 * app/HTTP-hook boundary contract every existing caller and agent already consumes. */
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
export function publicBaseUrl(env: string | undefined = process.env.NANO_WORKFORCE_BASE_URL): string {
  // Skip the override if it is unset OR blank/whitespace, so an explicitly-set-but-empty
  // NANO_WORKFORCE_BASE_URL can't yield a malformed capability URL.
  const base =
    [env, "http://localhost:3000"]
      .map((v) => v?.trim())
      .find((v): v is string => Boolean(v)) ?? "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

/** The capability URL for a plan's blackboard: the token rides the query string, so the agent can
 * GET/POST the exact string it was handed with no header assembly. */
export function blackboardUrl(token: string, base: string = publicBaseUrl()): string {
  return `${base}/app/api/hooks/blackboard?token=${encodeURIComponent(token)}`;
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

// The store is a thin wrapper over the DataLayer's raw synchronous SQLite handle; construct it per
// call (cheap — it just holds the handle). The schema is applied by boot migration
// `025_agentic_blackboard.sql`; we also `ensureSchema()` once per handle (idempotent
// `CREATE TABLE IF NOT EXISTS`) so the adapter works against a bare source too (e.g. unit tests over
// an in-memory DataLayer that hasn't run migrations).
const schemaReady = new WeakSet<object>();
function storeFor(data: DataLayer): BlackboardStore {
  const db = data.source().db;
  const store = new BlackboardStore(db);
  if (!schemaReady.has(db)) {
    store.ensureSchema();
    schemaReady.add(db);
  }
  return store;
}

/** Map the store's camelCase entry to the app/HTTP snake_case boundary shape. */
function toEntry(e: {
  id: number;
  authorTask: string;
  kind: string;
  files: string[];
  body: string;
  wave: number | null;
  createdAt: string;
}): BlackboardEntry {
  return {
    id: e.id,
    author_task: e.authorTask,
    kind: e.kind,
    files: e.files,
    body: e.body,
    wave: e.wave,
    created_at: e.createdAt,
  };
}

/** Resolve a capability token back to its plan, or undefined when the token is unknown. Async
 * variant over the record gateway, used by the HTTP-hook operations. */
export async function planKeyForToken(data: DataLayer, token: string): Promise<string | undefined> {
  if (!token) return undefined;
  const row = await data
    .table<{ plan_key: string; blackboard_token: string | null }>("plans", "plan_key")
    .findOne({ blackboard_token: token });
  return row?.plan_key;
}

/** Resolve a capability token back to its plan over a raw synchronous SQLite handle. The agentic
 * channel's `blackboard` family derives its board `scope` synchronously from the connection's
 * capability credential, so it needs this sync path (the async {@link planKeyForToken} can't be
 * awaited in a synchronous `scopeOf`). Both resolve the SAME `plans.blackboard_token` mapping, so
 * the channel and the HTTP hook scope every plan's board to the identical `plan_key`. */
export function planKeyForTokenSync(db: SqliteDb, token: string): string | undefined {
  if (!token) return undefined;
  const rows = db.all<{ plan_key: string }>(
    "SELECT plan_key FROM plans WHERE blackboard_token = ? LIMIT 1",
    [token],
  );
  return rows[0]?.plan_key;
}

/** One incremental read: the entries after `since` (write order) plus `cursor` — the plan's current
 * head id. An agent polling midflight passes `cursor` back as the next `since`, so it pulls only
 * what siblings added since its last read. `cursor` is the true head even when `since` filters every
 * entry out, so a caller that is fully caught up learns it is caught up (cursor unchanged). */
export interface BlackboardPage {
  entries: BlackboardEntry[];
  cursor: number;
}

export async function readBlackboardPage(
  data: DataLayer,
  planKey: string,
  opts: { since?: number } = {},
): Promise<BlackboardPage> {
  const page = storeFor(data).readPage(planKey, { since: opts.since });
  return { entries: page.entries.map(toEntry), cursor: page.cursor };
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
  return storeFor(data)
    .detectFileClaimConflicts(planKey, {
      authorTask: opts.author_task,
      files: opts.files,
      beforeId: opts.beforeId,
    })
    .map((c) => ({
      file: c.file,
      author_task: c.authorTask,
      id: c.id,
      body: c.body,
      created_at: c.createdAt,
    }));
}

/** Append an entry, idempotently. A blank `body` is rejected. When a `dedupe_key` is supplied and
 * an entry already exists for it on this plan, the write is a no-op and the existing id is
 * returned (`inserted: false`) — so an engine job retry re-POSTing the same fact never duplicates. */
export async function appendEntry(
  data: DataLayer,
  planKey: string,
  input: BlackboardInput,
): Promise<{ inserted: boolean; id: number | bigint }> {
  return storeFor(data).append(planKey, {
    authorTask: input.author_task,
    kind: input.kind,
    files: input.files,
    body: input.body,
    wave: input.wave,
    dedupeKey: input.dedupe_key,
  });
}
