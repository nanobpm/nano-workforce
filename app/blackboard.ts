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

import {
  BLACKBOARD_TABLE,
  BlackboardStore,
  normalizeKind as normalizeStoreKind,
  type SqliteDb,
  BLACKBOARD_KINDS as STORE_KINDS,
} from "@nanobpm/agentic/blackboard";
import type { DataLayer } from "@nanobpm/urban";
import {
  type ContractCategory,
  type DeclarationConflict,
  detectDeclarationConflicts,
  readEnvOr,
} from "./contracts.ts";

// Re-export the storage vocabulary from the shared package so there is ONE canonical definition of
// the kinds, the kind-normaliser, and the unique-violation predicate — the app never keeps a
// parallel copy that could drift from the store's own semantics.
export type { BlackboardKind } from "@nanobpm/agentic/blackboard";
export { BLACKBOARD_KINDS, isUniqueViolation, normalizeKind } from "@nanobpm/agentic/blackboard";


/** The app-recognised blackboard kinds: the shared store's kinds PLUS `contract` — the live,
 * in-flight coordination signal introduced by issue #227 ("I am introducing / consuming contract
 * X"). It is DERIVED from the store's set (spread, never re-typed), so the two never drift; `contract`
 * is the only app-local addition, until the shared package promotes it. The durable source of truth
 * for a contract is the registry (`app/contracts.ts`); this kind is the real-time heads-up that lets
 * siblings in a wave see a new contract before they independently invent a synonym. */
export const APP_BLACKBOARD_KINDS = [...STORE_KINDS, "contract"] as const;
export type AppBlackboardKind = (typeof APP_BLACKBOARD_KINDS)[number];

/** The app-side kind normaliser: passes `contract` through (the store's own normaliser would coerce
 * it to `note`), and defers to the shared normaliser for every other value so unknown kinds still
 * default to `note`. ONE place decides the app's kind vocabulary. */
