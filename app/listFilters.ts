// Server-side list filters for GET /status (`listActivePrs`) and GET /escalations
// (`listEscalations`) — issue #1060.
//
// The ONE implementation of the filter vocabulary: parse + validate the query (unknown values → a
// 400 message), then apply it as a pure predicate over the already-projected wire rows. Filters
// combine with AND; a repeatable parameter (`key`, `status`) combines its values with OR. The
// operations wrap the filtered rows in `listEnvelope`, so `page.totalItems` is the filtered count.
import { DELIVERY_GRAPH_RUN_STATUSES } from "./deliveryGraphRun.ts";

/** Every PR `status` value `/status` can serve: the base workflow stages plus the read-time
 *  `incident` / `orphaned` overlays (issues #931, #943). */
export const PR_STATUS_VALUES: readonly string[] = [
  "converging",
  "waiting_review",
  "escalated",
  "waiting_deps",
  "waiting_merge",
  "merging",
  "waiting_lane",
  "queued",
  "converged",
  "merged",
  "abandoned",
  "incident",
  "orphaned",
];

/** Every `status` value accepted by the `/status` `status` filter (PR + delivery-run statuses). */
export const STATUS_FILTER_VALUES: readonly string[] = [
  ...new Set([...PR_STATUS_VALUES, ...DELIVERY_GRAPH_RUN_STATUSES, "incident"]),
];

/** The `/status` row kinds. */
export const STATUS_KIND_VALUES = ["pr", "delivery"] as const;

/** The `/escalations` subject kinds (`subjectType`); `epic` is accepted as the alias of `plan`. */
export const ESCALATION_KIND_VALUES = ["feature", "epic", "plan", "pr", "delivery", "agent"] as const;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A raw query map as the runtime hands it to an operation (a value may repeat). */
export type RawQuery = Record<string, unknown>;

export type FilterParse<T> = { ok: true; filter: T } | { ok: false; error: string };

export interface StatusFilter {
  kinds: string[];
  repos: string[];
  keys: string[];
  statuses: string[];
  hasEscalation: boolean | null;
  updatedSince: number | null;
}

export interface EscalationFilter {
  kinds: string[];
  repos: string[];
  keys: string[];
}

/** All values of one query param, trimmed; accepts a repeated param (array). Enum-like params also
 *  accept a comma-separated single value (`split`); opaque values (`key`) never split, since a run
 *  key may itself contain a comma. Supplied blank values are KEPT so validation can reject them
 *  (a blank filter must 400, not silently widen to the whole list). */
function values(query: RawQuery, name: string, split = true): string[] {
  const raw = query[name];
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.flatMap((v) => (split ? String(v).split(",") : [String(v)])).map((v) => v.trim());
}

function checkBlank(name: string, got: string[]): string | null {
  return got.includes("") ? `blank ${name} filter value` : null;
}

/** An ISO-8601 date-time WITH an explicit timezone (Z or ±hh:mm) and a real calendar date. */
const ISO_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parse a timezone-bearing ISO-8601 timestamp to epoch ms, or null if malformed/invalid. */
export function parseIsoTimestamp(v: string): number | null {
  const m = ISO_TS_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function checkEnum(name: string, got: string[], allowed: readonly string[]): string | null {
  const bad = got.find((v) => !allowed.includes(v));
  return bad === undefined ? null : `unknown ${name} "${bad}" (expected one of: ${allowed.join(", ")})`;
}

function checkRepos(got: string[]): string | null {
  const bad = got.find((v) => !REPO_RE.test(v));
  return bad === undefined ? null : `invalid repo "${bad}" (expected owner/repo)`;
}

/** Parse + validate the `/status` filter query. */
export function parseStatusFilter(query: RawQuery): FilterParse<StatusFilter> {
  const kinds = values(query, "kind");
  const repos = values(query, "repo");
  const keys = values(query, "key", false);
  const statuses = values(query, "status");
  const hasEsc = values(query, "hasEscalation");
  const since = values(query, "updatedSince");
  const sinceMs = since.length === 1 ? parseIsoTimestamp(since[0] ?? "") : null;
  const err =
    checkBlank("kind", kinds) ??
    checkBlank("repo", repos) ??
    checkBlank("key", keys) ??
    checkBlank("status", statuses) ??
    checkBlank("hasEscalation", hasEsc) ??
    checkBlank("updatedSince", since) ??
    checkEnum("kind", kinds, STATUS_KIND_VALUES) ??
    checkRepos(repos) ??
    checkEnum("status", statuses, STATUS_FILTER_VALUES) ??
    checkEnum("hasEscalation", hasEsc, ["true", "false"]) ??
    (hasEsc.length > 1 ? "hasEscalation may be given once" : null) ??
    (since.length > 1 ? "updatedSince may be given once" : null) ??
    (since.length === 1 && sinceMs === null
      ? `invalid updatedSince "${since[0]}" (expected an ISO-8601 date-time with a timezone, e.g. 2026-01-01T00:00:00Z)`
      : null);
  if (err) return { ok: false, error: err };
  return {
    ok: true,
    filter: {
      kinds,
      repos,
      keys,
      statuses,
      hasEscalation: hasEsc.length === 0 ? null : hasEsc[0] === "true",
      updatedSince: sinceMs,
    },
  };
}

/** Parse + validate the `/escalations` filter query. */
export function parseEscalationFilter(query: RawQuery): FilterParse<EscalationFilter> {
  const kinds = values(query, "kind");
  const repos = values(query, "repo");
  const keys = values(query, "key", false);
  const err =
    checkBlank("kind", kinds) ??
    checkBlank("repo", repos) ??
    checkBlank("key", keys) ??
    checkEnum("kind", kinds, ESCALATION_KIND_VALUES) ??
    checkRepos(repos);
  if (err) return { ok: false, error: err };
  return { ok: true, filter: { kinds: kinds.map((k) => (k === "epic" ? "plan" : k)), repos, keys } };
}

/** The `owner/repo` prefix of a `owner/repo#N`-style key, or null. */
export function repoOfKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const hash = key.indexOf("#");
  const repo = hash > 0 ? key.slice(0, hash) : key;
  return REPO_RE.test(repo) ? repo : null;
}

