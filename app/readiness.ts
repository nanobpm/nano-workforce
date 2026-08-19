// nano-workforce — the generic artifact-readiness ReadinessProbe (ADR 0001 §2, issue #258).
//
// This is the CODE half of the durable wait-gate primitive. The gate itself is modelled in the
// engine (`resources/processes/readiness-gate.bpmn`): a service task (`pr.readiness-probe`, whose
// executor lives in `workers/readiness-probe/`) races, through an event-based gateway, the
// readiness message it publishes when a probe goes green against a timer catch that bounds the
// wait and escalates. The engine owns token semantics; this module only *reads* readiness, so a
// restarted worker simply re-probes (idempotent / resumable).
//
// The probe is DATA, not code — a {@link ReadinessProbe} descriptor with a `kind` and a per-kind
// `match` predicate. Authors add a readiness source by adding a `kind`'s matcher, never by editing
// the BPMN or the worker's control flow. Five built-in kinds ship (`http`, `command`, `npm`,
// `github-check`, `capability`); everything else is reached through the `command` escape hatch
// (ADR 0001 §2 pinned decision 1). The `capability` kind (ADR 0001 §4, issue #274) resolves a
// cross-repo capability edge — "which published version first carries capability C?" — from the
// publish-provenance substrate and late-binds the discovered `pkg@version` back through the gate
// via {@link ProbeResult.bind}, the reusable emit primitive. A probe carries NO secret material —
// any credential is read at execution time from the typed env-contract (`credentialEnv` names a
// declared {@link EnvKey}; ADR 0004 pinned decision 2) and is redacted from every log line.
import { isEnvKey, readEnv, readEnvOr } from "./contracts.ts";
import { isoDuration, isoDurationToMs } from "./reviewWait.ts";

/** The built-in readiness sources. `command` is the escape hatch that subsumes the long tail
 * (`gh`, `curl`, `docker manifest inspect`, a custom probe) — adding a first-class kind later is
 * an additive matcher, not a schema change. `capability` is the first such additive kind (#274):
 * it resolves "which published version first carries capability C?" from the publish-provenance
 * substrate and binds the discovered `pkg@version` back through the gate (see {@link matchCapability}). */
export type ProbeKind = "http" | "command" | "npm" | "github-check" | "capability";

/** What the gate does when the bounded wait times out (the engine timer arm fires). */
export type OnTimeout = "escalate" | "fail" | "continue";

/** Backoff policy between poll attempts. */
export type Backoff = "fixed" | "exponential";

const PROBE_KINDS: readonly ProbeKind[] = ["http", "command", "npm", "github-check", "capability"];
const ON_TIMEOUTS: readonly OnTimeout[] = ["escalate", "fail", "continue"];
const BACKOFFS: readonly Backoff[] = ["fixed", "exponential"];

/** The per-kind readiness predicate. Every field is optional; each kind reads only the ones it
 * understands and applies a sensible default when a field is absent (see the matchers below). */
export interface ProbeMatch {
  /** http: the exact HTTP status that means ready (default: any 2xx). */
  readonly status?: number;
  /** http: a substring the response body must contain. */
  readonly bodyIncludes?: string;
  /** command: the exit code that means ready (default: 0). */
  readonly exitCode?: number;
  /** command / npm: a substring stdout must contain. */
  readonly stdoutIncludes?: string;
  /** npm: the version that must be published (default: the version in `pkg@version`). */
  readonly version?: string;
  /** github-check: the check-run conclusion that means ready (default: "success"). */
  readonly conclusion?: string;
  /** github-check: restrict the predicate to the named check run (default: every check run). */
  readonly checkName?: string;
  /** capability: the upstream issue/PR handle the resolved version must carry in its publish
   * provenance — `nano-ide#274` or the bare `#274`. Required for the `capability` kind. */
  readonly capabilityRef?: string;
  /** capability: the package whose releases are scanned (e.g. `@nanobpm/urban`). Provenance is
   * per-package scoped — the same `#C` may appear in two packages — so this is required. */
  readonly package?: string;
  /** capability: an OPTIONAL empirical verifier command for the gated fallback (decision 5). Run
   * ONCE at the gate boundary (poll budget exhausted) against the newest published `package`
   * version when deterministic provenance resolved nothing; exit 0 binds that newest version. Left
   * unset, the capability edge is deterministic-only. The resolved `pkg@version` and bare version
   * are exposed to the command as `RESOLVED_ARTIFACT` / `RESOLVED_VERSION`. */
  readonly verifyCommand?: string;
}

