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

/** All values of one query param, trimmed, blanks dropped; accepts a repeated param (array) and a
 *  comma-separated single value. */
function values(query: RawQuery, name: string): string[] {
  const raw = query[name];
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
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
  const keys = values(query, "key");
  const statuses = values(query, "status");
  const hasEsc = values(query, "hasEscalation");
  const since = values(query, "updatedSince");
  const err =
    checkEnum("kind", kinds, STATUS_KIND_VALUES) ??
    checkRepos(repos) ??
    checkEnum("status", statuses, STATUS_FILTER_VALUES) ??
    checkEnum("hasEscalation", hasEsc, ["true", "false"]) ??
    (hasEsc.length > 1 ? "hasEscalation may be given once" : null) ??
    (since.length > 1 ? "updatedSince may be given once" : null) ??
    (since.length === 1 && Number.isNaN(Date.parse(since[0] ?? ""))
      ? `invalid updatedSince "${since[0]}" (expected an ISO-8601 timestamp)`
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
      updatedSince: since.length === 0 ? null : Date.parse(since[0] ?? ""),
    },
  };
}

/** Parse + validate the `/escalations` filter query. */
export function parseEscalationFilter(query: RawQuery): FilterParse<EscalationFilter> {
  const kinds = values(query, "kind");
  const repos = values(query, "repo");
  const keys = values(query, "key");
  const err =
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

function escalationRepo(r: EscalationFilterRow): string | null {
  const fromKey = repoOfKey(r.prKey) ?? (r.subjectKey.includes("#") ? repoOfKey(r.subjectKey) : null);
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