/** The fields of a `/status` row the filter reads. */
export interface StatusFilterRow {
  kind: string;
  status: string;
  updatedAt: string;
  openEscalation: unknown;
  prKey?: unknown;
  repo?: unknown;
  runKey?: unknown;
}

/** Apply a parsed `/status` filter (AND across params, OR within a repeatable one). */
export function applyStatusFilter<R extends StatusFilterRow>(rows: readonly R[], f: StatusFilter): R[] {
  return rows.filter((r) => {
    const prKey = typeof r.prKey === "string" ? r.prKey : null;
    const key = prKey ?? (typeof r.runKey === "string" ? r.runKey : "");
    const repo = typeof r.repo === "string" ? r.repo : repoOfKey(prKey);
    if (f.kinds.length && !f.kinds.includes(r.kind)) return false;
    if (f.repos.length && !(repo !== null && f.repos.includes(repo))) return false;
    if (f.keys.length && !f.keys.includes(key)) return false;
    if (f.statuses.length && !f.statuses.includes(r.status)) return false;
    if (f.hasEscalation !== null && (r.openEscalation != null) !== f.hasEscalation) return false;
    if (f.updatedSince !== null) {
      const t = Date.parse(r.updatedAt);
      if (Number.isNaN(t) || t < f.updatedSince) return false;
    }
    return true;
  });
}

/** The fields of an `/escalations` row the filter reads. */
export interface EscalationFilterRow {
  subjectType: string;
  subjectKey: string;
  prKey: string | null;
  subjectUrl: string | null;
}

const REPO_SCOPED_SUBJECT_TYPES: ReadonlySet<string> = new Set(["pr", "feature", "plan"]);

function escalationRepo(r: EscalationFilterRow): string | null {
  // Only pr/feature/plan subject keys are `owner/repo#N`; delivery/agent keys are opaque
  // (`computeRunKey()`), so inferring a repo from them mis-attributes the row — use the URL.
  const keyIsRepoScoped = REPO_SCOPED_SUBJECT_TYPES.has(r.subjectType) && r.subjectKey.includes("#");
  const fromKey = repoOfKey(r.prKey) ?? (keyIsRepoScoped ? repoOfKey(r.subjectKey) : null);
  if (fromKey) return fromKey;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(r.subjectUrl ?? "");
  return m?.[1] ?? null;
}

/** Apply a parsed `/escalations` filter. `key` matches the subject key or the PR key. */
export function applyEscalationFilter<R extends EscalationFilterRow>(rows: readonly R[], f: EscalationFilter): R[] {
  return rows.filter((r) => {
    if (f.kinds.length && !f.kinds.includes(r.subjectType)) return false;
    if (f.repos.length) {
      const repo = escalationRepo(r);
      if (repo === null || !f.repos.includes(repo)) return false;
    }
    if (f.keys.length && !f.keys.includes(r.subjectKey) && !(r.prKey && f.keys.includes(r.prKey))) return false;
    return true;
  });
}