/** The poll cadence: how often to re-probe, how long to keep trying, and the backoff shape. */
export interface ProbePoll {
  readonly everyMs?: number;
  readonly timeoutMs?: number;
  readonly backoff?: Backoff;
}

/** A declared readiness probe — the whole descriptor the gate is handed as a process variable.
 * Scalar + nested-object shape mirrored by the `ReadinessProbe` `nano:shape` in the BPMN so it is
 * typed end-to-end. Carries NO secret: `credentialEnv` names a declared env-contract key, never a
 * value. */
export interface ReadinessProbe {
  readonly kind: ProbeKind;
  readonly target: string;
  readonly match?: ProbeMatch;
  readonly poll?: ProbePoll;
  readonly onTimeout?: OnTimeout;
  /** The declared {@link EnvKey} whose value supplies a credential at execution time (e.g.
   * `GITHUB_TOKEN` for a private `http` probe's `Authorization` header). Supported for the `http`
   * kind ONLY — `parseProbe` rejects it on any other kind, which consumes credentials from the
   * ambient env. Read via `readEnv`, never inlined. */
  readonly credentialEnv?: string;
}

/** The result of a single probe attempt. `detail` is a short, already-redacted human note.
 * `bind` is the OPTIONAL late-bound value a matcher discovered (the reusable "emit" primitive,
 * #274 Gap B): a kind-agnostic `key → value` map the worker forwards into the `readiness-ready`
 * message so the gate can surface it as an output process variable (e.g. the `capability` kind
 * binds `{ resolvedArtifact: "@nanobpm/urban@0.54.0" }`). Provenance is public, so nothing in
 * `bind` is redacted; keep values free of any secret material by construction. */
export interface ProbeResult {
  readonly ready: boolean;
  readonly detail: string;
  readonly bind?: Record<string, string>;
}

/** A single published GitHub Release, reduced to the two fields the capability resolver reads: the
 * `<package>@<version>` tag and the release body carrying the `## Provenance` `#NNN` refs. Kept
 * separate from I/O so {@link matchCapability} is pure/unit-testable. */
export interface GithubRelease {
  readonly tag: string;
  readonly body: string;
}

/** A raw HTTP response the http matcher inspects (kept separate from I/O so it is pure-testable). */
export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

/** A raw command result the command/npm matchers inspect. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The injectable I/O seam — the ONE place the probe touches the outside world. The default
 * implementation ({@link defaultProbeExec}) uses `fetch` + `node:child_process`; tests pass a stub
 * so every matcher and the poll loop are exercised without a network or a subprocess. */
export interface ProbeExec {
  httpGet(url: string, headers: Record<string, string>): Promise<HttpResponse>;
  run(command: string, env: Record<string, string | undefined>): Promise<CommandResult>;
}

// ── Poll-policy defaults ──────────────────────────────────────────────────────────────────────
/** Default interval between poll attempts (ms) when the descriptor omits `poll.everyMs`. */
export const DEFAULT_EVERY_MS = 15_000;
/** Default bounded budget (ms) when the descriptor omits `poll.timeoutMs` (30 minutes). */
export const DEFAULT_TIMEOUT_MS = 1_800_000;
/** Default backoff shape when the descriptor omits `poll.backoff`. */
export const DEFAULT_BACKOFF: Backoff = "exponential";
/** Ceiling on a single backoff delay (ms) — an exponential ramp can never park a probe for days. */
export const MAX_EVERY_MS = 5 * 60_000;
/** Per-attempt I/O deadline (ms) for the default {@link ProbeExec} (60s). Both `fetch` and the
 * command subprocess are bounded by it, so a single stuck attempt always resolves in bounded time
 * (as an error the poll loop treats as "not ready yet") instead of hanging the worker forever —
 * neither the local poll budget nor the engine timer can bound a JS handler blocked inside I/O. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
/** Default gate timeout when neither the descriptor nor `NANO_READINESS_POLL_TIMEOUT` supplies one. */
export const DEFAULT_READINESS_TIMEOUT = "PT30M";

/** The ONE canonical readiness-signal message the wait-gate correlates on to release the wait
 * (ADR 0001 §2) — the correlation key is per-caller (`=gateKey` for the in-flow probe worker,
 * `=prKey` for the review-ready wait), not a single fixed key. Both the in-flow probe worker
 * (`pr.readiness-probe`) and the out-of-band
 * poller-correlated shape used by the review-ready migration (#259, per #258 pinned decision 3)
 * publish under this ONE name — so there is a single "wait for the world" message, no bespoke twin. */