export function normalizeAppKind(kind: unknown): AppBlackboardKind {
  return kind === "contract" ? "contract" : normalizeStoreKind(kind);
}

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
 * agent runs (co-located or remote/containerised), so it is configured, never hardcoded. Read
 * through the ONE typed env schema ({@link readEnvOr} over `NANO_PR_PUBLIC_BASE_URL`) — there is no
 * second name for this value. The phantom `NANO_PR_BASE_URL` fallback (introduced in #53, cleaned up
 * per #223) is recorded as a rejected synonym in `app/contracts.ts`, so it can never be reintroduced
 * as a silent runtime fallback. */
export function publicBaseUrl(base: string = readEnvOr("NANO_PR_PUBLIC_BASE_URL")): string {
  // Skip a blank/whitespace value so an explicitly-set-but-empty NANO_PR_PUBLIC_BASE_URL can't yield
  // a malformed capability URL; fall back to the schema-declared default.
  const resolved = base.trim() || readEnvOr("NANO_PR_PUBLIC_BASE_URL");
  return resolved.replace(/\/+$/, "");
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
\`scope-change\` (your contract/scope shifted), \`contract\` (you are introducing/consuming a shared
env key / wire shape / type / capability-URL scheme — see below), \`learning\` (see below), or
\`note\`. Set
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

**Coordinate SHARED CONTRACTS before you invent one (issue #227).** A *contract* is anything two
slices must agree on but that each of you could author independently against a mock: an **env/config
key**, a **wire-frame shape** (a message/relay payload), a **shared exported type/interface name**, or
a **capability-URL scheme**. Divergent copies of one contract (an env-key synonym, a producer/hub
wire-shape drift) are only discovered at runtime, after both sides are green against their own mock.
Prevent it:

- **Consult the durable contract registry FIRST** (\`app/contracts.ts\` — env keys go through the ONE
  typed \`ENV_CONTRACTS\` schema; wire/type/capability-URL contracts are declared alongside). If a
  semantically-equivalent contract already exists, **reuse it** (import the shared type, read the
  existing env key) — never author a synonym. A retired synonym (e.g. \`NANO_PR_BASE_URL\`) is a hard
  CI failure, not a fallback.
- **Consult the blackboard \`contract\` entries** below for what siblings are introducing *right now*.
- **When you introduce OR consume a cross-cutting contract, POST a \`contract\` entry** so siblings see
  it before they reinvent it, and add the durable declaration to \`app/contracts.ts\`:

      curl -s -X POST "${url}" -H 'content-type: application/json' \\
        -d '{"author_task":"<your-task-id>","kind":"contract","dedupe_key":"env:NANO_X","body":"introducing env key NANO_X — <owner> — <semantics + default>"}'

The write-time guard reports a \`conflicts\` array on a \`contract\` POST when your declaration looks like
a synonym of, or contradicts, an existing contract — reconcile before proceeding.

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

/** Narrow a SQLite row id (`number | bigint`) to a JS number, failing loudly if it exceeds the
 * safe-integer range. Blackboard rowids are monotonic and stay far below 2^53 in practice, but the
 * driver types the id as `number | bigint`; coercing a huge bigint via `Number(...)` would silently
 * lose precision and corrupt the id where it is used as a `since` cursor. We narrow ONCE here so the
 * union never escapes `appendEntry` and no caller re-coerces. Both branches guard the safe-integer
 * boundary: a `bigint` above `MAX_SAFE_INTEGER`, or a driver-returned `number` that is somehow not a
 * safe integer, both throw rather than silently yield a lossy cursor. */
export function toSafeRowId(id: number | bigint): number {
  if (typeof id === "bigint") {
    if (id > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `blackboard row id ${id} exceeds Number.MAX_SAFE_INTEGER; unsafe to narrow to a JS number cursor`,
      );
    }
    return Number(id);
  }
  if (!Number.isSafeInteger(id)) {
    throw new Error(
      `blackboard row id ${id} is not a safe integer; unsafe to use as a JS number cursor`,
    );
  }
  return id;
}

/** Append an entry, idempotently. A blank `body` is rejected. When a `dedupe_key` is supplied and
 * an entry already exists for it on this plan, the write is a no-op and the existing id is
 * returned (`inserted: false`) — so an engine job retry re-POSTing the same fact never duplicates.
 *
 * The `contract` kind (issue #227) is the app-local addition: the shared store's normaliser would
 * coerce it to `note`, so after the store's insert (which owns all the idempotency/dedupe semantics)
 * we patch the ONE row's kind column back to `contract`. We reuse the store's insert rather than
 * hand-writing a parallel one, so there is no drift in the append logic — only the kind vocabulary is
 * app-extended. */
export async function appendEntry(
  data: DataLayer,
  planKey: string,
  input: BlackboardInput,
): Promise<{ inserted: boolean; id: number }> {
  const appKind = normalizeAppKind(input.kind);
  const res = storeFor(data).append(planKey, {
    authorTask: input.author_task,
    kind: input.kind,
    files: input.files,
    body: input.body,
    wave: input.wave,
    dedupeKey: input.dedupe_key,
  });
  if (appKind === "contract") {
    // The store defaulted `kind` to `note` (its normaliser doesn't know `contract`); restore it on
    // the resolved row. Patch on EVERY `contract` append — not only when `res.inserted` — so an
    // idempotent retry (or a race) that resolves to an existing id (`inserted: false`), or a row
    // first inserted under a different kind for the same `dedupe_key`, still reads back as `contract`
    // rather than lingering as `note`. The UPDATE is idempotent on an already-`contract` row.
    // Bind `res.id` as-is (it is `number | bigint`) — coercing a bigint id via `Number(...)` could
    // lose precision above `Number.MAX_SAFE_INTEGER` and patch the wrong row; SQLite binds bigint natively.
    data.source().db.run(`UPDATE ${BLACKBOARD_TABLE} SET kind = 'contract' WHERE id = ?`, [res.id]);
  }
  return { inserted: res.inserted, id: toSafeRowId(res.id) };
}

/** Parse a `contract` entry's `dedupe_key` convention `<category>:<name>` (e.g. `env:NANO_X`,
 * `type:BlackboardEntry`). Returns the category+name when it parses, else undefined. */
export function parseContractRef(
  dedupeKey: string | undefined,
): { category: ContractCategory; name: string } | undefined {
  if (!dedupeKey) return undefined;
  const idx = dedupeKey.indexOf(":");
  if (idx <= 0) return undefined;
  const category = dedupeKey.slice(0, idx).trim();
  const name = dedupeKey.slice(idx + 1).trim();
  if (!name) return undefined;
  if (category === "env" || category === "wire" || category === "type" || category === "capability-url") {
    return { category, name };
  }
  return undefined;
}

/** Write-time near-duplicate DECLARATION detection for a `contract` POST (issue #227, AC4). Extends
 * the store's conflict reporting (`file-claim`) to the declaration surface: given a proposed contract
 * (its `<category>:<name>` from `dedupe_key`, its semantics from `body`), report any registry entry
 * that is a synonym (same thing, different name), a contradiction (same name, different meaning), or a
 * rejected synonym (a retired name). Advisory — surfaced to the writer, never a lock. Returns `[]`
 * when the entry doesn't carry the `<category>:<name>` convention (nothing to reconcile against). */
export function detectContractDeclarationConflicts(opts: {
  dedupe_key?: string;
  body: string;
}): DeclarationConflict[] {
  const ref = parseContractRef(opts.dedupe_key);
  if (!ref) return [];
  return detectDeclarationConflicts({ category: ref.category, name: ref.name, semantics: opts.body });
}