export const READINESS_READY_MESSAGE = "readiness-ready";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse + validate a raw descriptor (a process variable) into a typed {@link ReadinessProbe}.
 * Throws a descriptive error on an unknown/missing `kind`, a blank `target`, an invalid
 * `onTimeout`/`backoff`, or a `credentialEnv` on a non-`http` kind — a malformed probe must fail
 * loudly at the worker, never silently wait forever (nor let a caller believe a subprocess probe is
 * authenticated when its credential is silently ignored). */
export function parseProbe(raw: unknown): ReadinessProbe {
  if (!isRecord(raw)) throw new Error("readiness probe: descriptor must be an object");
  const kind = str(raw.kind).trim();
  if (!isProbeKind(kind)) {
    throw new Error(`readiness probe: unknown kind '${kind}' (expected one of ${PROBE_KINDS.join(", ")})`);
  }
  const target = str(raw.target).trim();
  if (target === "") throw new Error(`readiness probe (${kind}): 'target' is required`);

  const onTimeoutRaw = str(raw.onTimeout).trim();
  if (onTimeoutRaw !== "" && !isOnTimeout(onTimeoutRaw)) {
    throw new Error(`readiness probe: invalid onTimeout '${onTimeoutRaw}' (expected ${ON_TIMEOUTS.join(", ")})`);
  }
  const onTimeout: OnTimeout = onTimeoutRaw === "" ? "escalate" : onTimeoutRaw;

  const match = isRecord(raw.match) ? parseMatch(raw.match) : undefined;
  // A capability edge whose ref or package is blank can never resolve — fail loudly here rather than
  // wait forever (mirroring the blank-`target` guard above). Both are required for this kind.
  if (kind === "capability") {
    if (!match?.capabilityRef) {
      throw new Error("readiness probe (capability): 'match.capabilityRef' is required (e.g. 'nano-ide#274' or '#274')");
    }
    // A ref that carries no numeric issue/PR id (e.g. 'cap274' has a number, but 'nano-ide#' or a
    // bare word does not) can never resolve — `matchCapability` would only surface it as a timeout
    // much later. Reject it now, via the SAME canonical parser the resolver uses, so a malformed
    // edge fails loudly at parse (mirroring the intent of the blank-ref guard above).
    if (!capabilityNumber(match.capabilityRef)) {
      throw new Error(
        `readiness probe (capability): 'match.capabilityRef' ('${match.capabilityRef}') must carry a ` +
          "numeric issue/PR id (e.g. 'nano-ide#274' or '#274')",
      );
    }
    if (!match?.package) {
      throw new Error("readiness probe (capability): 'match.package' is required (provenance is per-package scoped)");
    }
  }
  const poll = isRecord(raw.poll) ? parsePoll(raw.poll) : undefined;
  const credentialEnv = str(raw.credentialEnv).trim() || undefined;
  if (credentialEnv !== undefined && !isEnvKey(credentialEnv)) {
    throw new Error(
      `readiness probe: credentialEnv '${credentialEnv}' is not a declared env-contract key ` +
        "(register it in app/contracts.ts) — a probe must never inline a secret",
    );
  }
  // A credential is only ever consumed by the `http` kind (as an Authorization header). For
  // command/npm/github-check it would be silently ignored, so reject it here rather than let a
  // caller believe the subprocess runs authenticated (github-check's `gh api` reads its own token
  // from the ambient env, not from `credentialEnv`).
  if (credentialEnv !== undefined && kind !== "http") {
    throw new Error(
      `readiness probe (${kind}): 'credentialEnv' is only supported for the 'http' kind ` +
        "(applied as an Authorization header); it has no effect on a command/npm/github-check probe",
    );
  }

  return { kind, target, match, poll, onTimeout, credentialEnv };
}

// Membership guards that narrow a validated string to its union without a type assertion (the
// `no-unsafe-type-assertion` gate bans `as`).
function isProbeKind(v: string): v is ProbeKind {
  for (const k of PROBE_KINDS) if (k === v) return true;
  return false;
}
function isOnTimeout(v: string): v is OnTimeout {
  for (const t of ON_TIMEOUTS) if (t === v) return true;
  return false;
}

// `isBackoff` narrows a validated string to its union without a type assertion (the
// `no-unsafe-type-assertion` gate bans `as`).
function isBackoff(v: string): v is Backoff {
  for (const b of BACKOFFS) if (b === v) return true;
  return false;
}

function parseMatch(raw: Record<string, unknown>): ProbeMatch {
  return {
    status: num(raw.status),
    bodyIncludes: str(raw.bodyIncludes).trim() || undefined,
    exitCode: num(raw.exitCode),
    stdoutIncludes: str(raw.stdoutIncludes).trim() || undefined,
    version: str(raw.version).trim() || undefined,
    conclusion: str(raw.conclusion).trim() || undefined,
    checkName: str(raw.checkName).trim() || undefined,
    capabilityRef: str(raw.capabilityRef).trim() || undefined,
    package: str(raw.package).trim() || undefined,
    verifyCommand: str(raw.verifyCommand).trim() || undefined,
  };
}

function parsePoll(raw: Record<string, unknown>): ProbePoll {
  const backoffRaw = str(raw.backoff).trim();
  if (backoffRaw !== "" && !isBackoff(backoffRaw)) {
    throw new Error(`readiness probe: invalid backoff '${backoffRaw}' (expected ${BACKOFFS.join(", ")})`);
  }
  return {
    everyMs: num(raw.everyMs),
    timeoutMs: num(raw.timeoutMs),
    backoff: backoffRaw === "" ? undefined : backoffRaw,
  };
}

/** The effective poll policy: descriptor values, clamped to sane bounds, with defaults filled in.
 * `everyMs`/`timeoutMs` below 1ms fall back to their defaults (a zero interval would busy-spin). */
export function normalizePoll(poll: ProbePoll | undefined): Required<ProbePoll> {
  const everyRaw = poll?.everyMs;
  const timeoutRaw = poll?.timeoutMs;
  const everyMs = typeof everyRaw === "number" && everyRaw >= 1 ? Math.trunc(everyRaw) : DEFAULT_EVERY_MS;
  const timeoutMs =
    typeof timeoutRaw === "number" && timeoutRaw >= 1 ? Math.trunc(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  return { everyMs: Math.min(everyMs, MAX_EVERY_MS), timeoutMs, backoff: poll?.backoff ?? DEFAULT_BACKOFF };
}

/** The delay (ms) before the `attempt`-th retry (1-based). Fixed backoff returns `everyMs`;
 * exponential doubles per attempt, clamped to {@link MAX_EVERY_MS}. */
export function nextDelay(attempt: number, poll: Required<ProbePoll>): number {
  if (poll.backoff === "fixed") return poll.everyMs;
  const factor = 2 ** Math.max(0, attempt - 1);
  return Math.min(poll.everyMs * factor, MAX_EVERY_MS);
}

// ── Per-kind matchers (pure — operate on an already-fetched raw response) ───────────────────────

/** http readiness: status matches (`match.status`, else any 2xx) AND, if given, the body contains
 * `match.bodyIncludes`. */
export function matchHttp(match: ProbeMatch | undefined, resp: HttpResponse): ProbeResult {
  const statusOk =
    typeof match?.status === "number" ? resp.status === match.status : resp.status >= 200 && resp.status < 300;
  const bodyOk = match?.bodyIncludes ? resp.body.includes(match.bodyIncludes) : true;
  const ready = statusOk && bodyOk;
  return { ready, detail: `http ${resp.status}${ready ? "" : " (not ready)"}` };
}

/** command readiness: exit code matches (`match.exitCode`, else 0) AND, if given, stdout contains
 * `match.stdoutIncludes`. */
export function matchCommand(match: ProbeMatch | undefined, resp: CommandResult): ProbeResult {
  const wantCode = typeof match?.exitCode === "number" ? match.exitCode : 0;
  const codeOk = resp.code === wantCode;
  const stdoutOk = match?.stdoutIncludes ? resp.stdout.includes(match.stdoutIncludes) : true;
  const ready = codeOk && stdoutOk;
  return { ready, detail: `command exit ${resp.code}${ready ? "" : " (not ready)"}` };
}

/** npm readiness: `npm view <pkg>@<version> version` printed a version (the package@version is
 * published). If `match.version` (or the version in `pkg@version`) is given, the printed version
 * must equal it; otherwise any non-empty version means ready. */
export function matchNpm(match: ProbeMatch | undefined, target: string, resp: CommandResult): ProbeResult {
  if (resp.code !== 0) return { ready: false, detail: "npm view failed (not published yet)" };
  const printed = resp.stdout.trim();
  if (printed === "") return { ready: false, detail: "npm: version not published yet" };
  const want = match?.version ?? versionOf(target);
  const ready = want ? printed.split(/\s+/).includes(want) || printed === want : true;
  return { ready, detail: `npm ${ready ? "published" : "version mismatch"}` };
}

/** github-check readiness: parse a `check-runs` payload and require the relevant runs to have the
 * wanted conclusion (`match.conclusion`, else "success"). With `match.checkName` only that check
 * is considered; otherwise every check run must be complete + successful and at least one exists. */
export function matchGithubCheck(match: ProbeMatch | undefined, payload: unknown): ProbeResult {
  const runs = checkRunsOf(payload);
  const want = match?.conclusion ?? "success";
  const named = match?.checkName;
  const relevant = named ? runs.filter((r) => r.name === named) : runs;
  if (relevant.length === 0) {
    return { ready: false, detail: named ? `github-check: '${named}' not found yet` : "github-check: no runs yet" };
  }
  const ready = relevant.every((r) => r.status === "completed" && r.conclusion === want);
  return { ready, detail: `github-check ${ready ? want : "pending/failed"}` };
}

interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
}

function checkRunsOf(payload: unknown): CheckRun[] {
  const rawRuns = isRecord(payload) && Array.isArray(payload.check_runs) ? payload.check_runs : [];
  const out: CheckRun[] = [];
  for (const r of rawRuns) {
    if (!isRecord(r)) continue;
    out.push({ name: str(r.name), status: str(r.status), conclusion: str(r.conclusion) });
  }
  return out;
}

/** The version segment of a `pkg@version` (or `@scope/pkg@version`) target, or undefined. */
function versionOf(target: string): string | undefined {
  const at = target.lastIndexOf("@");
  if (at <= 0) return undefined;
  const v = target.slice(at + 1).trim();
  return v === "" ? undefined : v;
}

// ── Capability resolver (#274 Gap A — a stable, pure "which version first carries C?" matcher) ───

/** Compare two dotted numeric version strings (`major.minor.patch…`), reusing the exact semantics of
 * nano-ide `scripts/publish.mjs` `cmpVersion` so the resolver and the publisher agree on ordering.
 * Missing trailing segments count as 0; returns <0, 0, or >0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The bare, purely numeric `#NNN` number from a capability handle — `nano-ide#274`, `#274`, or a
 * naked `274` all normalise to `274`. Returns undefined for anything without a number, so a blank/
 * malformed ref never accidentally matches. */
function capabilityNumber(ref: string): string | undefined {
  const m = ref.match(/(\d+)\s*$/);
  return m ? m[1] : undefined;
}

/** Does a release body's `## Provenance` reference `#NNN`? Matched on a `#`-prefixed word boundary so
 * `#27` never spuriously satisfies `#274`. */
function bodyReferences(body: string, num: string): boolean {
  return new RegExp(`#${num}(?!\\d)`).test(body);
}

/** The `<version>` of a release tagged exactly `<package>@<version>` (numeric-dotted), or undefined
 * when the tag belongs to another package or is not a version tag. Per-package scoping is enforced
 * here: a sibling package's provenance can never leak into this package's resolution. */
function versionForPackage(tag: string, pkg: string): string | undefined {
  const prefix = `${pkg}@`;
  if (!tag.startsWith(prefix)) return undefined;
  const v = tag.slice(prefix.length).trim();
  return /^\d+(\.\d+)*$/.test(v) ? v : undefined;
}

/** capability readiness (#274 Gap A): among GitHub Releases tagged `<match.package>@*` whose body
 * references `match.capabilityRef`, resolve the **lowest** SemVer version — that is the version that
 * *first* carries the capability (`firstVersion`). Late-binds it as `{ resolvedArtifact }` so the
 * gate can hand the exact `pkg@version` to the consumer (#274 Gap B). PURE: it operates on an
 * already-fetched, parsed releases list and NEVER throws — a malformed/empty list is simply
 * "not ready yet" (keep waiting), so a transient provenance read cannot crash the poll loop. */
export function matchCapability(match: ProbeMatch | undefined, releases: readonly GithubRelease[]): ProbeResult {
  const pkg = match?.package;
  const ref = match?.capabilityRef;
  if (!pkg || !ref) return { ready: false, detail: "capability: missing package/capabilityRef" };
  const num = capabilityNumber(ref);
  if (!num) return { ready: false, detail: "capability: unparseable capabilityRef (no #NNN)" };

  let firstVersion: string | undefined;
  for (const rel of releases) {
    if (!rel || typeof rel.tag !== "string" || typeof rel.body !== "string") continue;
    const version = versionForPackage(rel.tag, pkg);
    if (!version) continue;
    if (!bodyReferences(rel.body, num)) continue;
    if (firstVersion === undefined || cmpVersion(version, firstVersion) < 0) firstVersion = version;
  }
  if (firstVersion === undefined) return { ready: false, detail: `capability #${num} not published in ${pkg} yet` };
  const resolvedArtifact = `${pkg}@${firstVersion}`;
  return { ready: true, detail: `capability #${num} carried by ${resolvedArtifact}`, bind: { resolvedArtifact } };
}

/** The **newest** published SemVer version of `pkg` across `releases` — the target of the gated
 * empirical fallback (decision 5), which installs the latest release and verifies the capability
 * behaviourally when deterministic provenance resolved nothing. PURE / never throws. */
export function newestPublishedVersion(pkg: string | undefined, releases: readonly GithubRelease[]): string | undefined {
  if (!pkg) return undefined;
  let newest: string | undefined;
  for (const rel of releases) {
    if (!rel || typeof rel.tag !== "string") continue;
    const version = versionForPackage(rel.tag, pkg);
    if (!version) continue;
    if (newest === undefined || cmpVersion(version, newest) > 0) newest = version;
  }
  return newest;
}

/** Parse a raw `gh api .../releases` payload (already JSON-decoded) into the minimal
 * {@link GithubRelease} list the resolver reads. Tolerant: non-array/malformed input yields `[]`,
 * so a bad provenance read degrades to "not ready", never a throw. Also accepts the `--paginate
 * --slurp` shape — an array whose elements are themselves per-page arrays — flattening one level so
 * releases beyond the first 100 (the true lowest version that first carried a capability) are seen. */
export function parseReleases(payload: unknown): GithubRelease[] {
  if (!Array.isArray(payload)) return [];
  const out: GithubRelease[] = [];
  const push = (r: unknown): void => {
    if (!isRecord(r)) return;
    out.push({ tag: str(r.tag_name), body: str(r.body) });
  };
  for (const el of payload) {
    if (Array.isArray(el)) {
      for (const r of el) push(r);
    } else {
      push(el);
    }
  }
  return out;
}

/** Split a `capability` target (`github-releases:owner/repo`) into the provenance source repo. The
 * `github-releases:` scheme prefix is optional — a bare `owner/repo` is accepted too. */
export function parseReleasesTarget(target: string): string {
  const t = target.trim();
  const scheme = "github-releases:";
  return t.startsWith(scheme) ? t.slice(scheme.length).trim() : t;
}

/** Build the `gh api` command that lists a repo's releases (the provenance substrate). `gh` reads
 * its token from the ambient env, exactly like the `github-check` kind — no `credentialEnv`.
 * `--paginate --slurp` walks the FULL release history (not just the first `per_page=100` page), so a
 * repo with >100 releases can still surface the lowest version that first carried a capability;
 * `--slurp` wraps the pages in an outer array that {@link parseReleases} flattens. */
export function githubReleasesCommand(repo: string): string {
  return `gh api --paginate --slurp ${shellQuote(`repos/${repo}/releases?per_page=100`)} -H ${shellQuote("Accept: application/vnd.github+json")}`;
}


// ── Single probe attempt (does I/O via the injected {@link ProbeExec}) ──────────────────────────

/** Run ONE probe attempt for `probe`, resolving any credential from the typed env-contract and
 * dispatching to the kind's matcher. Read-only and idempotent, so a re-run (worker restart) is
 * safe. A thrown I/O error is caught by the caller (the poll loop) and treated as "not ready yet".
 */
export async function probeOnce(
  probe: ReadinessProbe,
  exec: ProbeExec,
  env: Record<string, string | undefined> = process.env,
): Promise<ProbeResult> {
  const credential = credentialFor(probe, env);
  switch (probe.kind) {
    case "http": {
      const headers: Record<string, string> = { accept: "*/*" };
      if (credential) headers.authorization = `Bearer ${credential}`;
      return matchHttp(probe.match, await exec.httpGet(probe.target, headers));
    }
    case "command":
      return matchCommand(probe.match, await exec.run(probe.target, env));
    case "npm":
      return matchNpm(probe.match, probe.target, await exec.run(npmCommand(probe.target), env));
    case "github-check": {
      const { repo, ref } = parseRepoRef(probe.target);
      const out = await exec.run(githubCheckCommand(repo, ref), env);
      if (out.code !== 0) return { ready: false, detail: "github-check: gh api failed (not ready)" };
      return matchGithubCheck(probe.match, parseJson(out.stdout));
    }
    case "capability": {
      const repo = parseReleasesTarget(probe.target);
      const out = await exec.run(githubReleasesCommand(repo), env);
      if (out.code !== 0) return { ready: false, detail: "capability: gh api failed (not ready)" };
      return matchCapability(probe.match, parseReleases(parseJson(out.stdout)));
    }
  }
}

/** Build the gated empirical fallback for a `capability` probe (decision 5) — a thunk the poll loop
 * runs ONCE at the gate boundary (local budget exhausted) when deterministic provenance resolved
 * nothing. It installs nothing itself: it fetches releases, picks the NEWEST published version, and
 * runs the descriptor's `match.verifyCommand` against it (with `RESOLVED_ARTIFACT`/`RESOLVED_VERSION`
 * in the env) — exit 0 binds that newest version, letting a capability that provenance under-reported
 * still resolve empirically. Returns `null` (no fallback) for a non-capability probe, a capability
 * probe with no `verifyCommand` (deterministic-only), or when no version/releases are available — so
 * the default path stays a pure deterministic lookup and the agent judgment is the gated exception. */
export function makeCapabilityFallback(
  probe: ReadinessProbe,
  exec: ProbeExec,
  env: Record<string, string | undefined>,
): () => Promise<ProbeResult | null> {
  return async () => {
    if (probe.kind !== "capability") return null;
    const verify = probe.match?.verifyCommand;
    const pkg = probe.match?.package;
    if (!verify || !pkg) return null;
    const listed = await exec.run(githubReleasesCommand(parseReleasesTarget(probe.target)), env);
    if (listed.code !== 0) return null;
    const newest = newestPublishedVersion(pkg, parseReleases(parseJson(listed.stdout)));
    if (!newest) return null;
    const artifact = `${pkg}@${newest}`;
    const res = await exec.run(verify, { ...env, RESOLVED_ARTIFACT: artifact, RESOLVED_VERSION: newest });
    if (res.code === 0) {
      return { ready: true, detail: `capability verified empirically at ${artifact}`, bind: { resolvedArtifact: artifact } };
    }
    return { ready: false, detail: "capability: empirical verification failed at gate boundary" };
  };
}

/** Resolve the credential a probe declares, from the typed env-contract only. Returns undefined
 * when no `credentialEnv` is declared or the key is unset — never a value from the descriptor. */
function credentialFor(probe: ReadinessProbe, env: Record<string, string | undefined>): string | undefined {
  if (probe.credentialEnv === undefined || !isEnvKey(probe.credentialEnv)) return undefined;
  return readEnv(probe.credentialEnv, env);
}

/** Build the `npm view` command for a `pkg@version` target. The target is single-quote-escaped so
 * a hostile descriptor cannot break out of the argument. */
export function npmCommand(target: string): string {
  return `npm view ${shellQuote(target)} version`;
}

/** Build the `gh api` command that lists the check runs for a ref. */
export function githubCheckCommand(repo: string, ref: string): string {
  return `gh api ${shellQuote(`repos/${repo}/commits/${ref}/check-runs`)} -H ${shellQuote("Accept: application/vnd.github+json")}`;
}

/** Split an `owner/repo@ref` github-check target into its parts. Defaults the ref to `HEAD`. */
export function parseRepoRef(target: string): { repo: string; ref: string } {
  const at = target.lastIndexOf("@");
  if (at <= 0) return { repo: target, ref: "HEAD" };
  return { repo: target.slice(0, at), ref: target.slice(at + 1).trim() || "HEAD" };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Timeout duration derivation (probe poll budget → the gate's FEEL timer) ─────────────────────

/** Convert a millisecond budget into an ISO-8601 duration for a BPMN `<bpmn:timeDuration>`.
 * Rounds up to whole seconds (a sub-second budget still yields at least `PT1S`), so the engine
 * timer never rounds down to a zero-length (immediately-firing) duration. */
export function msToIsoDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `PT${seconds}S`;
}

/** The authoritative gate timeout (an ISO-8601 duration) for a probe: the descriptor's
 * `poll.timeoutMs` when present, else `NANO_READINESS_POLL_TIMEOUT`, else the built-in default.
 * This is the value the gate's timer arm is seeded with — the engine, not the worker, owns the
 * bound. Kept here so whoever seeds a readiness-gate instance derives it from ONE place. */
export function readinessTimeout(
  probe: ReadinessProbe,
  env: Record<string, string | undefined> = process.env,
): string {
  const declared = probe.poll?.timeoutMs;
  if (typeof declared === "number" && declared >= 1) return msToIsoDuration(Math.trunc(declared));
  return isoDuration(readEnvOr("NANO_READINESS_POLL_TIMEOUT", DEFAULT_READINESS_TIMEOUT, env), DEFAULT_READINESS_TIMEOUT);
}

/** The effective gate budget in **milliseconds** — the ms twin of {@link readinessTimeout}, resolved
 * by the SAME precedence (descriptor `poll.timeoutMs`, else `NANO_READINESS_POLL_TIMEOUT`, else the
 * built-in default) and sharing its env key + default. The worker's local poll budget MUST use this
 * rather than a hard-coded default: an operator who raises `NANO_READINESS_POLL_TIMEOUT` past the
 * built-in 30m would otherwise stop the worker probing while the gate's engine timer keeps waiting —
 * a window in which the artifact can go ready with nothing left to observe it, spuriously escalating
 * the gate. The declared branch stays exact ms (the gate rounds it up to whole seconds for its ISO
 * timer); the env branch parses through {@link isoDurationToMs}, the same grammar `readinessTimeout`
 * validates with, so the two bounds can never drift. */
export function readinessTimeoutMs(
  probe: ReadinessProbe,
  env: Record<string, string | undefined> = process.env,
): number {
  const declared = probe.poll?.timeoutMs;
  if (typeof declared === "number" && declared >= 1) return Math.trunc(declared);
  return isoDurationToMs(readEnvOr("NANO_READINESS_POLL_TIMEOUT", DEFAULT_READINESS_TIMEOUT, env), DEFAULT_READINESS_TIMEOUT);
}

/** The worker's local poll budget in **milliseconds**, bound to the gate **per instance**.
 *
 * The gate's engine timers (`resources/processes/readiness-gate.bpmn`) fire off the *process
 * variable* `probeTimeout` (`<bpmn:timeDuration>=probeTimeout</…>`), seeded once when the gate
 * instance is created. The worker must adopt that SAME seeded value rather than recompute the bound
 * from the ambient env ({@link readinessTimeoutMs}): if `NANO_READINESS_POLL_TIMEOUT` changes after
 * the instance is created (or `probeTimeout` was seeded from a different source), an env-recomputed
 * worker can stop probing while the engine timer is still waiting — a window where the artifact can
 * go ready with no worker left to publish `readiness-ready`, spuriously escalating the gate.
 *
 * So prefer the seeded `probeTimeout` (parsed through {@link isoDurationToMs}, the same grammar the
 * engine timer is validated with, so worker-ms and engine-ISO can't drift), and fall back to the
 * env-derived twin only when it is absent/blank — e.g. a direct caller or unit test that drives the
 * loop without seeding the process variable. */
export function probeBudgetMs(
  probeTimeout: string | undefined,
  probe: ReadinessProbe,
  env: Record<string, string | undefined> = process.env,
): number {
  const seeded = (probeTimeout ?? "").trim();
  if (seeded !== "") return isoDurationToMs(seeded, DEFAULT_READINESS_TIMEOUT);
  return readinessTimeoutMs(probe, env);
}

// ── Default I/O implementation (Node) ───────────────────────────────────────────────────────────

/** The production {@link ProbeExec}: `fetch` for http, a shell subprocess for command/npm/gh. Every
 * attempt is bounded by `attemptTimeoutMs` ({@link DEFAULT_ATTEMPT_TIMEOUT_MS}) — `fetch` via an
 * `AbortController` and the subprocess via `exec`'s `timeout`/`killSignal` — so a hung endpoint or a
 * stuck command becomes a bounded error the poll loop retries, never an I/O block the engine timer
 * cannot cancel. */
export function defaultProbeExec(attemptTimeoutMs: number = DEFAULT_ATTEMPT_TIMEOUT_MS): ProbeExec {
  return {
    async httpGet(url, headers) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      try {
        const r = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
        const body = await r.text().catch(() => "");
        return { status: r.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
    async run(command, env) {
      const { exec } = await import("node:child_process");
      return await new Promise<CommandResult>((resolve) => {
        exec(
          command,
          { env, maxBuffer: 16 * 1024 * 1024, timeout: attemptTimeoutMs, killSignal: "SIGKILL" },
          (err, stdout, stderr) => {
            const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
          },
        );
      });
    },
  };
}

// ── Log redaction (ADR 0004 pinned decision 2 — never leak a probe's target/output/credential) ──

/** A log-safe rendering of a probe: kind + a redacted target (URL userinfo and query string
 * stripped, since either can carry a token) — never the credential, body, or stdout. A `command`
 * target is an arbitrary shell snippet that can easily embed a secret, so it is never logged at all:
 * only the kind + a fixed placeholder is rendered for it. */
export function redactTarget(probe: ReadinessProbe): string {
  if (probe.kind === "command") return `${probe.kind}:<redacted>`;
  return `${probe.kind}:${redactString(probe.target)}`;
}

/** Strip credential-bearing pieces from a free-form target string for logging: any `user:pass@`
 * userinfo and any `?query`/`#fragment` (a token often rides the query). */
export function redactString(s: string): string {
  return s
    .replace(/\/\/[^/@\s]*@/g, "//***@")
    .replace(/[?#].*$/, (m) => `${m[0]}***`);
}
