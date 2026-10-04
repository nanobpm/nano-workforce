// nano-workforce — the pure, side-effect-free SEMANTIC validator for an agent-authored delivery
// graph (ADR 0005, slice S0). The `DeliveryGraph` SHAPE is validated at the edge by the openapi
// schema (`openapi.yaml` → generated `DeliveryGraph` contract); this module validates the semantics
// the JSON Schema CANNOT express and that a compiler/runner must be able to trust before it does
// anything:
//
//   • unknown `kind` — a node whose `kind` is not in the CLOSED allowlist (the trust boundary,
//     Decision 1/2). Defensive because the body arrives untyped from a request.
//   • duplicate node id — two nodes sharing an id, which would make every edge to it ambiguous.
//   • dangling edge — an edge endpoint (`from`/`to`) that names no node in the graph.
//   • bad `from` reference — a qualified `<nodeId>.<fact>` whose fact is not declared in that node's
//     typed `emits[]` (Decision 3/4 — binds are validated, not stringly).
//   • cycle — the edge set must be a DAG (discovered-fact dependencies flow forward only).
//
// It is modelled on the epic-set validator `validateEpicSet` (app/plan.ts): a PURE in-memory walk
// that runs BEFORE any side effect. Unlike `validateEpicSet` (which throws at the first offending
// edge), this COLLECTS every error and returns them, so a co-designing agent gets ONE actionable,
// path-qualified list per compile attempt (the S1 compiler surfaces them as `{ ok:false, errors }`).
// Every error carries a JSON-path-qualified `path` (`nodes[2].kind`, `edges[1].from`, …) so the
// caller can point the author straight at the offending input.

import { isPlausibleBranchName } from "./baseBranch.ts";
import { isEnvKey } from "./contracts.ts";
import { isConvergeTarget } from "./convergeTargets.ts";
import { isRawConvergeMergeJobType, NODE_COMPLETION_POLICIES } from "./nodePolicy.ts";
import { BACKOFFS, hasEmbeddedCredential, hasEmbeddedUrl, hasSchemeRelativeAuthority, isBackoff, isUrlShaped, redactEmbeddedCredentialUrl, redactEmbeddedSchemeRelativeUrl, redactEmbeddedUrl, redactString } from "./readiness.ts";
import { isResolvableRepo } from "./repoEnvelope.ts";

/** The CLOSED node-kind allowlist (ADR 0005 Decision 2) — the trust boundary. Extensible only by a
 * deliberate ADR/PR (add the openapi variant + a case here), never by a graph author. Kept as the
 * single source of truth for "which kinds are legal" so the validator and any future compiler agree. */
export const DELIVERY_NODE_KINDS = ["agent", "wait", "human", "connector"] as const;

/** A node's `kind`, narrowed to the closed allowlist. */
export type DeliveryNodeKind = (typeof DELIVERY_NODE_KINDS)[number];

/** The CLOSED emitted-fact type allowlist (ADR 0005 Decision 3/4) — mirrors the `DeliveryFact.type`
 * enum in `openapi.yaml`. Kept as the single source of truth so the semantic validator rejects an
 * untyped/unknown fact type even when the OpenAPI shape validator is bypassed (a directly-invoked
 * delegate), since later compilation/execution steps rely on this allowlist. `pr` (issue #548) is the
 * PR-reference type an `agent` node emits for the PR it opened (`owner/repo#N`), so a downstream
 * `connector[converge*]` / `wait[pr]` node LATE-BINDS its target PR from that fact instead of a
 * hardcoded literal (the canonical `agent → connector[converge-merge] → wait[pr, merged]` shape). */
export const DELIVERY_FACT_TYPES = ["string", "number", "boolean", "artifact", "version", "url", "pr"] as const;

/** An emitted fact's declared `type`, narrowed to the closed allowlist. */
export type DeliveryFactType = (typeof DELIVERY_FACT_TYPES)[number];

/** The SCALAR emitted-fact types a guarded edge's `when` may reference (ADR 0005 S7). A guard is an
 * equality test `fact == literal`, so only a scalar (single-valued, comparable) fact can be guarded —
 * `artifact`/`version`/`url` are compound/opaque handles and are rejected as guard subjects. Kept as
 * the single source of truth so the validator and the compiler agree on what is guardable. */
export const DELIVERY_GUARD_SCALAR_TYPES = ["string", "number", "boolean"] as const;

/** A guardable scalar fact type, narrowed from the closed emitted-fact allowlist. */
export type DeliveryGuardScalarType = (typeof DELIVERY_GUARD_SCALAR_TYPES)[number];

/** True when `type` is a guardable SCALAR (`string`/`number`/`boolean`) — the closed set a `when`
 * guard may reference. */
export function isDeliveryGuardScalarType(type: unknown): type is DeliveryGuardScalarType {
  if (typeof type !== "string") return false;
  for (const t of DELIVERY_GUARD_SCALAR_TYPES) if (t === type) return true;
  return false;
}

/** A machine-readable classification of a semantic failure, so a caller can branch on the error
 * class (unknown-kind / dangling / cycle / bad-`from`) without string-matching the message. */
export type DeliveryGraphErrorCode =
  | "empty-graph"
  | "invalid-graph-name"
  | "too-many-nodes"
  | "too-many-edges"
  | "too-many-emits"
  | "missing-id"
  | "invalid-id"
  | "duplicate-id"
  | "unknown-kind"
  | "missing-config"
  | "missing-required-field"
  | "duplicate-fact"
  | "invalid-fact-name"
  | "invalid-fact-type"
  | "invalid-edges"
  | "dangling-edge"
  | "bad-from"
  | "self-edge"
  | "cycle"
  | "guard-missing-equals"
  | "guard-missing-when"
  | "guard-default-conflict"
  | "bad-when"
  | "guard-type-mismatch"
  | "guard-invalid-equals"
  | "mixed-fan-out"
  | "multiple-defaults"
  | "non-exhaustive-split"
  | "exclusive-merge-parity"
  | "unsupported-on-timeout"
  | "raw-converge-node"
  | "merge-requires-converge"
  | "converge-merge-type"
  | "invalid-node-repository"
  | "invalid-node-base-branch"
  | "invalid-job-type"
  | "url-shaped-job-type"
  | "credential-in-job-type"
  | "embedded-url-in-job-type"
  | "scheme-relative-url-in-job-type"
  | "invalid-credential-env"
  | "invalid-backoff"
  | "unbound-pr"
  | "partial-scope-close";

/** A single semantic validation failure. `path` is a JSON-path-qualified pointer at the offending
 * input (`nodes[2].kind`, `edges[1].from`, `nodes[0].emits[1].name`), `message` is human-actionable,
 * and `code` is the stable error class. Shaped so the S1 compiler can forward it verbatim as one of
 * its `{ ok:false, errors:[{ path, message }] }` entries. */
export interface DeliveryGraphError {
  readonly path: string;
  readonly message: string;
  readonly code: DeliveryGraphErrorCode;
}

/** Narrow an untyped value to a plain object so its fields can be read as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip the characters XML 1.0's `Char` production forbids anywhere in a document: the C0 control
 * characters (except tab `#x9`, LF `#xA`, CR `#xD`), the noncharacters U+FFFE/U+FFFF, and unpaired
 * UTF-16 surrogates — none can be represented by an entity, so any of them in an element
 * `name`/`documentation` makes `layoutBpmn`/deployment reject the whole semantic BPMN. VALID astral
 * pairs are preserved; dropping an unrepresentable character is the only well-formed rendering.
 * Canonical here (the low-level graph module) so both the validator (which must REJECT such a
 * character in executable FEEL — see {@link hasXmlInvalidChars}) and the compiler (which strips it
 * from DISPLAY text) share ONE character-class definition — no drift surface. Deterministic and
 * total. */
export function stripXmlInvalidChars(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — this IS the XML-1.0 control filter.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      // Unpaired surrogates (a high not followed by a low, or a low not preceded by a high); valid pairs stay.
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      // XML-1.0 noncharacters just past the BMP `Char` range end (#xFFFD).
      .replace(/[\uFFFE\uFFFF]/g, "")
  );
}

/** True when `value` contains any XML-1.0-forbidden character (see {@link stripXmlInvalidChars}).
 * Defined in terms of the strip so detection and stripping can never disagree — a single source of
 * truth for the character class. Used to REJECT such a character in an executable FEEL guard literal
 * at validation time (rather than let the compiler's display-text sanitiser silently rewrite the
 * guard and route the process down the wrong edge). Deterministic and total. */
export function hasXmlInvalidChars(value: string): boolean {
  return stripXmlInvalidChars(value) !== value;
}

/** Credential redaction for a free-form connector value (`target`, `dedupeKey`, a bound
 * `payload.pr`) or an `agent.jobType` descriptor. Such a value is frequently an OPAQUE identifier —
 * `slack:#releases`, `owner/repo#42`, a `<node>.pr` ref, `pkg@version` — in which `#`/`?`/`@` are
 * MEANINGFUL, so blind {@link redactString} would mangle it (e.g. `slack:#releases` → `slack:#***`,
 * `owner/repo#42` → `owner/repo#***`). Only a value that is actually a URL — a `scheme://authority` OR a
 * scheme-relative `//authority` form ({@link isUrlShaped}), either of which can hide a credential in
 * userinfo/query/fragment (`redactString` redacts both) — is redacted in FULL (userinfo AND
 * `?query`/`#fragment`). But an embedded `//<userinfo>@` credential can also ride AFTER a non-URL
 * prefix in a free-form value that keeps a meaningful `#<digits>` PR-number handle (any prefix before
 * `#<digits>`, so `prefix //user:pass@host#42`), which the anchored {@link isUrlShaped} check misses.
 * Because a `//<userinfo>@` span is UNAMBIGUOUSLY a credential wherever it sits (an opaque id never
 * contains one), a scheme-relative `//<userinfo>@authority…` run is treated as an embedded URL and
 * redacted in FULL — userinfo AND its `?query`/`#fragment` — via {@link redactEmbeddedCredentialUrl},
 * since userinfo marks the run a URL whose `?`/`#` ARE URL syntax rather than a meaningful opaque token
 * character; an opaque `//host#42` (no userinfo) keeps its `#42` (issue #778 review — threads
 * deliveryGraph.ts:162/566, :188). An embedded ABSOLUTE URL
 * (an explicit `scheme://…` token) after a non-URL prefix (`prefix https://host/path?token=secret`)
 * likewise hides a `?query`/`#fragment` token the anchored whole-value {@link isUrlShaped} check
 * misses; its `?`/`#` ARE URL syntax (explicit scheme), so redact that token in full via
 * {@link redactEmbeddedUrl}, while a scheme-relative `//host#42` keeps its meaningful opaque `#42`
 * (issue #778 review — thread deliveryGraph.ts:181). Canonical HERE (the low-level
 * graph module, alongside {@link stripXmlInvalidChars} and the URL classifier it shares) so the
 * compiler's DISPLAY path AND `validateDeliveryGraph`'s reject/error path use ONE redactor — no drift
 * surface (issue #778 review — thread deliveryGraphCompiler.ts:1606). Deterministic and total. */
export function redactConnectorValue(value: string): string {
  // Strip XML-invalid display characters BEFORE classifying/redacting: the anchored `^(scheme:)?//`
  // check and the redaction both run on the exact string the renderer will emit. Otherwise a target
  // prefixed by an unrepresentable control char (e.g. `\x01//user:pass@host/?token=…`) fails the
  // anchored check, escapes redaction, then loses that prefix during `escapeXml`/`stripXmlInvalidChars`
  // — surfacing the credential verbatim in the BPMN name/documentation and connector escalation FEEL.
  const cleaned = stripXmlInvalidChars(value);
  // A whole-value URL gets the full redact (userinfo + query/fragment) — EXCEPT a whole-value opaque
  // scheme-relative PR ref (`//host#42`: no explicit scheme, no `//…@` credential, no `?query`), whose
  // only URL-ish payload is a MEANINGFUL `#<digits>` fragment (a PR-number handle). `isUrlShaped`
  // matches such a ref (scheme-relative `//authority`), so the whole-value branch would `redactString`
  // its `#42` → `#***` — yet the EMBEDDED contract deliberately PRESERVES the same `//host#42` (the
  // embedded redactors leave a userinfo-/query-less `//host#42` untouched). Route it through the embedded
  // path so a whole-value `//host#42` keeps its `#42` exactly like `prefix //host#42`, closing that
  // whole-value/embedded inconsistency (issue #778 review — thread deliveryGraph.ts:198). Only a
  // NUMERIC `#<digits>` fragment is a valid PR-number handle — `//host#access-token` is an
  // ordinary URL fragment that can hide a secret, so the exception REQUIRES the `//host#<digits>` shape to match
  // the whole (trimmed) value; a non-numeric fragment falls to the full whole-value redact like any
  // other URL fragment (issue #778 review — thread deliveryGraph.ts:206). An explicit
  // `scheme://host#42`, a `//user:pass@host#…` credential, or a userinfo-less `//host?token=…` query all
  // still fall to the full whole-value redact.
  // Any non-URL value keeps its meaningful `#`/`?` opaque-token characters, but still has (a) each
  // embedded ABSOLUTE-URL (`scheme://…`) token redacted in full — its `?query`/`#fragment` IS URL syntax
  // — and (b) each embedded scheme-relative `//<userinfo>@authority…` credential-URL redacted in full
  // (userinfo AND `?query`/`#fragment`), and (c) each embedded userinfo-LESS scheme-relative URL that
  // carries a `?query` (`//host?token=secret`) redacted (its `?` is unambiguously URL syntax — an opaque
  // PR ref uses a `#<digits>` fragment, never a `//…?…` query), while a userinfo-less opaque `//host#42`
  // (no `?`) keeps its `#42` (issue #778 review — thread deliveryGraph.ts:633).
  const isOpaqueSchemeRelativePrRef =
    cleaned.trim().startsWith("//") &&
    !hasEmbeddedCredential(cleaned) &&
    !cleaned.includes("?") &&
    // A NUMERIC `#<digits>` fragment after a non-empty authority (`//host#42`). Deliberately a local
    // fragment-shape test, not the PR parser: this is a redaction exemption over a free-form value,
    // and `parsePrTarget` now follows the canonical `parsePr` grammar (#856), which has no `//host` form.
    /^\/\/[^#]+#\d+$/.test(cleaned.trim());
  return isUrlShaped(cleaned) && !isOpaqueSchemeRelativePrRef
    ? redactString(cleaned)
    : redactEmbeddedSchemeRelativeUrl(redactEmbeddedCredentialUrl(redactEmbeddedUrl(cleaned)));
}

/** True when `value` contains a whitespace character that XML **attribute-value normalization**
 * rewrites to a space (literal TAB `#x9`, LF `#xA`, or CR `#xD`). Such characters are perfectly
 * valid XML `Char`s — so {@link hasXmlInvalidChars} does NOT flag them — yet when a value is emitted
 * verbatim into a raw XML attribute (`<zeebe:taskDefinition type="…">`), a conforming parser folds
 * each of them to a single space at deploy time. An executable value carrying one (e.g.
 * `senior:\nfeature`) is therefore silently deployed as a DIFFERENT worker type (`senior: feature`),
 * routing the cell to the wrong worker. Rejected — not normalized — for the same reason as
 * {@link hasXmlInvalidChars}: an executable value must never be silently mutated. Deterministic and
 * total. */
export function hasAttrNormalizedWhitespace(value: string): boolean {
  return /[\t\n\r]/.test(value);
}

/** True when `kind` is a member of the closed allowlist. */
function isDeliveryNodeKind(kind: unknown): kind is DeliveryNodeKind {
  if (typeof kind !== "string") return false;
  for (const k of DELIVERY_NODE_KINDS) if (k === kind) return true;
  return false;
}

/** True when `type` is a member of the closed emitted-fact type allowlist. */
function isDeliveryFactType(type: unknown): type is DeliveryFactType {
  if (typeof type !== "string") return false;
  for (const t of DELIVERY_FACT_TYPES) if (t === type) return true;
  return false;
}

/** A fact `name` must be a bare identifier (no dots) — mirrors openapi's `DeliveryFact.name`
 * `^[A-Za-z_][A-Za-z0-9_]*$`. `resolveFrom` RELIES on fact names being dot-free (a node id MAY
 * contain dots) to disambiguate a qualified edge `from`, so the semantic validator re-enforces the
 * pattern INDEPENDENTLY of the OpenAPI shape gate: if that gate is bypassed (a direct delegate call,
 * a test, a future internal use), a dotted fact name could otherwise make `<nodeId>.<fact>` resolution
 * ambiguous and quietly build the wrong DAG — undermining the trust boundary this validator exists to
 * hold. */
export const FACT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const FACT_NAME_MAX_LENGTH = 128;

/** A node `id` must match openapi's `DeliveryNodeCommon.id` `^[A-Za-z_][A-Za-z0-9_.-]*$` and stay
 * within its 128-char cap. Re-enforced here INDEPENDENTLY of the OpenAPI shape gate because later
 * compile/render steps trust these ids: an id with whitespace, a leading digit, or an over-long value
 * could otherwise pass semantic validation (a bypassed shape gate — a direct delegate call, a test)
 * and then break id-based compilation/rendering downstream. Unlike a fact name, an id MAY contain
 * dots/hyphens — `resolveFrom` splits a qualified `from` on the LAST dot, so a dotted id stays
 * resolvable while dot-free fact names keep `<nodeId>.<fact>` unambiguous. */
const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NODE_ID_MAX_LENGTH = 128;

/** Issue #858: a delivery-graph `agent` node's `prompt` is PLANNER/authored free text — no code path
 * injects a `Closes #N` for it (unlike the single-issue `feature.ts` path, which owns its whole
 * issue). The field case (delivery graph `5e36636255ab`, node `i12`) paired a brief scoped to ONE of
 * an issue's three acceptance criteria with "…and open a PR that closes it", so the agent wrote
 * `Closes #N` and the remainder was silently dropped. The planner/feature/scope-gate prompt contracts
 * (resources/prompts/{plan,feature,scope-classify}.md) carry the prose rule; THIS is the deterministic
 * compile/lint-time guard the issue asks for ("validate this at graph compile/lint time: an agent
 * prompt that says 'close(s) #N' must cover all of #N's checkboxes, or carry an explicit partial-scope
 * marker"). The validator is pure — it cannot read the GitHub issue to count its checkboxes — so the
 * enforceable, self-contained form is: a prompt that closes an issue must ALSO carry an explicit
 * full-scope acknowledgement marker (the exact phrase the planner is told to write when a slice
 * legitimately closes, e.g. "full stated scope" / "every acceptance criterion"). A closing keyword
 * with NO such marker is the defect class — a partial brief told to close — and is rejected.
 *
 * `ISSUE_REF_PATTERN` is the "the prompt references an issue SOMEWHERE" guard (so a bare prose "close
 * the door" / "closes it" with no `#N` never matches). It is NOT a closing-language grammar — closing
 * detection AND targeting are done by the SINGLE authoritative, negation-aware grammar
 * `CLOSING_TARGET_PATTERN` (via `closingTargets`). There used to be a second `CLOSING_ACTION_PATTERN`
 * pre-filter here that duplicated that whole active+passive grammar; it was removed (issue #858
 * round-16 review) because the duplication was a DRIFT SURFACE that violated the one-canonical rule
 * (AGENTS.md "derivation over duplication"): any syntax added only to `CLOSING_TARGET_PATTERN` was
 * silently unreachable through the prefilter and failed OPEN, and the review history repeatedly forced
 * the two regexes to be edited in lock-step. `closingTargets` already answers "is there an active,
 * non-negated close?" (it returns no target when there is none), so `isPartialScopeClose` derives that
 * answer from the one grammar instead of gating it behind a divergent copy. */
const ISSUE_REF_PATTERN =
  /(?:#[0-9]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+|https?:\/\/[^\s)]*\/issues\/[0-9]+)/i;

/** A repo-qualified issue IDENTITY key (issue #858 round-4 review). The accepted issue syntax includes
 * `owner/repo#N` and issue URLs, and this validator supports cross-repository graphs, so collapsing an
 * issue to its bare number `N` would let an acknowledgement of `owner/alpha#12`'s scope licence closing
 * a DIFFERENT issue `owner/beta#12` — both become `12`. The key preserves repository identity: an
 * EXPLICIT `owner/repo` (from `owner/repo#N` or an issue URL) keys as `owner/repo#N` (lowercased); a
 * BARE `#N` keys as `#N` (the implicit node/run repository). Two keys name the same issue only when
 * equal, so `owner/alpha#12`, `owner/beta#12`, and bare `#12` are three distinct issues. This is
 * fail-closed: a bare acknowledgement never credits an explicitly-qualified close of a different repo
 * (and vice-versa), so a cross-repo number collision can no longer bypass the guard. */
function issueKey(repo: string | null | undefined, num: string | number): string {
  const r = (repo ?? "").trim().toLowerCase();
  return `${r}#${num}`;
}

/** Every issue referenced in `text`, as a repo-qualified identity key (see `issueKey`), in any accepted
 * form (`#N`, `owner/repo#N`, or an issue URL `…/owner/repo/issues/N`). Used to (a) anchor a full-scope
 * acknowledgement to the issue it names and (b) decide whether a prompt is single-issue (so a generic,
 * un-numbered marker is unambiguous). The `owner/repo#N` and URL alternatives are ordered BEFORE the
 * bare `#N` branch so a qualified reference is captured with its repo, never as a bare number. */
const ISSUE_REF_GLOBAL =
  /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]+)|https?:\/\/[^\s)]+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+)|#([0-9]+)/gi;
function issueRefsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ISSUE_REF_GLOBAL)) {
    if (m[2] !== undefined) out.push(issueKey(m[1], m[2]));
    else if (m[4] !== undefined) out.push(issueKey(m[3], m[4]));
    else if (m[5] !== undefined) out.push(issueKey(null, m[5]));
  }
  return out;
}

/** The closing TARGETS of a prompt: which issue the closing verb actually acts on, as repo-qualified
 * identity keys (see `issueKey`). A numbered target (`closes #N`, `fixes owner/repo#N`, `resolves
 * <url>/.../issues/N`, or the `issue #N` / `GitHub issue #N` noun-phrase form) yields its key; a pronoun
 * target (`closes it` / `close the issue`) can't name an issue, so it is reported via `pronoun` and the
 * caller falls back to "the sole issue referenced". This is the SINGLE authoritative closing grammar —
 * both "is there a close?" (detection) and "which issue?" (targeting) derive from it, with no separate
 * pre-filter to drift from (issue #858 round-16 review removed the duplicate `CLOSING_ACTION_PATTERN`).
 * It recognises the verb+object forms (`close/closes/closed`, `fix/fixes/fixed`,
 * `resolve/resolves/resolved` applied to `#N`, `owner/repo#N`, an issue URL, the `issue #N` /
 * `GitHub issue #N` noun phrase, or a pronoun), the optional colon (`Closes: #12`), and the
 * quantifier/determiner on either side of `issues?` (`close both issues #12 and #13`); it
 * preserves the `owner/repo` prefix (or URL repo) so a close of `owner/beta#12` is
 * NOT satisfied by an acknowledgement anchored to `owner/alpha#12`.
 *
 * A DIRECTLY-NEGATED close is NOT a closing target (issue #858 round-7 review). A brief that explicitly
 * forbids the close (`Do not close #12; use Part of #12.`, `never close #12`, `don't resolve #12`) is a
 * SAFE partial-slice brief following the partial-slice contract — the OPPOSITE of the defect (a
 * part-scope node told TO close) — so flagging it blocks a legitimate graph. Each match is dropped when
 * the text immediately before its verb ends in a negator (`NEGATED_CLOSE_PREFIX`), so a negated close
 * no longer contributes a target. The negator→verb gap admits only ADVERBS (`do not simply close`), not
 * arbitrary words, so a meaning-flipping idiom (`do not forget to close #12` — "forget to" is a verb,
 * not an adverb) stays an ACTIVE close and is still flagged; and negating ONE close never masks a
 * DIFFERENT active close in the same prompt (`do not close #12, but close #34` still targets #34).
 *
 * The SECOND alternative is the ISSUE-FIRST / PASSIVE mirror of the verb-first grammar (issue #858
 * round-10 review): `<issue-ref> [auxiliaries] closed|fixed|resolved` — `ensure issue #12 is closed by
 * the PR`, `#12 will be closed by the PR`, `see #12 closed`, `mark #12 as resolved`, `the issue gets
 * fixed`. It captures the SAME target shapes (groups 5/6 = repo/number for `#N`, 7/8 for a URL, a
 * bare pronoun subject otherwise) so a passive close is attributed to its issue exactly like the
 * active form, and captures the auxiliary window (group 19) so a negator INSIDE it (`#12 is NOT
 * closed`) can drop the match — see `NEGATED_PASSIVE_WINDOW`. The passive subject carries the SAME
 * coordination tail as the active arm (group 14, re-scanned in `closingTargets`), so a coordinated
 * passive close (`issues #12 and #13 are closed`) attributes the close to EVERY subject, not just the
 * first (issue #858 round-18 review). This passive arm lives ONLY here, in the
 * one authoritative grammar — there is no duplicate pre-filter carrying a second copy of it. */
const CLOSING_TARGET_PATTERN =
  /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*(?::\s*){0,2}(?:(?:both|all|each|every|the)\s+)?(?:(?:github\s+)?issues?\s+)?(?:(?:both|all|each|every|the)\s+)?(?:(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*)?#([0-9]+)|https?:\/\/[^\s)]+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+)|it\b|its\s+issue\b|the issue\b|that issue\b|this issue\b|them\b)((?:\s*(?:,|and\b|&|\+|along\s+with|as\s+well\s+as|plus)\s*(?:(?:(?:both|all|each|every|the)\s+)?(?:(?:github\s+)?issues?\s+)?(?:(?:both|all|each|every|the)\s+)?(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*)?#([0-9]+)|https?:\/\/[^\s)]+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+))*)*)|(?:(?<![A-Za-z0-9_.-])(?:(?:github\s+)?issues?\s+)?(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*)?#([0-9]+)\b|https?:\/\/[^\s)]+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+)|\b(?:the|that|this|its)\s+issue\b|\bit\b|\bthem\b)((?:\s*(?:,|and\b|&|\+|along\s+with|as\s+well\s+as|plus)\s*(?:(?:(?:both|all|each|every|the)\s+)?(?:(?:github\s+)?issues?\s+)?(?:(?:both|all|each|every|the)\s+)?(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*)?#([0-9]+)|https?:\/\/[^\s)]+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+))*)*)\s+((?:\w+\s+){0,4}(?:gets?\s+|get\s+)?(?:closed|fixed|resolved)\b)/gi;
/** A negator DIRECTLY governing a closing verb, anchored (`$`) to the text ending right before the verb.
 * Covers auxiliary+not (`do/does/did/will/would/shall/should/must/may/might not`), the common
 * contractions, bare `not`/`never`/`cannot`, and `no need to`. Between the negator and the verb only
 * ADVERBS and the infinitive marker `to` are admitted (`(?:\w+ly|ever|just|simply|only|then|also|now|
 * yet|…|to)\s+){0,3}`) — NOT arbitrary words — so a verb between them (`do not forget to close` /
 * `do not hesitate to close` — "forget"/"hesitate" is a verb, not an adverb or `to`) does not bridge
 * and the close stays active, and an earlier unrelated negation blocked by punctuation/a verb (`do not
 * introduce regressions; close #12`) never reaches the verb. Admitting `to` covers the `not to close`
 * INFINITIVE (`Remember not to close #12.`, `Be sure not to close #12.`) — a brief that forbids the
 * close that way is a safe partial-slice brief, not a partial-scope-close (issue #858 round-8
 * adversarial review). */
const NEGATED_CLOSE_PREFIX =
  /(?:\b(?:do|does|did|will|would|shall|should|must|may|might)\s+not|\b(?:don|doesn|didn|won|wouldn|shouldn|mustn|mightn|shan|can)['’]t|\bcannot|\bnever|\bnot|\bno\s+need\s+to)\s+(?:(?:\w+ly|ever|just|simply|only|then|also|now|yet|automatically|silently|blindly|actually|really|to|use|using|write|writing|include|including|add|adding)\s+){0,3}(?:(?:a|an|the)\s+)?$/i;
/** The CORRELATIVE additive negation `not <adverb> …` is ADDITIVE, not prohibitive, when paired with an
 * additive continuation: `Do not just close #12; also add a release note` still INSTRUCTS the close
 * (`not only X but/also Y` keeps X), so treating it as a negated close drops a real close and lets the
 * partial brief validate (issue #858 round-8 review). This prefix matches a negator whose gap is
 * governed by a correlative/manner adverb immediately before the verb; paired with a following additive
 * continuation (`ADDITIVE_CONTINUATION`) it RE-ACTIVATES the close in `closingTargets`. The class spans
 * the correlative `just`/`only` AND any `-ly` manner adverb (`merely`/`simply`/`basically`/`hardly`/…) —
 * the additive signal is the `also`/`as well` CONTINUATION, not the specific adverb, so `Do not merely
 * close #12; also …` is the same additive construction (issue #858 round-8 adversarial review). A manner
 * adverb with NO additive continuation (`do not simply close it; leave the parent open`) genuinely
 * forbids the close and stays a safe negated close — the continuation, not the adverb, is what
 * re-activates. */
const CORRELATIVE_NEGATED_CLOSE_PREFIX =
  /(?:\b(?:do|does|did|will|would|shall|should|must|may|might)\s+not|\b(?:don|doesn|didn|won|wouldn|shouldn|mustn|mightn|shan|can)['’]t|\bcannot|\bnever|\bnot|\bno\s+need\s+to)\s+(?:(?:\w+ly|ever|then|also|now|yet|automatically|silently|blindly|actually|really|to)\s+){0,2}(?:just|only|\w+ly)\s+(?:(?:\w+ly|ever|then|now|yet|automatically|silently|blindly|actually|really|to)\s+){0,2}$/i;
/** The additive continuation that reinstates a `not <adverb>` close: an additive marker — `also` or
 * `as well` — within the SAME sentence after the close (bounded at `.`/newline so an unrelated later
 * sentence never re-activates the close). The signal is the ADDITIVE word, never a bare `but`: a bare
 * contrastive `but` (`Do not just close it; but leave the parent open`) introduces a CONTRAST, not an
 * added action, so it is a SAFE negated close — admitting it was a false-positive REGRESSION vs. round-7
 * (issue #858 round-8 adversarial review). The correlative `not only X but ALSO Y` still carries `also`,
 * so it is caught here without the bare-`but` false positive. `as well` is matched as a phrase (it never
 * leads a clause, so a word-boundary false positive is not a concern). A bare `too` is deliberately NOT
 * an additive trigger: it is also the INTENSIFIER (`too risky`/`too early`), so matching it over-fired on
 * a safe negated close followed by a `too <adj>` constraint — a fail-closed tradeoff that keeps `too` a
 * safe negation. Tested on the text immediately AFTER the matched close. */
const ADDITIVE_CONTINUATION = /^[^.\n]*?\b(?:also|as\s+well)\b/i;
/** A negator inside the AUXILIARY WINDOW of an issue-first/passive close (`issue #12 is NOT closed by
 * the PR`, `#12 will NEVER be fixed by the PR`, `the issue is not getting resolved`) — the passive
 * mirror of `NEGATED_CLOSE_PREFIX` (issue #858 round-10 review). A brief that explicitly forbids the
 * passive close (`Implement criterion 1 of #12; issue #12 is NOT closed by this PR`) is a SAFE
 * partial-slice brief, exactly like its active-voice sibling (`do not close #12`), so the match is
 * dropped. The negator is searched only inside the match's own captured auxiliary window (group 19 of
 * `CLOSING_TARGET_PATTERN`) — never across the whole prompt — so an unrelated earlier negation
 * (`do not introduce regressions; issue #12 is closed by the PR`) cannot mask an ACTIVE passive close,
 * and a `not` AFTER the participle (`#12 is closed, not merely referenced`) is not read as negating
 * the close. The window is at most four words plus an optional `get(s)`, so a plain substring test
 * suffices — no anchoring needed. */
const NEGATED_PASSIVE_WINDOW = /\b(?:not|never|cannot)\b|\b\w+n['’]t\b/i;
function closingTargets(prompt: string): { numbered: string[]; pronoun: boolean } {
  const numbered: string[] = [];
  let pronoun = false;
  for (const m of prompt.matchAll(CLOSING_TARGET_PATTERN)) {
    // A directly-negated close (`do not close #12`) is not a close TARGET — skip it. The negation never
    // masks a sibling ACTIVE close: each match is judged on the text before its OWN verb. EXCEPTION: an
    // additive `not just/only … ; also/but …` correlative still INSTRUCTS the close, so it stays a target
    // (issue #858 round-8 review).
    const before = prompt.slice(0, m.index);
    if (NEGATED_CLOSE_PREFIX.test(before)) {
      const additive =
        CORRELATIVE_NEGATED_CLOSE_PREFIX.test(before) &&
        ADDITIVE_CONTINUATION.test(prompt.slice(m.index + m[0].length));
      if (!additive) continue;
    }
    // The issue-first/passive arm (groups 10-13) carries its negation INSIDE the match's auxiliary
    // window (`#12 is NOT closed`), which the before-verb prefix check above cannot see — the negator
    // sits AFTER the arm's issue-ref start, so the text ending at `m.index` does not reach it. Drop a
    // passive close whose own window is negated (issue #858 round-10 review).
    if (m[19] !== undefined && NEGATED_PASSIVE_WINDOW.test(m[19])) continue;
    if (m[2] !== undefined) numbered.push(issueKey(m[1], m[2]));
    else if (m[4] !== undefined) numbered.push(issueKey(m[3], m[4]));
    else if (m[11] !== undefined) numbered.push(issueKey(m[10], m[11]));
    else if (m[13] !== undefined) numbered.push(issueKey(m[12], m[13]));
    else pronoun = true;
    // A COORDINATED close names every target (`close #12 and #13`, `close #12, #13, and #14`). The
    // active arm captures only the FIRST; group 5 is the whole coordinated tail, re-scanned for every
    // extra numbered target so each closed issue needs its own acknowledgement (issue #858 round-11
    // review — `close #12 and #13` previously validated with only #12 acknowledged, a fail-open bypass).
    if (m[5] !== undefined && m[5] !== "") {
      for (const e of m[5].matchAll(ISSUE_REF_GLOBAL)) {
        if (e[2] !== undefined) numbered.push(issueKey(e[1], e[2]));
        else if (e[4] !== undefined) numbered.push(issueKey(e[3], e[4]));
        else if (e[5] !== undefined) numbered.push(issueKey(null, e[5]));
      }
    }
    // The issue-first/passive arm's subject is coordinated the same way (`issues #12 and #13 are
    // closed`); group 14 is ITS whole coordinated tail, re-scanned identically so a passive close of
    // several issues checks every one (issue #858 round-18 review — `issues #12 and #13 are closed`
    // previously checked only the first subject, the same fail-open bypass one arm over).
    if (m[14] !== undefined && m[14] !== "") {
      for (const e of m[14].matchAll(ISSUE_REF_GLOBAL)) {
        if (e[2] !== undefined) numbered.push(issueKey(e[1], e[2]));
        else if (e[4] !== undefined) numbered.push(issueKey(e[3], e[4]));
        else if (e[5] !== undefined) numbered.push(issueKey(null, e[5]));
      }
    }
  }
  return { numbered, pronoun };
}

/** A whole-scope phrase ATTRIBUTED to someone other than this brief ("…is handled BY siblings",
 * "delivered BY the other slices", "owned BY another slice") does NOT acknowledge that THIS brief
 * owns the scope — it says the opposite. Such an occurrence is disqualified so it cannot licence a
 * close (issue #858 round-3: the full-scope marker must assert this node's ownership of the closing
 * target, not merely mention the scope). Matches a completion verb immediately followed by `by` SOME
 * OTHER agent, or a `by <sibling/other/peer/the rest>` agent phrase. Attribution to the CURRENT slice
 * is an AFFIRMATIVE ownership assertion, not a disclaimer, so the `<verb> by` alternative excludes a
 * self-reference agent (`by this slice` / `by the current slice` / `by me` / `by us` / `by me here`)
 * via a negative lookahead — only attribution to a non-self agent disqualifies (issue #858 round-5
 * review: "allow current-slice ownership in passive attribution"). The sibling/peer/other alternative
 * allows an optional POSSESSIVE (`our`/`their`/`the`) before the noun — `delivered by OUR siblings` is
 * still attribution to OTHERS even though `our` is a self word (the round-5 self-exclusion lookahead
 * added `our`/`us`/`my`, which let `by our siblings` slip through both alternatives; issue #858
 * round-5 adversarial review). A possessive before a SELF noun (`by our team` / `by our slice`) is
 * unaffected — those nouns are not in the others list, so they still fail the lookahead-excluded self
 * branch and do NOT disqualify.
 *
 * The `<verb> by` branch ALSO excludes an implementation METHOD — a `by <gerund>` means-clause that
 * says HOW this slice delivers the scope (`implemented by updating the parser`, `satisfied by adding
 * the migration`, `delivered by carefully refactoring`), NOT attribution to another owner (issue #858
 * round-7 review). A negative lookahead right after `by\s+` skips a (optionally adverb-prefixed)
 * gerund, so an "implemented by doing X" acknowledgement stays valid. The gerund is excluded only
 * when it GOVERNS an object — i.e. it is followed by whitespace plus a continuation that is not a
 * coordinator (`and`/`or`/`then`) or a relative pronoun (`that`/`which`/`who`): `by updating the
 * parser` / `by doing it` / `by filing tickets` are means-clauses. A BARE terminal `-ing` word (end
 * of the assertion, or punctuation next) is an ACTOR noun, not a method — `owned by engineering`,
 * `handled by marketing`, `covered by staffing`, `provided by consulting` all still disqualify
 * (issue #858 round-8 adversarial review: the round-7 lookahead excluded ANY bare `-ing` word after
 * `by`, a fail-OPEN regression vs. round-6 that let an `-ing`-named actor slip past attribution).
 * The coordinator/relative-pronoun guard keeps an `-ing` noun CONJUNCT or noun+relative-clause an
 * actor (`by engineering and product`, `by engineering that reports to product`). A DETERMINER before
 * an `-ing` word (`by the training team`) makes it an actor noun phrase, not a bare gerund, so it is
 * NOT excluded and still disqualifies — attribution to a real actor is preserved. One accepted
 * tradeoff, fail-CLOSED: an intransitive or adverb-led gerund with no object (`by pairing`, `by
 * carefully refactoring` at assertion end) reads as an actor noun and still disqualifies — a rare
 * phrasing that errs toward flagging, never toward letting an attribution through.
 *
 * Tested against the marker's DELIVERY ASSERTION, not its whole comma-bounded clause (see
 * `deliveryAssertionAround`): an attribution governing an UNRELATED constraint coordinated onto the
 * clause by `and` (`Deliver the full scope of #12 AND the regression suite is handled by another team;
 * close #12.`) attributes that other constraint, not the marker's scope, so it must NOT disqualify the
 * close — the SAME false-positive class round-6 scoped the two negation disqualifiers for (issue #858
 * round-6 adversarial review). An attribution in the marker's OWN segment (`the full scope of #12 is
 * handled by siblings`) has no coordinator between it and the marker, so it stays in-segment and still
 * disqualifies. */
const SCOPE_ATTRIBUTED_TO_OTHERS =
  /(?:handled|delivered|covered|owned|done|provided|implemented|built|completed|satisfied|addressed|met)\s+by\s+(?!(?:the\s+)?(?:this|current|present|me|us|our|my|myself|ourselves|here)\b)(?!(?:\w+ly\s+)?\w+ing\s+(?:[^\w\s]|(?!and\b|or\b|then\b|that\b|which\b|who\b)\w))|\bby\s+(?:(?:the|our|their|its|his|her)\s+)?(?:siblings?|others?|another|peers?|other\s+slices?|sibling\s+slices?|the\s+rest|the\s+others?)\b/i;

/** ACTIVE-VOICE attribution to others: a sibling/other-slice SUBJECT performing a completion verb on the
 * scope (`Siblings deliver the full scope of #12`, `the other slices own every criterion`, `another
 * slice covers the whole issue`) credits OTHERS with the delivery exactly as the passive `delivered by
 * siblings` does, so it must disqualify the marker too (issue #858 round-8 review: the passive-only
 * `SCOPE_ATTRIBUTED_TO_OTHERS` let an active-voice sibling-ownership sentence restore the attribution
 * bypass, contradicting the per-node ownership invariant). Matches an OTHERS-noun subject (siblings /
 * peers / another slice / other slices / the rest / the others, optionally possessive) followed within a
 * couple of words by a completion verb — the active voice of `SCOPE_ATTRIBUTED_TO_OTHERS`'s verb list.
 * The subject allowlist is OTHERS only (never `this`/`current` slice, `I`, `we`), so active-voice SELF
 * ownership (`this slice delivers the full scope`) stays an affirmative assertion. A `our`-POSSESSIVE
 * self-reference (`our team delivers the full scope`) is likewise SELF-ownership — the passive equivalent
 * `delivered by our team` is already treated as valid self-ownership (the `SCOPE_ATTRIBUTED_TO_OTHERS`
 * self-exclusion) — so the possessive before a `team` noun excludes `our` specifically while staying
 * OPTIONAL: a BARE `team`/`teams` (`Team delivers the full scope`) is still OTHERS-attribution exactly
 * as the round-entry code flagged it — requiring a determiner there was a fail-open regression (issue
 * #858 round-9 adversarial review). Tested against the
 * marker's DELIVERY ASSERTION (like the passive check), so a sibling clause coordinated onto an
 * UNRELATED constraint by `and`, or sitting in a different comma/`;`-bounded clause, does not over-fire.
 *
 * The subject-to-verb window spans up to four words AND tolerates a coordinator (`and`/`or`/`then`)
 * inside it: the compound-predicate subject retention (see `deliveryAssertionAround`) deliberately keeps
 * the subject for `Siblings plan AND deliver the full scope` — including its ADVERB-LED form
 * (`COMPOUND_PREDICATE_LEAD` admits `(?:\w+ly\s+)?`, e.g. `Siblings plan and CAREFULLY deliver …`) — so
 * this check must reach the verb across the coordinator gap, or the very attribution bypass the
 * retention exists to close re-opens the moment one adverb is inserted (issue #858 round-9 adversarial
 * review). Widening the window cannot over-fire onto a SELF assertion (`this slice plans and carefully
 * delivers …`): the subject allowlist is OTHERS-only, so a self-subject never matches regardless of how
 * many words precede the verb. */
const SCOPE_ACTIVE_VOICE_OTHERS =
  /\b(?:(?:(?:the|their)\s+)?(?:siblings?|other\s+slices?|sibling\s+slices?|peers?|another\s+slice|the\s+rest|the\s+others?|others|upstream\s+slice|upstream\s+slices?)|(?:(?:(?!our\b)(?:the|their|another|other)\s+)?(?<!\bour )teams?))\s+(?:(?:(?:\w+ly|and|or|then|\w+)\s+)){0,4}?(?:handle|deliver|cover|own|provide|implement|build|complete|satisfy|address|meet|do|finish|ship)(?:s|es|ed|ing)?\b/i;

/** A whole-scope phrase whose CLAUSE explicitly NEGATES or DISCLAIMS it ("this slice does NOT deliver
 * the full scope of #12", "we won't cover every acceptance criterion", "the full scope of #12 is NOT
 * delivered here") does NOT acknowledge that this brief owns the scope — it asserts the opposite, yet
 * the bare substring `full scope` is still present (issue #858 round-4 review). Such an occurrence is
 * disqualified so a negated clause cannot licence a close and re-open the partial-close bypass.
 *
 * Negation comes in TWO grammatical shapes, handled separately so an UNRELATED trailing constraint is
 * not mistaken for scope negation (issue #858 round-5 review — `Deliver the full scope of #12 without
 * regressions; close #12.` must validate):
 *  - `SCOPE_NEGATED_CORE` — core negators (`not`/`never`/`cannot`/`n't`) and the delivery-failure
 *    idioms (`fails to`/`unable to`) that negate the assertion when they sit in the marker's OWN
 *    `and`-segment (`does not deliver the full scope`, `…full scope… is NOT delivered`). Tested against
 *    the marker's DELIVERY ASSERTION, not its whole comma-bounded clause (see
 *    `deliveryAssertionAround`): a core negator governing an UNRELATED constraint coordinated onto the
 *    clause by `and` (`Deliver the full scope of #12 AND do NOT introduce regressions; close #12.`)
 *    negates that other constraint, not the marker, so it must NOT disqualify the close (issue #858
 *    round-6 review). The assertion is the clause narrowed to the `and`-bounded segment the marker sits
 *    in, so a negator in a sibling coordinated segment is excluded while one in the marker's own segment
 *    (`does not deliver the full scope`) still disqualifies. The guarantee is therefore NARROWED from
 *    "wherever they sit": a negator split into a SIBLING `and`-segment no longer disqualifies via this
 *    pattern — unless it REFERENCES DELIVERY, which `SCOPE_NEGATED_AFTER_MARKER_DELIVERY` re-catches
 *    against the whole clause (issue #858 round-6 adversarial review).
 *  - `SCOPE_NEGATED_PREFIX` — exception/redirection PREFIXES (`without`, `other than`, `rather than`,
 *    `instead of`, `apart from`, `all but`, `excluding`, …) that negate only the phrase they GOVERN,
 *    i.e. the one that FOLLOWS them. They disqualify the marker only when they sit BEFORE it in the
 *    clause; a TRAILING occurrence governs some other phrase (`…full scope… WITHOUT regressions`,
 *    `…full scope… RATHER THAN a piecemeal split`) and is an affirmative closer.
 *
 * Conservative/fail-closed: the planner contract (plan.md) directs a genuine full-scope closer to
 * carry a plain AFFIRMATIVE acknowledgement, so negating the marker's assertion is a disclaimer, not an
 * assertion. The exception idiom covers `but` only in its narrow "except" phrases (`all but` /
 * `everything but` / `anything but` / `nothing but`) — a BARE `but` is left out deliberately: it is a
 * common affirmative conjunction ("the full scope of #12, but split across two commits"), so matching
 * it would over-fire on legitimate closers. The assertion-narrowing coordinator is `and`/`plus` ONLY
 * (NOT `but`/`or`): `but` is the exception idiom's own keyword (`but without covering X` must stay a
 * disclaimer of the marker, so its segment must still include the trailing negation), and `and` is the
 * unambiguous "independent additional constraint" conjunction the round-6 false positive turned on. */
const SCOPE_NEGATED_CORE = /\b(?:not|never|cannot|fail(?:s|ing|ed)?\s+to|unable\s+to)\b|n['’]t\b/i;
const SCOPE_NEGATED_PREFIX =
  /\b(?:without|exclud(?:e|es|ing|ed)|omit(?:s|ting|ted)?|aside\s+from|apart\s+from|other\s+than|rather\s+than|instead\s+of|short\s+of|all\s+but|everything\s+but|anything\s+but|nothing\s+but)\b/i;
/** Global-flag twin of `SCOPE_NEGATED_PREFIX`, derived from its `source` so the two never drift. Used by
 * `earliestNegatorEnd` to find, in ONE left-to-right scan of a clause, the earliest offset at which a
 * prefix negator completes (so each marker can be tested against its OWN before-marker prefix without
 * re-running the regex per marker — issue #858 round-14 review). */
const SCOPE_NEGATED_PREFIX_G = new RegExp(SCOPE_NEGATED_PREFIX.source, "gi");

/** A TRAILING `without <delivery gerund>` ("Deliver the full scope of #12 WITHOUT COVERING the edge
 * cases") still disclaims completeness — it is a negation, not the benign `without <noun>` constraint
 * ("without regressions") the before-marker-only split was carved out for. Restricting
 * `SCOPE_NEGATED_PREFIX` to the before-marker text (so a trailing "without regressions" stays
 * affirmative) was a fail-open regression for this trailing delivery-negating shape (issue #858
 * round-5 adversarial review): round-4's whole-clause check caught it, the split let it through. This
 * pattern distinguishes the two by what `without` GOVERNS: a delivery gerund (covering / delivering /
 * implementing / finishing / …) means part of the scope is left undelivered, so the marker is
 * disqualified; a plain noun (regressions / tests / breaking changes) is an unrelated trailing
 * constraint and stays affirmative. Tested against the marker's DELIVERY ASSERTION (the gerund sits
 * AFTER the marker; see `deliveryAssertionAround`) — like `SCOPE_NEGATED_CORE`, a `without <gerund>`
 * coordinated onto the clause by `and` (`Deliver the full scope of #12 AND refactor without breaking
 * the build; close #12.`) governs that other constraint, not the marker, and must NOT disqualify
 * (issue #858 round-6 review). A `but without covering X` stays IN the marker's assertion (`but` is not
 * an assertion-splitting coordinator), so that trailing disclaimer still disqualifies. Two guards keep
 * it from over-firing on a benign noun that merely LOOKS like a gerund:
 *  - an article/determiner between `without` and the word ("without A covering letter", "without THE
 *    building blocks") makes the word a NOUN, so the lookbehinds exclude it; and
 *  - `meeting` is deliberately left OUT of the gerund list — "without meeting notes" (a benign noun)
 *    is more common in a brief than "without meeting every criterion", and the core-negator /
 *    scope-classify layers backstop that phrasing.
 * The gerund list is the delivery vocabulary; a `without <noun>` never matches it. */
const SCOPE_NEGATED_WITHOUT_DELIVERY =
  /\bwithout\s+(?:\w+\s+){0,2}(?<!the\s)(?<!a\s)(?<!an\s)(?<!any\s)(?<!its\s)(?<!their\s)(?<!our\s)(?<!my\s)(?<!your\s)(?<!his\s)(?<!her\s)(?:covering|delivering|implementing|finishing|completing|building|satisfying|addressing|providing|handling|doing|shipping|including)\b/i;

/** A core negator (`not`/`never`/`cannot`/`n't`/`fails to`/`unable to`) that sits AFTER the marker and
 * REFERENCES DELIVERY still disclaims the marker's scope — `Deliver the full scope of #12 AND it is not
 * fully delivered; close #12.` asserts the scope is NOT delivered, yet the `and`-coordinator splits that
 * trailing disclaimer into a sibling segment the assertion-scoped `SCOPE_NEGATED_CORE` never sees, so
 * round-6's narrowing let it VALIDATE (a fail-open regression vs. the pre-round whole-clause test; issue
 * #858 round-6 adversarial review). Tested against the marker's whole comma-bounded CLAUSE (not the
 * `and`-segment): the negator may sit in a trailing coordinated segment, and the DELIVERY reference is
 * what ties it back to the marker. The delivery reference is EITHER a delivery noun/verb
 * (`delivered`/`cover`/`implement`/`scope`/`criterion`…) OR the anaphoric `it`/`that` referring back to
 * the just-named scope. An after-marker negation with NO delivery reference (`…AND do not introduce
 * regressions`, `…AND never break the build`) governs an UNRELATED constraint and stays affirmative —
 * this pattern does NOT match it, so the round-6 false-positive fix is preserved. The delivery
 * vocabulary mirrors the attribution/gerund lists (deliver/cover/implement/complete/scope/criterion/
 * checkbox/…) plus the anaphoric `it`/`that`. */
const SCOPE_NEGATED_AFTER_MARKER_DELIVERY =
  /(?:\b(?:not|never|cannot|fail(?:s|ing|ed)?\s+to|unable\s+to)\b|\b\w+n['’]t\b)(?:\s+[\w'’-]+){0,4}?\s+(?:it|that|deliver(?:y|s|ed|ing)?|cover(?:s|ed|ing)?|implement(?:s|ed|ing)?|complet(?:e|es|ed|ing)|finish(?:es|ed|ing)?|satisf(?:y|ies|ied|ying)|acceptance\s+criteri\w+|checkbox\w*|scope|criteri\w+|done)\b/i;

/** The explicit full-scope acknowledgement markers that licence a closing keyword. These are the
 * phrases the planner contract (resources/prompts/plan.md) directs a full-scope slice to carry, so a
 * legitimately-closing brief already contains one and is NOT rejected. Matching is case-insensitive
 * substring (not a bareword regex) so inflections ("full stated scope", "the full scope", "every
 * acceptance criterion", "all acceptance criteria", "owns the whole issue") all count.
 *
 * Every marker is ISSUE-ANCHORED — it names the whole issue/scope as the thing delivered ("the whole
 * issue", "all of #N", "the entire issue", "every acceptance criterion"). A BARE adverb of
 * completeness (`fully` / `completely` / `end-to-end` / `in full` / `in its entirety`) is
 * deliberately NOT a marker: it can modify a PARTIAL deliverable ("implement one criterion of #12
 * fully, then close #12"), so accepting it would silently disable the guard for exactly the partial
 * brief it exists to catch. The contract (plan.md) tells the planner to anchor the acknowledgement
 * to the issue's whole scope, so a legitimate closer always has an anchored form available.
 *
 * These phrases are whole-scope LANGUAGE only; `isPartialScopeClose` decides, per closing target,
 * whether a phrase occurrence is actually TIED to the issue being closed (same clause / sole issue)
 * and not attributed to others — a phrase alone, anywhere in the prompt, is NOT sufficient. */
const FULL_SCOPE_MARKERS: readonly string[] = [
  "full stated scope",
  "full scope",
  "every acceptance criterion",
  "all acceptance criteria",
  "every checkbox",
  "all checkboxes",
  "owns the whole",
  "own the whole",
  "complete stated scope",
  "entire scope",
  // Issue-anchored whole-scope paraphrases — the natural phrasings a planner uses when it genuinely
  // scopes a slice to the whole issue (the under-inclusive-marker false positive this widens for).
  "the whole issue",
  "whole issue",
  "the entire issue",
  "entire issue",
  "the complete issue",
  "complete issue",
  "all of #",
  "all of the issue",
  "the whole of #",
  "the whole of the issue",
];

/** True when `prompt` pairs a GitHub closing action with NO full-scope acknowledgement TIED to the
 * issue it closes — the partial-scope-close defect class (issue #858). Requires BOTH a closing action
 * and an issue reference (so a bare prose "close the door" or "Part of #12" never matches).
 *
 * The acknowledgement is TARGET-ASSOCIATED, not a global substring (issue #858 round-3): a whole-scope
 * phrase is credited to issue `N` only when `#N` is ANCHORED to that phrase (immediately adjacent —
 * "all of #N", "the whole issue #N", "full scope of #N", "#N's full scope"), or — when the whole
 * prompt references exactly one issue — to that sole issue (unambiguous). A marker anchored to a
 * DIFFERENT issue than the one closed (acknowledge #11's scope, close #12), or one ATTRIBUTED to
 * others ("the full scope of #12 is handled by siblings; … close #12"), does NOT licence the close.
 * Every numbered closing target must be acknowledged; a pronoun close ("close it") requires every
 * referenced issue to be acknowledged (we can't tell which "it" means, so fail closed).
 *
 * This is a lexical lint that cannot read the issue body, so it is the first of a two-layer guard:
 * the scope-classify gate (resources/prompts/scope-classify.md) reads each closed issue's checkboxes
 * at PR time and catches an under-delivery that is semantically — not lexically — a partial close. */
const CLAUSE_DELIMITERS = new Set([".", ";", ":", ",", "\n", "—"]);

/** An `http(s)://…` URL span. The body runs to whitespace or `)`; trailing clause-delimiter punctuation
 * (`.`/`,`/`;`/`:`/`!`/`?`) is trimmed because it is sentence punctuation, not URL structure (a URL
 * written at the end of a clause must not swallow that clause's boundary). Delimiters INSIDE the trimmed
 * span (the `.` in `github.com`, the `:` in `https:`) are part of the URL, not clause boundaries. */
const URL_SPAN = /https?:\/\/[^\s)]+/gi;
const URL_TRAILING_PUNCT = /[.;:,!?]+$/;

/** The `[start,end)` spans of every URL in `prompt`, with trailing sentence punctuation excluded. */
function urlSpans(prompt: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = new RegExp(URL_SPAN.source, "gi");
  let m = re.exec(prompt);
  while (m !== null) {
    let end = m.index + m[0].length;
    const trailing = m[0].match(URL_TRAILING_PUNCT);
    if (trailing) end -= trailing[0].length;
    out.push([m.index, end]);
    m = re.exec(prompt);
  }
  return out;
}

/** The sorted clause-delimiter POSITIONS in `prompt`, computed once in a single O(n) pass. The
 * full-scope acknowledgement scan tests each marker occurrence against its surrounding clause; locating
 * that clause by scanning back/forward per occurrence makes the whole scan QUADRATIC in prompt length
 * when a prompt repeats a marker (issue #858 round-11 review — a valid 20,000-char prompt with repeated
 * `full scope` markers was rescanned thousands of times, monopolising the event loop across the
 * allowed 256 nodes). Precomputing the boundaries once and binary-searching them per occurrence keeps
 * the aggregate scan O(n log n) regardless of marker count.
 *
 * A delimiter INSIDE a URL is NOT a boundary (issue #858 round-12 review): treating the `:` in `https:`
 * or the `.` in `github.com` as a boundary split an issue URL, so the attribution/negation checks saw
 * only the fragment before the URL (`The full scope of https`) and missed the assertion that followed it
 * (`… is handled by siblings`). URL spans are detected once and their interior delimiters skipped. */
function clauseBoundaries(prompt: string): number[] {
  const spans = urlSpans(prompt);
  let spanIdx = 0;
  const out: number[] = [];
  for (let i = 0; i < prompt.length; i++) {
    // Advance past any span that ends at/before i (spans are non-overlapping and in order).
    while (spanIdx < spans.length && spans[spanIdx][1] <= i) spanIdx++;
    const inUrl = spanIdx < spans.length && i >= spans[spanIdx][0] && i < spans[spanIdx][1];
    if (inUrl) continue;
    if (CLAUSE_DELIMITERS.has(prompt.charAt(i))) out.push(i);
  }
  return out;
}

/** The start of the clause containing `idx`: one past the last delimiter strictly before `idx`. */
function clauseStartAt(b: number[], idx: number): number {
  let lo = 0;
  let hi = b.length; // first index with b[i] >= idx
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid] < idx) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : b[lo - 1] + 1;
}

/** The end of the clause containing `idx`: the first delimiter at or after `idx` (exclusive). */
function clauseEndAt(b: number[], idx: number, len: number): number {
  let lo = 0;
  let hi = b.length; // first index with b[i] >= idx
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid] < idx) lo = mid + 1;
    else hi = mid;
  }
  return lo === b.length ? len : b[lo];
}

/** The earliest absolute offset in `[start, end)` at which a `SCOPE_NEGATED_PREFIX` exception/redirection
 * negator COMPLETES, or `+Infinity` when the span holds none. `SCOPE_NEGATED_PREFIX` disqualifies a
 * marker only when a negator sits fully BEFORE it, and it is an UNANCHORED "contains" test monotonic in
 * the marker offset `i` (once a negator is inside `slice(start, i)` it stays inside as `i` grows). So a
 * marker at offset `i` in this clause is prefix-negated iff this value is `<= i` — computing it ONCE per
 * clause (via a single global-regex scan, taking the minimum match-END over every match) lets each of
 * the clause's markers be judged against its OWN prefix, instead of reusing one clause-wide boolean that
 * let the first (shortest-prefix) marker decide every later one (issue #858 round-14 review). The single
 * scan keeps the per-clause cost linear — no O(markers · clause-length) quadratic on a long
 * delimiter-free clause. */
function earliestNegatorEnd(prompt: string, start: number, end: number): number {
  const clause = prompt.slice(start, end);
  SCOPE_NEGATED_PREFIX_G.lastIndex = 0;
  let min = Number.POSITIVE_INFINITY;
  let m: RegExpExecArray | null = SCOPE_NEGATED_PREFIX_G.exec(clause);
  while (m !== null) {
    const matchEnd = start + m.index + m[0].length;
    if (matchEnd < min) min = matchEnd;
    if (m[0].length === 0) SCOPE_NEGATED_PREFIX_G.lastIndex++; // defensive: never loop on a zero-width match
    m = SCOPE_NEGATED_PREFIX_G.exec(clause);
  }
  return min;
}

/** The bounded text of the marker's own clause that lies BEFORE the marker occurrence at `idx`, used to
 * test the part-qualifier `PART_QUALIFIER_BEFORE_MARKER` — which narrows only the phrase that FOLLOWS it,
 * so it disqualifies the marker only when it precedes it (issue #858 round-5 review).
 *
 * `PART_QUALIFIER_BEFORE_MARKER` is a `$`-anchored SUFFIX pattern matching a bounded handful of words (a
 * partitive plus `of` and a determiner), so only the trailing few words can match: return at most the
 * last `PREFIX_WINDOW` chars — cut at a word boundary so the leading `\b` never sees a spliced token.
 * Testing the WHOLE growing before-clause per marker made the `$`-anchored regex scan O(clause-length)
 * per marker — O(markers · clause) overall, quadratic on a long delimiter-free clause (issue #858
 * round-12 review).
 *
 * This window is sound ONLY for a `$`-anchored suffix pattern. The OTHER before-marker consumer,
 * `SCOPE_NEGATED_PREFIX`, is an UNANCHORED "contains" test (a negator anywhere in the before-clause
 * disqualifies), so capping it to this window silently drops a negator sitting more than `PREFIX_WINDOW`
 * chars before the marker — a fail-open regression (issue #858 round-12 adversarial review). That
 * consumer therefore tests the WHOLE before-marker text, with the earliest negator offset cached per
 * clause start (see `negatedPrefixEndByClause` / `earliestNegatorEnd` in `isPartialScopeClose`); it does
 * NOT use this bounded window. */
const PREFIX_WINDOW = 96;
function clauseBeforeMarker(prompt: string, idx: number, b: number[]): string {
  const start = clauseStartAt(b, idx);
  if (idx - start <= PREFIX_WINDOW) return prompt.slice(start, idx);
  // Cut at a whitespace boundary at/after `idx - PREFIX_WINDOW` so no token is spliced (a mid-token cut
  // could create a spurious `\b` for the consumer's leading anchor).
  let cut = idx - PREFIX_WINDOW;
  while (cut < idx && !/\s/.test(prompt.charAt(cut))) cut++;
  return prompt.slice(cut, idx);
}

/** A coordinating conjunction that joins an INDEPENDENT additional constraint onto a clause. Only `and`
 * (and its `plus`/`&` kin) qualifies: it is the unambiguous "and also do X" additive conjunction, so a
 * negation in the segment it introduces (`…full scope of #12 AND do not introduce regressions`) governs
 * that other constraint, not the marker. `but`/`or`/`nor` are deliberately EXCLUDED — `but` is the
 * exception idiom's own keyword (`but without covering X` must keep the trailing negation inside the
 * marker's assertion so it still disqualifies), and `or` rarely coordinates an independent constraint in
 * a planner brief. (issue #858 round-6 review) */
const ASSERTION_COORDINATOR = /\b(?:and|plus)\b|&&?/gi;

/** Test-only instrumentation: the number of clause-scan steps (coordinator-threshold sweep iterations +
 * per-marker coordinator examinations) performed by the full-scope acknowledgement scan since the last
 * `resetClauseScanSteps()`. This lets the complexity regression test assert the scan is LINEAR in clause
 * size with a deterministic operation count instead of a nondeterministic wall-clock threshold (issue
 * #858 round-12 review). Not read in production logic. */
let clauseScanSteps = 0;

/** Test-only: read and reset the clause-scan step counter. Returns the count since the previous reset. */
export function drainClauseScanSteps(): number {
  const n = clauseScanSteps;
  clauseScanSteps = 0;
  return n;
}

/** Precomputed, per-clause data that lets each marker's delivery-assertion segment be located WITHOUT
 * re-scanning the clause. Round-11 precomputed the delimiter boundaries once and binary-searched them,
 * but `deliveryAssertionAround` still re-ran the coordinator regex over the whole clause and re-derived
 * every coordinator's compound-predicate status for EACH marker — so a long delimiter-free clause with M
 * markers and C coordinators cost O(M·C) slice+scan work, and the old O(tokens²)
 * `isCompoundPredicateContinuation` made it worse (issue #858 round-12 review: a valid 20,000-char
 * `full scope … and …` prompt took minutes across the 256 allowed nodes). This precompute is built ONCE
 * per clause in a single forward pass; each marker then costs O(number of coordinators in its clause)
 * with O(1) compound lookups and no re-slicing. */
interface ClauseAssertionData {
  /** The clause text (delimiter-bounded). */
  clause: string;
  /** Coordinator occurrences in order: `[bStart, bEnd]` char offsets within `clause`. */
  coords: Array<[number, number]>;
  /** Per coordinator, the minimal MARKER token index at which the text it introduces (`bEnd` up to the
   * marker) becomes a compound-predicate continuation — i.e. the coordinator stops splitting. `Infinity`
   * when the introduced text never leads with a verb. Lets the per-marker compound test be O(1). */
  compoundAtToken: number[];
  /** Token start offsets within `clause` (for mapping a marker char offset to its token index). */
  tokenStarts: number[];
  /** Per token `t`, the smallest token index `s` such that every token in `[s, t)` is an
   * adverb/coordinator (`isSkip`). The "near window" before a marker at token `t` is `[s, t)`; a
   * coordinator ending inside it has an empty/adverbs-only `introduced`, which is exactly when the
   * marker-lead compound test applies. */
  nearStart: number[];
  /** Per coordinator, `tokenIndexAt(bEnd)` — the first token at/after the coordinator's end. */
  coordTok: number[];
  /** Whether each token is an adverb/coordinator (`quickly`/`and`/`or`/`then`/`-ly`). */
  isSkip: boolean[];
  /** The first token index at/after a char offset (binary search over `tokenStarts`). */
  tokenIndexAt: (pos: number) => number;
  // --- Mutable ascending-sweep state (reset per clause; markers are fed in ascending position order) ---
  /** Index into `coords` of the next coordinator not yet pushed onto the far heap. */
  farPtr: number;
  /** Max-heap (by `bEnd`) of far coordinators' `[bEnd, compoundAtToken]`, with lazy expiry. */
  farHeap: Array<[number, number]>;
}

/** A token that can lead a compound predicate's adverb/coordinator run (`quickly`, `and`, `or`, `then`). */
const COMPOUND_SKIP_TOKEN = /^(?:\w+ly|and|or|then)$/i;
/** A token that is a delivery/completion verb lead (the compound predicate's head). Mirrors the verb
 * alternation in `COMPOUND_PREDICATE_LEAD`; matched against a whole token so a trailing `\b` inside the
 * token (e.g. `handle-bar`) still counts, exactly as the sticky lead pattern does. */
const COMPOUND_VERB_TOKEN =
  /^(?:handle|deliver|cover|own|provide|implement|build|complete|satisfy|address|meet|do|finish|ship|plan|design|scope|close|fix|resolve|add|update|open|write|create|land|merge|test|verify|document)(?:s|es|ed|ing)?\b/i;

/** Build the per-clause precompute in ONE forward pass (see `ClauseAssertionData`). Pure string/regex
 * tokenisation plus a monotonic sweep — O(tokens + coordinators) per clause. */
function buildClauseAssertionData(clause: string): ClauseAssertionData {
  // Tokenise once (whitespace-separated runs), recording each token's start offset.
  const tokenStarts: number[] = [];
  const isSkip: boolean[] = [];
  const isVerb: boolean[] = [];
  {
    const re = /\S+/g;
    let m = re.exec(clause);
    while (m !== null) {
      tokenStarts.push(m.index);
      isSkip.push(COMPOUND_SKIP_TOKEN.test(m[0]));
      isVerb.push(COMPOUND_VERB_TOKEN.test(m[0]));
      m = re.exec(clause);
    }
  }
  const T = tokenStarts.length;
  // nextContent[k] = smallest token index >= k that is NOT an adverb/coordinator (the lead candidate of
  // the suffix starting at k); T when the rest is all adverbs/coordinators.
  const nextContent = new Array<number>(T + 1).fill(T);
  for (let k = T - 1; k >= 0; k--) nextContent[k] = isSkip[k] ? nextContent[k + 1] : k;
  // leadVerbReach[k] = the verb's token index when the suffix starting at k leads with a verb, else Infinity.
  const leadVerbReach = new Array<number>(T).fill(Number.POSITIVE_INFINITY);
  for (let k = 0; k < T; k++) {
    const nc = nextContent[k];
    if (nc < T && isVerb[nc]) leadVerbReach[k] = nc;
  }
  // Coordinator occurrences in order.
  const coords: Array<[number, number]> = [];
  {
    const re = new RegExp(ASSERTION_COORDINATOR.source, "gi");
    let m = re.exec(clause);
    while (m !== null) {
      coords.push([m.index, m.index + m[0].length]);
      m = re.exec(clause);
    }
  }
  // The first token index at/after a char offset (binary search over tokenStarts).
  const tokenIndexAt = (pos: number): number => {
    let lo = 0;
    let hi = T;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokenStarts[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Per coordinator, the marker token index at which it stops splitting when its introduced text is a
  // compound-predicate continuation. The introduced text must be VERB-LED — its FIRST content token,
  // after skipping a leading adverb/coordinator run, is a completion verb (`and deliver …`, `and quickly
  // own …`). `leadVerbReach[te]` answers exactly that lead question for the suffix starting at the
  // coordinator's first introduced token `te`: it is the verb's token index (finite) iff the introduced
  // text leads with a verb, else `Infinity`.
  //
  // Testing only the LEAD (not any later suffix) is the correct semantics (issue #858 round-13 review):
  // scanning every later token until SOME suffix reaches a verb misclassifies an INDEPENDENT clause whose
  // verb merely sits later (`… and this slice delivers the full scope of #12`) as a compound predicate,
  // retaining an unrelated earlier negation/attribution; and that nested scan was itself O(coords ·
  // tokens) on a clause whose introduced text never leads with a verb. When the introduced text leads
  // with a verb the coordinator shares the prior subject for EVERY marker at/after the first introduced
  // token, so the threshold is the constant `te + 1` (the marker sits at/after token `te`); when it does
  // not, the coordinator always splits (`Infinity`). This is O(1) per coordinator — no sweep.
  const compoundAtToken = coords.map(([, bEnd]) => {
    const te = tokenIndexAt(bEnd);
    return te < T && leadVerbReach[te] !== Number.POSITIVE_INFINITY ? te + 1 : Number.POSITIVE_INFINITY;
  });
  // nearStart[t] = smallest token index `s` such that tokens [s, t) are all adverb/coordinator (`isSkip`).
  // Computed in one forward pass: as t advances, the window's left edge resets to t whenever token t-1 is
  // NOT a skip token, and otherwise extends.
  const nearStart = new Array<number>(T + 1).fill(0);
  {
    let left = 0;
    for (let t = 0; t <= T; t++) {
      if (t > 0 && !isSkip[t - 1]) left = t;
      nearStart[t] = left;
    }
  }
  const coordTok = coords.map(([, bEnd]) => tokenIndexAt(bEnd));
  return {
    clause,
    coords,
    compoundAtToken,
    tokenStarts,
    nearStart,
    coordTok,
    isSkip,
    tokenIndexAt,
    farPtr: 0,
    farHeap: [],
  };
}

/** Max-heap (by element `[0]`, the coordinator `bEnd`) operations for the far-coordinator sweep. A tiny
 * binary heap; expiry of compound coordinators is LAZY (skipped at the top on read), so a coordinator is
 * pushed/popped at most once per clause — keeping the ascending marker sweep O((markers + coordinators)
 * log coordinators) per clause instead of O(markers · coordinators). */
function heapPush(heap: Array<[number, number]>, item: [number, number]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent][0] >= heap[i][0]) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap: Array<[number, number]>): void {
  const last = heap.pop();
  if (heap.length === 0 || last === undefined) return;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    let m = i;
    if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
    if (r < heap.length && heap[r][0] > heap[m][0]) m = r;
    if (m === i) break;
    [heap[m], heap[i]] = [heap[i], heap[m]];
    i = m;
  }
}

/** The marker's DELIVERY ASSERTION: its own comma-bounded clause, further narrowed to the
 * `and`-coordinated segment the marker occurrence at `[markerStart,markerEnd)` sits in. Used by the
 * whole-assertion negation disqualifiers (`SCOPE_NEGATED_CORE`, `SCOPE_NEGATED_WITHOUT_DELIVERY`) so a
 * negator governing an UNRELATED constraint coordinated onto the clause by `and` does not disqualify the
 * marker, while a negator in the marker's own segment still does (issue #858 round-6 review). A negator
 * directly on the marker (`does not deliver the full scope`) has no coordinator between it and the
 * marker, so it stays in-segment and still disqualifies; the fail-closed default is the whole clause
 * when no coordinator splits it.
 *
 * `cache` memoises `buildClauseAssertionData` per clause start so the many markers sharing one clause do
 * not each rebuild it (issue #858 round-12 review).
 *
 * Returns the segment text AND its absolute (`prompt`-relative) `[absStart, absEnd)` bounds. The bounds
 * let the caller group occurrences that share a segment start: those segments are nested prefixes
 * (same start, growing end), so a "contains" disqualifier regex over them is MONOTONIC in the end offset
 * — the basis for the per-group memoisation in `isPartialScopeClose` (issue #858 round-12 review). */
function deliveryAssertionAround(
  prompt: string,
  markerStart: number,
  markerEnd: number,
  b: number[],
  cache: Map<number, ClauseAssertionData>,
): { text: string; absStart: number; absEnd: number } {
  const cStart = clauseStartAt(b, markerStart);
  let data = cache.get(cStart);
  if (data === undefined) {
    data = buildClauseAssertionData(prompt.slice(cStart, clauseEndAt(b, markerStart, prompt.length)));
    cache.set(cStart, data);
  }
  const { clause, coords, compoundAtToken, nearStart, coordTok, tokenIndexAt } = data;
  // The clause spans the marker; locate the marker's offset within it (the clause start is the first
  // delimiter boundary at or before markerStart).
  const relStart = markerStart - cStart;
  const relEnd = markerEnd - cStart;
  // The marker's token index: the first token starting at/after relStart. Markers are whole words found
  // by substring scan, so relStart is always a token start.
  const markerToken = tokenIndexAt(relStart);

  // The marker's assertion segment is `[segStart, segEnd)`: segStart is the end of the LAST coordinator
  // before the marker that genuinely SPLITS (is not a compound-predicate continuation), segEnd the start
  // of the first coordinator at/after the marker. A coordinator BEFORE the marker normally splits, but a
  // coordinator introducing a COMPOUND PREDICATE — a bare verb phrase with no new subject — shares the
  // prior segment's subject, so it must NOT split (else the active-voice attribution check loses the
  // subject; issue #858 round-9 review).
  //
  // Markers are fed in ASCENDING position order, so this is a single forward sweep per clause (issue
  // #858 round-12 review). Coordinators split into two sets relative to the marker:
  //  - FAR coordinators end before the marker's "near window" (the trailing adverb/coordinator run), so
  //    their introduced text contains a real (non-adverb) token and the marker-lead test canNOT apply —
  //    their compound status is purely the precomputed threshold. The max valid far `bEnd` is tracked on
  //    a max-heap, advanced and expired monotonically.
  //  - NEAR coordinators end inside the near window (empty/adverbs-only introduced), so the marker-lead
  //    test (mlc) CAN apply; there are only as many as the adverb run is long, so they are checked
  //    individually.
  const nStart = nearStart[markerToken];

  // FAR set: coordinators with coordTok <= nStart-1 (they end at/before the near window's start, so a
  // non-skip token lies between them and the marker). Push newly-in-range coordinators; expire those whose
  // compound threshold the marker has passed (they no longer split). The heap top is the max valid bEnd.
  while (data.farPtr < coords.length && coordTok[data.farPtr] <= nStart - 1) {
    heapPush(data.farHeap, [coords[data.farPtr][1], compoundAtToken[data.farPtr]]);
    data.farPtr++;
  }
  while (data.farHeap.length > 0 && data.farHeap[0][1] <= markerToken) heapPop(data.farHeap);
  const far = data.farHeap.length > 0 ? data.farHeap[0][0] : 0;

  // NEAR set: coordinators from farPtr onward whose bEnd <= relStart (they end inside the near window or
  // right at the marker). These are few (the adverb run is short); test each with the full compound rule.
  let near = 0;
  for (let ci = data.farPtr; ci < coords.length; ci++) {
    clauseScanSteps++; // test instrumentation: one near-coordinator examined per marker
    const bEnd = coords[ci][1];
    if (bEnd > relStart) break; // coords are ordered; past the marker
    // The marker's OWN lead is the continuation when the coordinator sits right at the marker
    // (`… and OWN the whole`, `introduced` empty) OR when only adverbs/coordinators intervene
    // (`… and QUICKLY own the whole`). In both the predicate's head verb is inside the marker, so test
    // the marker's lead.
    const introduced = clause.slice(bEnd, relStart);
    const markerLeadIsCompound =
      (introduced.trim() === "" || /^(?:\s*(?:\w+ly|and|or|then))*\s*$/.test(introduced)) &&
      isCompoundPredicateContinuation(clause.slice(relStart, relEnd));
    const compound = markerToken >= compoundAtToken[ci] || markerLeadIsCompound;
    if (bEnd > near && !compound) {
      near = bEnd;
    }
  }
  const segStart = Math.max(far, near);

  // segEnd: the start of the first coordinator at/after the marker's end (binary search — coords are
  // ordered by bStart).
  let segEnd = clause.length;
  {
    let lo = 0;
    let hi = coords.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (coords[mid][0] < relEnd) lo = mid + 1;
      else hi = mid;
    }
    if (lo < coords.length) segEnd = coords[lo][0];
  }
  // Return ABSOLUTE (prompt-relative) bounds so the caller can group occurrences sharing a segment start.
  return { text: clause.slice(segStart, segEnd), absStart: cStart + segStart, absEnd: cStart + segEnd };
}

/** True when the text between a coordinator and the marker is a COMPOUND PREDICATE continuation — a bare
 * verb phrase (optionally adverb-led) with NO subject noun of its own. `Siblings plan and DELIVER the
 * full scope` has `deliver` right after `and` (a verb, no new subject), so the `and` shares the prior
 * subject `Siblings`. By contrast `… and THE REGRESSION SUITE is handled …` leads with a determiner/noun
 * (a new subject), so it is an independent constraint, not a compound predicate. The heuristic: the
 * continuation leads with an optional adverb then a VERB (a delivery/completion verb or a generic
 * `-ing`/`-s`/base verb), never a determiner/pronoun/noun. Conservative — it only suppresses the split
 * when the lead word is clearly verb-like, so an independent constraint with a nominal subject still
 * splits (issue #858 round-9 review). */
const COMPOUND_PREDICATE_LEAD =
  /^\s*(?:(?:\w+ly|and|or|then)\s+)*(?:handle|deliver|cover|own|provide|implement|build|complete|satisfy|address|meet|do|finish|ship|plan|design|scope|close|fix|resolve|add|update|open|write|create|land|merge|test|verify|document)(?:s|es|ed|ing)?\b/i;
/** Sticky (anchored at `lastIndex`) form of the lead test, WITHOUT the leading `^\s*` — the caller
 * positions `lastIndex` at a token start. Derived from `COMPOUND_PREDICATE_LEAD.source` (single source of
 * truth — no divergent copy of the verb list) by stripping the leading `^\s*` anchor and adding the
 * sticky flag. Used by the linear token scan in `isCompoundPredicateContinuation` so testing every
 * token-suffix of a segment is O(tokens), not the O(tokens²) of re-joining and re-matching each suffix
 * (`tokens.slice(k).join(" ")` rebuilt a fresh string per suffix — issue #858 round-12 review: on a long
 * delimiter-free clause that per-suffix re-join made the whole full-scope scan superlinear). */
const COMPOUND_PREDICATE_LEAD_STICKY = new RegExp(
  // Strip the leading `^` anchor and the `\s*` run (the caller positions lastIndex at a token start).
  COMPOUND_PREDICATE_LEAD.source.replace(/^\^/, "").replace(/^\\s\*/, ""),
  "iy",
);
// Reference the anchored form so the canonical pattern stays a live symbol (the sticky derivative is the
// one used in the hot scan); this also guards the derivation above against a source drift that drops the
// anchor the `.replace` expects.
void COMPOUND_PREDICATE_LEAD;
function isCompoundPredicateContinuation(between: string): boolean {
  // A compound predicate is a bare VERB PHRASE with no subject of its own. It can be verb-led
  // (`and deliver …`), adverb-led (`and carefully deliver …`), or a coordinator+adverb chain whose
  // LAST token is the verb (`and quickly own …`, `and then handle …`) — the verb need not be the FIRST
  // word, only the predicate's head. So test the lead at the start AND after each adverb/coordinator
  // boundary: if any suffix leads with a completion verb, the segment is a compound continuation and
  // the coordinator shares the prior subject (issue #858 round-9 adversarial review — requiring the
  // verb first dropped the subject for `design and quickly own`, re-opening the attribution bypass).
  //
  // Test each token start with the STICKY lead pattern (O(1) per position, O(tokens) total) instead of
  // rebuilding every suffix string (O(tokens²)). Behaviour-identical to the suffix-join form: the lead
  // pattern only inspects a leading run of adverb/coordinator tokens then one verb, so anchoring it at
  // each token start matches exactly the suffixes the old loop re-joined (verified by differential fuzz).
  const n = between.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(between.charAt(i))) i++; // skip whitespace to the next token start
    if (i >= n) break;
    COMPOUND_PREDICATE_LEAD_STICKY.lastIndex = i;
    if (COMPOUND_PREDICATE_LEAD_STICKY.test(between)) return true;
    while (i < n && !/\s/.test(between.charAt(i))) i++; // advance past this token
  }
  return false;
}

/** A whole-scope marker narrowed by a PREFIX PARTITIVE ("half of every acceptance criterion", "part of
 * the whole issue", "a subset of the full scope") scopes the acknowledgement DOWN to a part, so it must
 * NOT licence a close — the mirror of `PART_QUALIFIER_AFTER_MARKER` on the LEADING side (issue #858
 * round-5 review: "detect partial-scope qualifiers before the issue marker"). Matches a partitive
 * quantifier at the END of the marker's before-clause text, so it is adjacent to the marker. The `of`
 * is OPTIONAL: the most common English partitive drops it ("half the full scope", "part the whole
 * issue", "half my scope"), so requiring a literal `of` let exactly those siblings bypass the guard
 * (issue #858 round-5 adversarial review). An optional determiner/possessive (`the`/`its`/`my`/`our`/…)
 * may sit between the partitive and the marker. Whole quantifiers (`all of`, `the whole of`) are
 * deliberately excluded — they denote the WHOLE, not a part — and an unrelated earlier "… of …" ("as
 * part of the milestone, deliver the full scope …") is not adjacent to the marker, so it does not
 * disqualify. */
const PART_QUALIFIER_BEFORE_MARKER =
  /\b(?:(?:a|one|two|three|four|five)\s+)?(?:half|part|portion|some|subset|fraction|piece|bit|chunk|segment|slice|section|fragment|sliver|handful|couple|number|few|several|most|many|much|majority|minority|remainder|rest)\s+(?:of\s+)?(?:(?:the|its|this|that|each|every|all|a|my|our|your|their|his|her)\s+)?$/i;

/** A whole-scope marker immediately followed by a PART-QUALIFIER scopes the acknowledgement DOWN to a
 * part, so it must NOT licence a close (issue #858 round-3 adversarial review). Matching is a bare
 * substring, so "the whole issue's parser slice", "all of #12's backend", and "every acceptance
 * criterion's auth half" all credit the marker even though each describes a PARTIAL deliverable — the
 * exact defect class the guard exists to catch. This pattern matches the text IMMEDIATELY after a
 * marker occurrence when that text is a possessive (`'s <part>`) or partitive (`of <part>` / `of the
 * <part>`) that narrows the whole to one slice. The marker is anchored at its end (`end`), so the
 * qualifier must be adjacent — a part-word appearing LATER in the clause ("the whole issue #12,
 * including the parser slice") does NOT disqualify. The part-word list is the vocabulary a planner
 * uses to name a sub-scope; it is deliberately broad (any of these words right after the marker means
 * the acknowledgement is not whole-scope). */
const PART_QUALIFIER_AFTER_MARKER =
  /^(?:['’]s|of)\s+(?:(?:the|a|an|one|first|second|third|single|only|just)\s+){0,2}(?:parser|slice|part|portion|half|backend|frontend|auth|criteri(?:on|a)|checkbox|front|back|ui|api|db|database|server|client|component|module|piece|section|stage|step|phase|bit|chunk|segment|subset|subpart|aspect|layer|tier|side|edge|corner|fragment|shard|sliver|remnant|rest|remainder)\b/i;

/** True when the text immediately after a whole-scope marker occurrence (at `[start,end)`) is a
 * part-qualifier that scopes the acknowledgement DOWN to a part — disqualifying the occurrence so it
 * cannot licence a close. The qualifier can follow the marker directly ("the whole issue's parser
 * slice"), follow a connective word the marker is a prefix of ("own the whole issue's backend" — the
 * marker "own the whole" ends before "issue"), or follow the `#N` anchor the marker attaches to ("all
 * of #12's backend"). So we first consume any run of connective/anchor tokens (whitespace, `issue`,
 * `scope`, `of`, `the`, `#N`) and then test for the part-qualifier at each step. */
function isPartQualified(prompt: string, end: number): boolean {
  const rest = prompt.slice(end, end + 64);
  if (PART_QUALIFIER_AFTER_MARKER.test(rest)) return true;
  // Walk past one connective/anchor token at a time, re-testing for the qualifier after each, so a
  // qualifier that follows "issue" / "scope" / "#N" (etc.) right after the marker still disqualifies.
  const step = /^(\s+|issue\b|scope\b|of\b|the\b|#[0-9]+|[0-9]+)/i;
  let offset = 0;
  for (let n = 0; n < 4; n++) {
    const m = rest.slice(offset).match(step);
    if (!m) break;
    offset += m[0].length;
    if (PART_QUALIFIER_AFTER_MARKER.test(rest.slice(offset))) return true;
  }
  return false;
}

/** A TRAILING scope-EXCLUSION connective (`except`/`excluding`/`excluded`/`omitting`/`other than`/
 * `apart from`/`aside from`/`but not`/`save for`/`with the exception of`/`minus`) that narrows a whole-scope marker DOWN to "the
 * whole MINUS a named part" — so it must NOT licence a close (issue #858 round-15 review). This is the
 * AFTER-anchor mirror of the before-marker `SCOPE_NEGATED_PREFIX` exception vocabulary: in `Deliver the
 * full scope of #12, excluding the parser; close #12.` the exclusion sits AFTER the marker's `#12`
 * anchor and the comma ends the marker's clause before it, so neither the clause-bounded
 * `SCOPE_NEGATED_AFTER_MARKER_DELIVERY` re-catch nor the before-marker `SCOPE_NEGATED_PREFIX` ever sees
 * it, and the explicitly-partial brief validated. Keyed `^\s*,?\s*…` so it may cross at most ONE comma
 * (the clause boundary the exclusion typically follows); the negative lookahead keeps an EXCLUSION OF
 * NOTHING (`excluding nothing`, `except none`, `other than no part`) affirmative — that still delivers
 * the whole scope. A BARE trailing `but` (`…, but split across two commits`) is deliberately NOT here —
 * only the `but not` exception idiom is — mirroring `SCOPE_NEGATED_PREFIX`, which leaves bare `but` out
 * as a common affirmative conjunction. Trailing `without`/`rather than`/`instead of` are likewise
 * excluded: those govern a manner/constraint and stay affirmative (the `without <delivery gerund>` case
 * is already caught by `SCOPE_NEGATED_WITHOUT_DELIVERY`). */
const SCOPE_EXCLUSION_LEAD =
  /^\s*,?\s*\b(?:except(?:ing|\s+for)?|exclud(?:e|es|ed|ing)|omit(?:s|ted|ting)?|other\s+than|apart\s+from|aside\s+from|save\s+for|but\s+not|with\s+the\s+exception\s+of|minus)\b\s+(?!nothing\b|none\b|no\b|any\s+other\b)\S/i;

/** True when a whole-scope marker ending at `end` is narrowed by a TRAILING exclusion phrase that sits
 * after the marker's issue anchor (and at most one comma). We walk past the anchor run — whitespace,
 * `of`/`the`/`issue`/`scope`/`'s`, a bare or repo-qualified `#N`, or an issue URL — re-testing for the
 * exclusion connective after each token, so `full scope of #12, excluding the parser` disqualifies even
 * though the exclusion is several anchor tokens and a comma past the marker. The walk is bounded (at
 * most 8 anchor tokens) and `SCOPE_EXCLUSION_LEAD` crosses at most one comma, so a distant `excluding`
 * governing an unrelated later phrase cannot reach back and disqualify this marker. */
function isExclusionQualified(prompt: string, end: number): boolean {
  const rest = prompt.slice(end, end + 96);
  const step = /^(?:\s+|['’]s|of\b|the\b|issue\b|scope\b|#?\s*[0-9]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|https?:\/\/[^\s)]+)/i;
  let offset = 0;
  for (let n = 0; n < 8; n++) {
    if (SCOPE_EXCLUSION_LEAD.test(rest.slice(offset))) return true;
    const m = rest.slice(offset).match(step);
    if (!m || m[0].length === 0) break;
    offset += m[0].length;
  }
  return false;
}

/** The repo-qualified issue KEY (see `issueKey`) ANCHORED to a whole-scope phrase occupying
 * `[start,end)` in `prompt`, or null if none is adjacent. Checks, in order: a `#N` (optionally
 * `owner/repo#N`) or an issue URL (`…/owner/repo/issues/N`) immediately AFTER the phrase (through at
 * most a few connective words — "of", "the", "issue"; or directly, for markers that already end in
 * `#`), then a possessive/adjacent `owner/repo#N`, bare `#N`, or issue URL immediately BEFORE it.
 * Issue URLs are a first-class issue reference (parsed by `issueRefsIn`/`closingTargets`), so the
 * anchor must recognise them too — otherwise a prompt whose only full-scope acknowledgement is
 * URL-anchored, and which references a second issue (so the sole-issue fallback is unavailable), is
 * wrongly rejected (issue #858 round-5 review). Proximity is what ties the acknowledgement to a
 * specific issue, so a phrase next to `owner/alpha#12` (or its URL) cannot license closing
 * `owner/beta#12` (or a bare `#12`) in the same clause — the repository prefix is preserved, not
 * collapsed to the bare number. */
function anchoredIssueKey(prompt: string, start: number, end: number): string | null {
  const after = prompt.slice(end, end + 96);
  const afterUrl = after.match(
    /^\s*(?:(?:of|the|issue)\s+){0,3}https?:\/\/[^\s)]+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+)/i,
  );
  if (afterUrl) return issueKey(afterUrl[1], afterUrl[2]);
  const afterMatch =
    prompt[end - 1] === "#"
      ? after.match(/^([0-9]+)/)
      : after.match(/^\s*(?:(?:of|the|issue)\s+){0,3}(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*)?#([0-9]+)/i);
  if (afterMatch) {
    // The `#`-ending-marker branch captures only a bare number (group 1); the general branch captures
    // an optional repo (group 1) then the number (group 2).
    return prompt[end - 1] === "#"
      ? issueKey(null, afterMatch[1])
      : issueKey(afterMatch[1], afterMatch[2]);
  }
  const before = prompt.slice(Math.max(0, start - 96), start);
  const beforeUrl = before.match(
    /https?:\/\/[^\s)]+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+)\/?(?:['’]s|s['’]|['’])?\s*(?:of\s+)?$/i,
  );
  if (beforeUrl) return issueKey(beforeUrl[1], beforeUrl[2]);
  const beforeMatch = before.match(/(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([0-9]+)(?:['’]s|s['’]|['’])?\s*(?:of\s+)?$/i);
  if (beforeMatch) return issueKey(beforeMatch[1], beforeMatch[2]);
  return null;
}

function isPartialScopeClose(prompt: string): boolean {
  if (!ISSUE_REF_PATTERN.test(prompt)) return false;

  // The AUTHORITATIVE closing targets (negation-aware): a directly-negated close (`do not close #12`)
  // is not a target. If every close in the prompt is negated — or there is no closing LANGUAGE at all —
  // there is no ACTIVE close to guard, so the brief is a safe partial-slice brief, not a
  // partial-scope-close (issue #858 round-7 review). `closingTargets` is the SINGLE source of the
  // closing grammar (`CLOSING_TARGET_PATTERN`); there is no separate pre-filter to drift from it
  // (issue #858 round-16 review removed the duplicate `CLOSING_ACTION_PATTERN`).
  const { numbered, pronoun } = closingTargets(prompt);
  if (numbered.length === 0 && !pronoun) return false;

  const distinct = new Set(issueRefsIn(prompt));
  const sole = distinct.size === 1 ? [...distinct][0] : null;

  // Which issues does the brief genuinely acknowledge owning the FULL scope of? Scan each whole-scope
  // phrase occurrence, anchor it to the issue immediately adjacent to it (or the sole issue), and skip
  // any occurrence whose clause attributes the scope to others, NEGATES/disclaims it ("does not deliver
  // the full scope of #12"), or that is immediately qualified DOWN to a part ("the whole issue's parser
  // slice") — each is a non-assertion, not a whole-scope acknowledgement.
  const lower = prompt.toLowerCase();
  const acknowledged = new Set<string>();
  // Clause-delimiter positions, computed ONCE (issue #858 round-11 review): the per-occurrence
  // disqualifiers below each locate the marker's clause, and doing that by scanning back/forward per
  // occurrence makes the whole scan quadratic in prompt length when a marker repeats. Binary-searching
  // the precomputed boundaries keeps it O(n log n).
  const bounds = clauseBoundaries(prompt);
  // Per-clause coordinator/segment precompute, built lazily ONCE per clause and shared across every
  // marker occurrence in that clause (issue #858 round-12 review): without it, a long delimiter-free
  // clause with many markers re-derives each coordinator's compound-predicate status per marker, which is
  // quadratic in clause length.
  const assertionCache = new Map<number, ClauseAssertionData>();
  // Collect every whole-scope marker occurrence across all marker phrases, then process them in
  // ASCENDING position order. The per-clause sweeper (`deliveryAssertionAround`) advances a coordinator
  // pointer and a far/near split monotonically as the marker position advances, so feeding occurrences
  // in ascending order keeps the whole scan LINEAR in clause size (issue #858 round-12 review); feeding
  // them phrase-by-phrase (all of one marker, then the next) would revisit earlier positions and break
  // the monotonic sweep.
  const occurrences: Array<[number, number]> = [];
  for (const marker of FULL_SCOPE_MARKERS) {
    for (let i = lower.indexOf(marker); i >= 0; i = lower.indexOf(marker, i + marker.length)) {
      occurrences.push([i, i + marker.length]);
    }
  }
  occurrences.sort((a, b) => a[0] - b[0]);
  // `SCOPE_NEGATED_AFTER_MARKER_DELIVERY` re-catches a negator that sits AFTER the marker yet still
  // disclaims its scope (`…full scope of #12 AND it is not fully delivered`). It must therefore run
  // against the MARKER-RELATIVE SUFFIX — the text from the marker to the clause end — NOT the whole
  // clause: scanning the text BEFORE the marker matched a negator that PRECEDES it (`The tests must not
  // regress and this slice delivers the full scope of #12` matches `not … delivers`), rejecting a
  // legitimate acknowledgement for a negation that governs an unrelated earlier constraint (issue #858
  // round-13 review). The suffix differs per marker, so memoise the boolean keyed by the marker's own
  // offset `i` — re-running the backtracking regex per marker over a long clause would be O(markers ·
  // clause-length), quadratic on a long delimiter-free clause (issue #858 round-12 review).
  const negatedAfterMarkerByMarker = new Map<number, boolean>();
  // `SCOPE_NEGATED_PREFIX` is an UNANCHORED "contains" test over the marker's BEFORE-MARKER text
  // (`slice(clauseStart, i)`, a negator anywhere before the marker disqualifies it), so it must NOT be
  // capped to the bounded `clauseBeforeMarker` window — that window is sound only for the `$`-anchored
  // `PART_QUALIFIER_BEFORE_MARKER`, and capping the contains test to it silently dropped a negator
  // sitting more than `PREFIX_WINDOW` chars before the marker, failing the guard open (issue #858
  // round-12 adversarial review). The before-marker text is NOT identical across a clause's markers — it
  // GROWS with each marker's offset `i` — so a single boolean keyed by clause start let the first
  // (shortest-prefix) marker decide every later one, crediting a disclaimed trailing marker whose own
  // prefix DOES hold a negator (issue #858 round-14 review). Because the test is monotonic in `i`, cache
  // instead the earliest absolute offset at which a negator completes (one O(clause-length) scan per
  // clause, via `earliestNegatorEnd`); a marker at `i` is negated iff that offset `<= i`.
  const negatedPrefixEndByClause = new Map<number, number>();
  // The four assertion disqualifiers (`SCOPE_ATTRIBUTED_TO_OTHERS`, `SCOPE_ACTIVE_VOICE_OTHERS`,
  // `SCOPE_NEGATED_CORE`, `SCOPE_NEGATED_WITHOUT_DELIVERY`) are "contains" tests over the marker's
  // assertion segment. Occurrences that share a segment START sit in nested segments (same start, growing
  // end — e.g. a delimiter-free clause where every coordinator is a compound predicate), so each such test
  // is MONOTONIC in the segment end: a prefix that matches stays matching as it grows, and a prefix that
  // does NOT match means no shorter prefix in the group matches either. So, per absStart-group, test each
  // regex ONCE against the group's LONGEST segment: if it does not match, no occurrence in the group is
  // disqualified by it; if it does match, only the occurrences at/past the minimal matching end are
  // disqualified (found by a binary search over the group's sorted ends). This collapses the per-marker
  // regex work on a pathological clause from O(markers · segment) to O(segment) per group (issue #858
  // round-12 review).
  const ASSERTION_DISQUALIFIERS: ReadonlyArray<RegExp> = [
    SCOPE_ATTRIBUTED_TO_OTHERS,
    SCOPE_ACTIVE_VOICE_OTHERS,
    SCOPE_NEGATED_CORE,
    SCOPE_NEGATED_WITHOUT_DELIVERY,
  ];

  // First pass: compute each surviving occurrence's assertion segment and group occurrences by segment
  // start (occurrences are already in ascending position order, so each group's ends come out sorted).
  interface Occurrence {
    i: number;
    markerEnd: number;
    absStart: number;
    absEnd: number;
    text: string;
  }
  const groups = new Map<number, Occurrence[]>();
  for (const [i, markerEnd] of occurrences) {
    if (isPartQualified(prompt, markerEnd)) continue;
    if (isExclusionQualified(prompt, markerEnd)) continue;
    const assertion = deliveryAssertionAround(prompt, i, markerEnd, bounds, assertionCache);
    const occ: Occurrence = { i, markerEnd, absStart: assertion.absStart, absEnd: assertion.absEnd, text: assertion.text };
    const g = groups.get(assertion.absStart);
    if (g === undefined) groups.set(assertion.absStart, [occ]);
    else g.push(occ);
  }

  // Per group + per regex, the minimal segment-end that matches (Infinity if the longest segment is
  // clean). Computed once per group against the longest segment, refined by binary search only on a hit.
  const groupMinMatch = new Map<number, number[]>();
  for (const [absStart, group] of groups) {
    const longest = group[group.length - 1]; // ascending ends ⇒ last is longest
    const minMatch = ASSERTION_DISQUALIFIERS.map((re) => {
      if (!re.test(longest.text)) return Number.POSITIVE_INFINITY; // clean for the whole group
      // The regex matches somewhere in the longest segment. Find the minimal group-end that still matches
      // (monotonic ⇒ binary search over the group's sorted absEnd values).
      let lo = 0;
      let hi = group.length - 1; // invariant: group[hi] matches, group[lo-1] (virtual) does not
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (re.test(group[mid].text)) hi = mid;
        else lo = mid + 1;
      }
      return group[lo].absEnd;
    });
    groupMinMatch.set(absStart, minMatch);
  }

  for (const [, group] of groups) {
    const minMatch = groupMinMatch.get(group[0].absStart);
    for (const occ of group) {
      const { i, markerEnd, absEnd } = occ;
      // Disqualified iff ANY assertion disqualifier matches at a segment-end <= this occurrence's end.
      let disqualified = false;
      if (minMatch !== undefined) {
        for (const m of minMatch) {
          if (m <= absEnd) {
            disqualified = true;
            break;
          }
        }
      }
      if (disqualified) continue;
      // …but a negator AFTER the marker that REFERENCES DELIVERY (`…full scope of #12 AND it is not
      // fully delivered`) still disclaims the marker even though the `and`-coordinator splits it into a
      // sibling segment the assertion above never sees — re-catch it against the marker-relative suffix
      // (the text from the marker to the clause end) so the assertion-scoping does not fail open, without
      // matching a negator that PRECEDES the marker (issue #858 round-6 + round-13 adversarial reviews).
      const clauseStart = clauseStartAt(bounds, i);
      let negatedAfterMarker = negatedAfterMarkerByMarker.get(i);
      if (negatedAfterMarker === undefined) {
        negatedAfterMarker = SCOPE_NEGATED_AFTER_MARKER_DELIVERY.test(prompt.slice(i, clauseEndAt(bounds, i, prompt.length)));
        negatedAfterMarkerByMarker.set(i, negatedAfterMarker);
      }
      if (negatedAfterMarker) continue;
      // `SCOPE_NEGATED_PREFIX` is an unanchored "contains" test, so it must run against the WHOLE
      // before-marker text — not the bounded window, which would drop a negator sitting more than
      // `PREFIX_WINDOW` chars before the marker (issue #858 round-12 adversarial review). The earliest
      // negator offset is cached per clause and compared with THIS marker's own `i` (issue #858 round-14
      // review): a clause-wide boolean let the first marker's clean prefix credit a later disclaimed one.
      // Only the genuinely `$`-anchored `PART_QUALIFIER_BEFORE_MARKER` may use the window.
      let negatedPrefixEnd = negatedPrefixEndByClause.get(clauseStart);
      if (negatedPrefixEnd === undefined) {
        negatedPrefixEnd = earliestNegatorEnd(prompt, clauseStart, clauseEndAt(bounds, i, prompt.length));
        negatedPrefixEndByClause.set(clauseStart, negatedPrefixEnd);
      }
      if (negatedPrefixEnd <= i) continue;
      if (PART_QUALIFIER_BEFORE_MARKER.test(clauseBeforeMarker(prompt, i, bounds))) continue;
      const anchored = anchoredIssueKey(prompt, i, markerEnd);
      if (anchored !== null) acknowledged.add(anchored);
      else if (sole !== null) acknowledged.add(sole);
    }
  }

  for (const n of numbered) {
    if (!acknowledged.has(n)) return true;
  }
  // A pronoun close (or a closing verb with no resolvable numbered target) can't name its issue, so
  // every referenced issue must be acknowledged for the close to be licensed.
  if (pronoun || numbered.length === 0) {
    for (const n of distinct) {
      if (!acknowledged.has(n)) return true;
    }
  }
  return false;
}

/** The graph's optional top-level `name` must match openapi's `DeliveryGraph.name` `maxLength: 255`.
 * Re-enforced here INDEPENDENTLY of the OpenAPI shape gate because later steps trust it: the compiler
 * feeds `graph.name` straight into `escapeXml(processName)` / `escapeMermaid`, so a NON-STRING name
 * (`.replace` is not a function) THROWS out of the compiler — a bypassed shape gate (a direct delegate
 * call, or a JSON-string body like the library import door's `graphJson`, where the OpenAPI schema
 * never touches the parsed value) would otherwise surface as an unhandled fault mapped to a 400 with
 * NO path-qualified `errors`, and an over-long name would be persisted despite violating the contract.
 * Validating it here turns both into a clean, path-qualified `invalid-graph-name` failure. Length is
 * counted by Unicode CODE POINT (`[...name].length`), matching openapi/JSON-Schema `maxLength`
 * semantics — NOT JS `String.length`, which counts UTF-16 code units and would reject an in-contract
 * name of ≤255 astral characters (e.g. emoji) as over-long. */
const GRAPH_NAME_MAX_LENGTH = 255;

/** Whole-graph fan-out caps mirroring openapi's `DeliveryGraph` array bounds (`nodes.maxItems: 256`,
 * `edges.maxItems: 1024`) and `DeliveryNodeCommon.emits.maxItems: 32`. Re-enforced here INDEPENDENTLY
 * of the OpenAPI shape gate because a bypassed gate (a direct delegate call, or a JSON-string body
 * like the library import/save doors' `graphJson`, where the schema never touches the parsed value)
 * would otherwise let an oversized-but-compilable graph reach the layout/compiler and be persisted —
 * both violating the declared contract and exposing the import path to avoidable CPU/memory growth. */
export const GRAPH_MAX_NODES = 256;
const GRAPH_MAX_EDGES = 1024;
const NODE_MAX_EMITS = 32;

/** The per-kind config key a node of the given kind must carry (`agent` → `agent`, etc.). */
const CONFIG_KEY: Record<DeliveryNodeKind, string> = {
  agent: "agent",
  wait: "wait",
  human: "human",
  connector: "connector",
};

/** The REQUIRED non-empty-string fields inside each kind's per-kind config object, mirroring the
 * `required` lists in openapi (`DeliveryNodeAgent.agent.jobType`, the `ReadinessProbe.kind`/`target`
 * a `wait` reuses, `DeliveryNodeConnector.connector.target`). Re-enforced here INDEPENDENTLY of the
 * OpenAPI shape gate so that, when that gate is bypassed (a direct delegate call, a test, a future
 * internal use), a config object present-but-missing its required fields (e.g. `{ kind:"agent",
 * agent:{} }`) is rejected with an actionable error rather than passing semantic validation and
 * crashing a downstream compiler/runner that assumes those fields exist. `human` has no required
 * config field (its config is optional). Kept as the single source of truth so this list and openapi
 * agree. NOTE: field PRESENCE + non-emptiness is enforced here, not the `ReadinessProbe.kind` enum —
 * that enum evolves per slice (S2 adds `pr`), so enumerating it here would drift; the enum stays
 * owned by the shape gate / `app/readiness.ts`. */
const REQUIRED_CONFIG_FIELDS: Record<DeliveryNodeKind, readonly string[]> = {
  agent: ["jobType"],
  wait: ["kind", "target"],
  human: [],
  connector: ["target"],
};

/** Resolve an edge `from` endpoint against the known node set. A node id MAY itself contain dots (the
 * openapi id pattern allows them) while a fact name (an identifier) cannot, so resolution is
 * disambiguated by the node set rather than by naive splitting: (1) if the WHOLE string is a node id
 * it is a bare completion-fact reference (`nodeId`, no fact); (2) else split at the LAST dot and, if
 * the prefix is a node id, it is a qualified `<nodeId>.<fact>` reference; (3) else it is dangling —
 * return the whole string as the (unresolvable) node id so the caller reports it against `from`.
 * When BOTH interpretations resolve — the whole string is a node id AND its last-dot prefix is a
 * node that emits the suffix as a fact — the reference is genuinely ambiguous; surface it via
 * `ambiguousWith` so the caller rejects it (`bad-from`) rather than silently choosing the whole-node
 * reading and producing an unintended DAG. */
function resolveFrom(
  from: string,
  nodeFacts: ReadonlyMap<string, ReadonlySet<string>>,
): { nodeId: string; fact?: string; ambiguousWith?: { nodeId: string; fact: string } } {
  const dot = from.lastIndexOf(".");
  const split =
    dot > 0 && dot < from.length - 1 ? { prefix: from.slice(0, dot), suffix: from.slice(dot + 1) } : undefined;
  if (nodeFacts.has(from)) {
    if (split !== undefined && nodeFacts.get(split.prefix)?.has(split.suffix)) {
      return { nodeId: from, ambiguousWith: { nodeId: split.prefix, fact: split.suffix } };
    }
    return { nodeId: from };
  }
  if (split !== undefined && nodeFacts.has(split.prefix)) return { nodeId: split.prefix, fact: split.suffix };
  return { nodeId: from };
}

/**
 * Pure, side-effect-free SEMANTIC validation of a delivery graph (ADR 0005 slice S0). Accepts the
 * graph as `unknown` because it arrives from an untyped request body — every field is read
 * defensively, so a malformed input maps to a clean {@link DeliveryGraphError} (never an uncaught
 * TypeError). Returns every error found (empty array ⇒ the graph is semantically valid), each
 * path-qualified — one entry per offending node/edge/fact, except cycle detection, which reports at
 * most ONE cycle per call to keep the output actionable (fix it and re-validate to surface the next).
 * Run this BEFORE any compile/deploy so a cycle, dangling edge, unknown kind, or unresolvable fact
 * reference is rejected with nothing started.
 */
export function validateDeliveryGraph(graph: unknown): DeliveryGraphError[] {
  const errors: DeliveryGraphError[] = [];

  if (!isRecord(graph) || !Array.isArray(graph.nodes)) {
    return [
      {
        path: "nodes",
        message: "delivery graph must be an object with a `nodes` array",
        code: "empty-graph",
      },
    ];
  }
  const nodes = graph.nodes;
  if (nodes.length === 0) {
    errors.push({
      path: "nodes",
      message: "delivery graph is empty — declare at least one node",
      code: "empty-graph",
    });
  } else if (nodes.length > GRAPH_MAX_NODES) {
    // Short-circuit on the cap BEFORE the per-node walk. Raw `graphJson` (the import/save doors)
    // bypasses openapi's `nodes.maxItems: 256`, so an arbitrarily large array would otherwise still
    // drive the full `nodes.forEach` — building the id→facts/types maps for every supplied node —
    // before returning the same 400. Rejecting on the cap ALONE keeps the advertised resource limit
    // effective (bounded validation work on an oversized untrusted import), rather than merely
    // reporting it after doing the unbounded walk.
    return [
      {
        path: "nodes",
        message: `delivery graph has too many nodes (${nodes.length}) — the limit is ${GRAPH_MAX_NODES}`,
        code: "too-many-nodes",
      },
    ];
  }

  // Top-level `name` (optional): mirror openapi's `DeliveryGraph.name` `maxLength: 255`, INDEPENDENTLY
  // of the shape gate — a non-string name would otherwise throw out of the compiler's `escapeXml`, and
  // an over-long one would be persisted despite violating the contract (see GRAPH_NAME_MAX_LENGTH).
  if (graph.name !== undefined) {
    if (typeof graph.name !== "string") {
      errors.push({
        path: "name",
        message: "delivery graph `name` must be a string",
        code: "invalid-graph-name",
      });
    } else if ([...graph.name].length > GRAPH_NAME_MAX_LENGTH) {
      errors.push({
        path: "name",
        message: `delivery graph \`name\` must be \u2264 ${GRAPH_NAME_MAX_LENGTH} characters`,
        code: "invalid-graph-name",
      });
    }
  }

  // Pass 1: node ids + kinds + per-kind config + declared facts. Build the id → declared-facts map
  // used to resolve edge `from` references in pass 2, plus the id → (fact → declared type) map guard
  // validation (pass 3) reads to enforce that a `when` references a SCALAR fact.
  const nodeFacts = new Map<string, Set<string>>();
  const nodeFactTypes = new Map<string, Map<string, DeliveryFactType>>();
  // #548 PR late-binding: the converge-connector / pr-wait nodes whose target PR must resolve to a
  // literal `owner/repo#N` OR a threaded upstream `pr` fact. Collected in pass 1, validated in pass 4
  // once the incoming fact edges are known — so an author who references a `pr` fact that isn't
  // actually threaded (or isn't `pr`-typed) is rejected at COMPILE, not left to fail closed at runtime.
  const prBindConsumers: {
    path: string;
    field: "connector.payload.pr" | "wait.target";
    id: string;
    // The authored PR ref: the connector's `payload.pr` or the wait's `target`. `undefined` when
    // absent (a connector may omit it and auto-bind the single incoming `pr` fact; a wait's `target`
    // is a required field reported missing elsewhere).
    authored: string | undefined;
  }[] = [];
  nodes.forEach((rawNode, i) => {
    const path = `nodes[${i}]`;
    if (!isRecord(rawNode)) {
      errors.push({ path, message: "each node must be an object", code: "missing-config" });
      return;
    }
    const id = rawNode.id;
    if (typeof id !== "string" || id.length === 0) {
      errors.push({ path: `${path}.id`, message: "node is missing a string `id`", code: "missing-id" });
    } else {
      if (id.length > NODE_ID_MAX_LENGTH || !NODE_ID_PATTERN.test(id)) {
        // Mirror openapi's `DeliveryNodeCommon.id` pattern/length so an invalid id can't slip past a
        // bypassed shape gate and break id-based compilation/rendering in a later slice.
        errors.push({
          path: `${path}.id`,
          message:
            `node id "${id}" must be a bare identifier (\`^[A-Za-z_][A-Za-z0-9_.-]*$\`, ` +
            `\u2264 ${NODE_ID_MAX_LENGTH} chars) so downstream id-based compilation stays safe`,
          code: "invalid-id",
        });
      }
      if (nodeFacts.has(id)) {
        errors.push({
          path: `${path}.id`,
          message: `duplicate node id "${id}" — every node id must be unique in the graph`,
          code: "duplicate-id",
        });
      }
    }

    const kind = rawNode.kind;
    if (!isDeliveryNodeKind(kind)) {
      errors.push({
        path: `${path}.kind`,
        message:
          `unknown node kind ${JSON.stringify(kind)} — must be one of ` +
          `${DELIVERY_NODE_KINDS.join(", ")} (the closed vocabulary is the trust boundary)`,
        code: "unknown-kind",
      });
    } else if (kind !== "human") {
      // Every kind but `human` REQUIRES its per-kind config object.
      const configKey = CONFIG_KEY[kind];
      const config = rawNode[configKey];
      if (!isRecord(config)) {
        errors.push({
          path: `${path}.${configKey}`,
          message: `${kind} node is missing its required \`${configKey}\` config`,
          code: "missing-config",
        });
      } else {
        // The config object is present — re-enforce the fields openapi marks REQUIRED (a bypassed
        // shape gate could otherwise let `{ kind:"agent", agent:{} }` through and crash a downstream
        // compiler/runner that trusts those fields exist).
        for (const field of REQUIRED_CONFIG_FIELDS[kind]) {
          const value = config[field];
          if (typeof value !== "string" || value.length === 0) {
            errors.push({
              path: `${path}.${configKey}.${field}`,
              message: `${kind} node's \`${configKey}.${field}\` is required and must be a non-empty string`,
              code: "missing-required-field",
            });
          }
        }
        // A `wait` node's `onTimeout: fail` cannot be honored yet: the compiler would emit a terminate
        // end on the not-ready-at-boundary path, but the engine treats terminate-end events as
        // parsed-not-executed (nanobpm/nano-bpm bpmn.rs), so `fail` would silently degrade to a plain
        // end — the "declared knob silently ignored" defect class. Reject it loudly (path-qualified)
        // until engine parity lands (Magikcraft/nano-bpm#978), rather than mis-compile it. `escalate`
        // (default) and `continue` ARE honored.
        if (kind === "wait" && config.onTimeout === "fail") {
          errors.push({
            path: `${path}.${configKey}.onTimeout`,
            message:
              "`onTimeout: fail` on a `wait` node is not yet supported (blocked on engine terminate-end " +
              "execution, Magikcraft/nano-bpm#978); use `escalate` (default) or `continue`",
            code: "unsupported-on-timeout",
          });
        }
        // A `wait` node's `poll.backoff` names a policy `parseProbe`→`parsePoll` validates against the
        // closed `BACKOFFS` enum at DISPATCH: an unrecognised value (`"linear"`) THROWS there. But the
        // compiler's display/digest path calls `normalizePoll` on the RAW graph, which silently maps every
        // unrecognised backoff to `exponential` (the default). With the doc suppressing a default backoff
        // and `digestInvisibleRawValues` only fingerprinting XML-strip differences (`"linear"` is XML-
        // clean), a `backoff:"linear"` graph shares the omitted/default-poll graph's semantic digest+run
        // key — so keyless dispatch can short-circuit the malformed proposal onto a valid running instance
        // and mark it DISPATCHED instead of rejecting it. Enforce the SAME `isBackoff` contract here at the
        // semantic boundary — trimming first, exactly like `parsePoll` (`str(raw.backoff).trim()`), so a
        // padded-but-valid `" fixed "` the runtime accepts is not false-rejected — so a malformed backoff
        // fails loudly at the preview/stage door BEFORE defaulting can mask it (issue #778 review — thread
        // readiness.ts:432, same class as the `credentialEnv` semantic-boundary checks below).
        if (kind === "wait" && isRecord(config.poll) && config.poll.backoff !== undefined && config.poll.backoff !== null) {
          const backoff = typeof config.poll.backoff === "string" ? config.poll.backoff.trim() : String(config.poll.backoff).trim();
          if (backoff !== "" && !isBackoff(backoff)) {
            errors.push({
              path: `${path}.${configKey}.poll.backoff`,
              message:
                `\`wait.poll.backoff\` must be one of ${BACKOFFS.join(", ")} (got ${JSON.stringify(config.poll.backoff)}); ` +
                "`parsePoll` rejects an unrecognised backoff at dispatch while the compiler would silently default " +
                "it — colliding the malformed graph's digest with a valid default-poll graph — so reject it here " +
                "at the semantic boundary rather than letting a malformed proposal stage and be marked dispatched",
              code: "invalid-backoff",
            });
          }
        }
        // A wait probe's `credentialEnv` names a DECLARED env-contract KEY (the secret is read from the
        // ambient env at execution time, never carried here) — but `parseProbe` only enforces that
        // `isEnvKey` contract LATER, at dispatch. The compiler surfaces the `credentialEnv` value verbatim
        // into the probe's `<bpmn:documentation>`, so a text-ingress graph could stage
        // `credentialEnv: "an-actual-secret"` and expose it in the compiled BPMN the preview door returns
        // BEFORE dispatch rejects it. Enforce the SAME `isEnvKey` contract here at the semantic boundary so
        // a non-key value can never reach the compiler (issue #778 review — thread
        // deliveryGraphCompiler.ts:1249). `parseProbe` ALSO rejects a `credentialEnv` on any non-`http`
        // probe kind (the credential selects an HTTP Authorization header — no other kind reads it), but
        // only LATER, at dispatch: a shape-valid `command`/`npm`/`github-check`/`capability` graph
        // carrying a well-formed `credentialEnv` key stages successfully and then THROWS during dispatch
        // instead of returning a compile-time validation error. Enforce the SAME `http`-only contract here
        // at the semantic boundary so the mismatch surfaces as a 400 from the preview/stage door rather
        // than a dispatch-time incident (issue #778 review — thread deliveryGraph.ts:474).
        // A PRESENT `credentialEnv` that is neither null/undefined nor a string can never name an
        // env-contract key: `parseProbe` coerces + rejects it at DISPATCH, so a shape-valid graph carrying
        // e.g. `credentialEnv: 123` stages successfully and only fails later with an unlaunchable proposal.
        // Reject a non-string here at the semantic boundary so the mismatch surfaces as a 400 from the
        // preview/stage door (issue #778 review — suppressed advisory deliveryGraph.ts:473).
        if (kind === "wait" && config.credentialEnv !== undefined && config.credentialEnv !== null && typeof config.credentialEnv !== "string") {
          errors.push({
            path: `${path}.${configKey}.credentialEnv`,
            message:
              "`wait.credentialEnv` must be a STRING naming a declared env-contract key; a non-string value " +
              "can never resolve to a key and `parseProbe` rejects it at dispatch, so reject it here rather " +
              "than let a shape-invalid graph stage and then throw during dispatch",
            code: "invalid-credential-env",
          });
        }
        if (kind === "wait" && typeof config.credentialEnv === "string" && config.credentialEnv.trim().length > 0) {
          // Compare the TRIMMED value: `parseProbe` normalises `credentialEnv` with `.trim()` before its
          // own `isEnvKey`/kind checks (readiness.ts:287), so validating the raw value here would
          // false-reject a padded-but-valid `" GITHUB_TOKEN "` the runtime accepts — keep validation and
          // execution in agreement (issue #778 review — suppressed advisory deliveryGraph.ts:466).
          const credentialEnv = config.credentialEnv.trim();
          if (!isEnvKey(credentialEnv)) {
            errors.push({
              path: `${path}.${configKey}.credentialEnv`,
              message:
                "`wait.credentialEnv` must name a DECLARED env-contract key (never a secret value — the " +
                "credential is read from the ambient env at execution time); an undeclared key is rejected " +
                "so a secret can never be smuggled into the compiled BPMN the preview door returns",
              code: "invalid-credential-env",
            });
          } else if (typeof config.kind === "string" && config.kind.trim() !== "http") {
            errors.push({
              path: `${path}.${configKey}.credentialEnv`,
              message:
                `\`credentialEnv\` is only supported for the \`http\` wait kind (probe kind is ` +
                `${JSON.stringify(config.kind)}); \`parseProbe\` rejects this combination at dispatch, so ` +
                "reject it here at the semantic boundary rather than letting a shape-valid graph stage and " +
                "then throw during dispatch",
              code: "invalid-credential-env",
            });
          }
        }
        // S5 (ADR 0006 §3): converge/merge are first-class, edge-gated CELL POLICY, not raw nodes.
        // A raw converge/merge agent job (`senior:converge`, `senior:merge`, or a bare `converge`/
        // `merge` verb) is retired as user-facing vocabulary — reject it at compile so "a raw converge
        // node is not expressible" (issue #592). The author expresses convergence/landing via the
        // cell's `converge?`/`merge?` policy instead. `senior:trial-merge` (the merge-cell's internal
        // trial body) and every other verb are unaffected (exact-verb match).
        if (kind === "agent" && typeof config.jobType === "string" && isRawConvergeMergeJobType(config.jobType)) {
          errors.push({
            path: `${path}.${configKey}.jobType`,
            message:
              `raw converge/merge agent job "${config.jobType}" is not expressible — converge and merge ` +
              "are first-class cell policy (set `agent.converge`/`agent.merge`), not a raw agent node " +
              "(ADR 0006 §3 / S5)",
            code: "raw-converge-node",
          });
        }
        // `agent.jobType` is baked VERBATIM into the executable `<zeebe:taskDefinition type=…>` attribute
        // (and mirrored into `resolved.calledElement`), so — unlike a display string — the compiler must
        // NOT let its attribute sanitiser silently strip an XML-1.0-invalid character out of it, NOR may
        // it carry a whitespace character that XML attribute-value normalization folds to a space at
        // deploy time: either would deploy a worker type differing from the authored job type (e.g.
        // `senior:\u0001feature` → `senior:feature`, or `senior:\nfeature` → `senior: feature`), silently
        // routing the cell to the wrong worker. Reject it here rather than rewrite/normalize an executable
        // value (issue #778 review — same rationale as `guard-invalid-equals`).
        if (
          kind === "agent" &&
          typeof config.jobType === "string" &&
          (hasXmlInvalidChars(config.jobType) || hasAttrNormalizedWhitespace(config.jobType))
        ) {
          errors.push({
            path: `${path}.${configKey}.jobType`,
            message:
              `\`agent.jobType\` ${JSON.stringify(redactString(stripXmlInvalidChars(config.jobType)))} contains a character that would be silently ` +
              "rewritten when emitted as the executable `<zeebe:taskDefinition type=…>` attribute — an " +
              "XML-1.0-invalid character (control characters, U+FFFE/U+FFFF, or an unpaired surrogate) that " +
              "the sanitiser strips, or attribute whitespace (tab, LF, CR) that XML attribute-value " +
              "normalization folds to a space — so it must be rejected rather than silently rewritten into " +
              "a different (wrong) worker type",
            code: "invalid-job-type",
          });
        }
        // A URL-shaped `agent.jobType` (`//user:pass@host`, `https://…`) is baked VERBATIM into the
        // executable `<zeebe:taskDefinition type=…>` for worker routing, so — unlike a display string — it
        // CANNOT be redacted in place (that would change the routing target). The compiler's display path
        // redacts a URL-shaped jobType wherever it surfaces to an operator, but the raw executable value
        // still lands in the compiled BPMN returned by the preview door, defeating that guarantee, and a
        // URL is never a legitimate Zeebe routing key anyway. Reject it at the semantic boundary (the same
        // "reject rather than rewrite an executable value" rule as `invalid-job-type` above) so a
        // credential-bearing job type can never reach the compiler (issue #778 review — thread
        // deliveryGraphCompiler.ts:1606). The message shows the REDACTED form so the 400 never echoes a
        // credential.
        if (kind === "agent" && typeof config.jobType === "string" && isUrlShaped(config.jobType)) {
          errors.push({
            path: `${path}.${configKey}.jobType`,
            message:
              `\`agent.jobType\` ${JSON.stringify(redactConnectorValue(config.jobType))} is URL-shaped — a URL is ` +
              "never a valid worker-routing job type and, since the executable `<zeebe:taskDefinition type=…>` " +
              "must carry it verbatim, a credential embedded in it would leak into the compiled BPMN. Use a " +
              "plain job-type token (e.g. `senior:feature`) and carry any endpoint/credential as a runtime " +
              "job variable instead",
            code: "url-shaped-job-type",
          });
        }
        // The url-shaped check above is ANCHORED (a job type that STARTS with a URL). A credential-bearing
        // URL can also be EMBEDDED after an otherwise plausible token (`senior:feature //user:pass@host`),
        // separated by a plain space — which `hasAttrNormalizedWhitespace` (TAB/LF/CR only) and the anchored
        // `isUrlShaped` both miss — so the `//user:pass@host` substring still lands verbatim in the
        // executable `<zeebe:taskDefinition type=…>`. Reject ANY embedded `//…@` credential token (a
        // routing key never contains one) at the same trust boundary via {@link hasEmbeddedCredential} — the
        // SAME whitespace-tolerant `//…@` span the display redactor strips, so a userinfo carrying a literal
        // space (`//user:secret pass@host`) can neither slip past this reject nor escape the display redact
        // (issue #778 review — thread deliveryGraph.ts:550/570). Message redacted.
        if (kind === "agent" && typeof config.jobType === "string" && hasEmbeddedCredential(config.jobType)) {
          errors.push({
            path: `${path}.${configKey}.jobType`,
            message:
              `\`agent.jobType\` ${JSON.stringify(redactString(stripXmlInvalidChars(config.jobType)))} embeds a ` +
              "credential-bearing URL userinfo token (`//<userinfo>@host` — the userinfo need not contain a " +
              "colon; a passwordless `//token@host` bearer token counts) that a plain worker-routing job type " +
              "never contains and that would land verbatim in the executable `<zeebe:taskDefinition type=…>`, " +
              "leaking the credential into the compiled BPMN. Use a plain job-type token and carry any " +
              "endpoint/credential as a runtime job variable instead",
            code: "credential-in-job-type",
          });
        }
        // The two checks above catch a WHOLE-value URL (anchored `isUrlShaped`) and a `//<userinfo>@`
        // credential token, but a userinfo-LESS embedded absolute URL slips both: `senior:feature
        // https://host/path?token=secret` starts with a plausible token (so the anchored check misses it)
        // and has no `//…@` (so `hasEmbeddedCredential` misses it), yet its `?token=secret` query rides an
        // explicit-scheme URL and, since the executable `<zeebe:taskDefinition type=…>` carries `jobType`
        // VERBATIM, persists in the compiled BPMN even though `nodeDisplay` redacts the operator-visible
        // descriptor. Reject ANY embedded absolute-URL token (a routing key never contains one) at this
        // same trust boundary via {@link hasEmbeddedUrl} — the SAME `scheme://…` span the display redactor
        // ({@link redactEmbeddedUrl}) strips (issue #778 review — thread deliveryGraph.ts:602). Message
        // redacted.
        if (kind === "agent" && typeof config.jobType === "string" && hasEmbeddedUrl(config.jobType)) {
          errors.push({
            path: `${path}.${configKey}.jobType`,
            message:
              `\`agent.jobType\` ${JSON.stringify(redactConnectorValue(config.jobType))} embeds an absolute URL ` +
              "(`scheme://…`) whose `?query`/`#fragment` can hide a credential token that a plain " +
              "worker-routing job type never contains and that, since the executable " +
              "`<zeebe:taskDefinition type=…>` carries the job type verbatim, would land in the compiled BPMN. " +
              "Use a plain job-type token (e.g. `senior:feature`) and carry any endpoint/credential as a " +
              "runtime job variable instead",
            code: "embedded-url-in-job-type",
          });
        }
        // The three checks above catch a whole-value URL (anchored `isUrlShaped`), a `//<userinfo>@`
        // credential token, and an explicit-scheme `scheme://…` token — but a userinfo-LESS,
        // schemeless embedded scheme-relative URL slips all three: `senior:feature //host?token=secret`
        // starts with a plausible token (anchored `isUrlShaped` misses it), has no `//…@`
        // (`hasEmbeddedCredential` misses it), and no explicit `scheme:` before the `//`
        // (`hasEmbeddedUrl` misses it), yet its `?token=secret` query rides a `//host` authority and,
        // since the executable `<zeebe:taskDefinition type=…>` carries the job type VERBATIM, persists in
        // the compiled BPMN. A worker-routing job type has no legitimate need for `//` at all, so reject
        // ANY embedded scheme-relative `//` authority token via {@link hasSchemeRelativeAuthority} — the
        // residual gap the three checks above leave (issue #778 review — thread deliveryGraph.ts:633).
        // Message redacted via `redactString` (strips `//…@` userinfo AND `?query`/`#fragment`) so the
        // 400 never echoes a credential — `redactConnectorValue` also now redacts this token, but a
        // schemeless `//host` bare authority would still surface here, so use the total `redactString`.
        // Gated behind the three checks above (each of which already REJECTS its shape with a tailored
        // code) so a value they catch is not double-reported — this fires ONLY for the residual
        // userinfo-less, schemeless embedded scheme-relative URL they all miss.
        if (
          kind === "agent" &&
          typeof config.jobType === "string" &&
          !isUrlShaped(config.jobType) &&
          !hasEmbeddedCredential(config.jobType) &&
          !hasEmbeddedUrl(config.jobType) &&
          hasSchemeRelativeAuthority(config.jobType)
        ) {
          errors.push({
            path: `${path}.${configKey}.jobType`,
            message:
              `\`agent.jobType\` ${JSON.stringify(redactString(stripXmlInvalidChars(config.jobType)))} embeds a scheme-relative ` +
              "URL authority (`//…`) — a routing key never contains `//`, and its `?query`/`#fragment` can hide a credential " +
              "token that, since the executable `<zeebe:taskDefinition type=…>` carries the job type verbatim, would land in the " +
              "compiled BPMN. Use a plain job-type token (e.g. `senior:feature`) and carry any endpoint/credential as a runtime " +
              "job variable instead",
            code: "scheme-relative-url-in-job-type",
          });
        }
        // S5 trust boundary: `validateDeliveryGraph` is the gate before `dispatchDeliveryGraphRun`
        // narrows `graph: unknown` with `as DeliveryGraph`, so a graph that bypassed OpenAPI validation
        // must not smuggle a non-boolean `converge`/`merge` past the policy checks below (which compare
        // `=== true`). A truthy `"true"`/`1` would otherwise silently evade merge-requires-converge and
        // the S5 cell policy. Reject any present-but-non-boolean value path-qualified.
        if (kind === "agent") {
          for (const flag of NODE_COMPLETION_POLICIES) {
            const value = config[flag];
            if (value !== undefined && typeof value !== "boolean") {
              errors.push({
                path: `${path}.${configKey}.${flag}`,
                message:
                  `\`agent.${flag}\`, when present, must be a boolean — got ${JSON.stringify(value)} ` +
                  "(the S5 cell policy is edge-gated on strict `true`/`false`, not a truthy value)",
                code: "converge-merge-type",
              });
            }
          }
        }
        // S5 edge-gate: `merge` presupposes `converge`. Landing a PR you have not driven to green is
        // incoherent (the two are separable phases, but merge REQUIRES converge). Reject `merge: true`
        // without `converge: true` so the enforced policy can't express "land without converging".
        if (kind === "agent" && config.merge === true && config.converge !== true) {
          errors.push({
            path: `${path}.${configKey}.merge`,
            message:
              "`agent.merge` requires `agent.converge` — a PR cannot be landed before it is driven to " +
              "green (ADR 0006 §3 two separable-but-ordered phases / S5)",
            code: "merge-requires-converge",
          });
        }
        // #739: an `agent` node may declare its OWN `repository` (`owner/repo`) + `baseBranch`, so a
        // cross-repo graph provisions each cell's isolation envelope from that node's own repo (no
        // uniform run-level repo, no `repoless`). Both are OPTIONAL (absent → the run-level fallback),
        // but a PRESENT value must pass the SAME allowlists the dispatch door / `repoEnvelopeVars` apply
        // — a plain `owner/repo` (no `.git`, no host/query chars) and a plausible git branch name — so a
        // graph that bypassed OpenAPI shape validation cannot smuggle a malformed clone URL / ref past
        // this gate into the per-node envelope. Rejected path-qualified rather than silently dropped.
        if (kind === "agent" && config.repository !== undefined && !isResolvableRepo(config.repository)) {
          errors.push({
            path: `${path}.${configKey}.repository`,
            message:
              "`agent.repository`, when present, must be an `owner/repo` reference (no trailing `.git`, no " +
              `host/query characters) — got ${JSON.stringify(config.repository)} (#739)`,
            code: "invalid-node-repository",
          });
        }
        if (kind === "agent" && config.baseBranch !== undefined && (typeof config.baseBranch !== "string" || !isPlausibleBranchName(config.baseBranch))) {
          errors.push({
            path: `${path}.${configKey}.baseBranch`,
            message:
              "`agent.baseBranch`, when present, must be a plausible git branch name (no whitespace, shell " +
              `metacharacters, leading \`-\`, \`..\`/\`//\`, etc.) — got ${JSON.stringify(config.baseBranch)} (#739)`,
            code: "invalid-node-base-branch",
          });
        }
        // Issue #858: the deterministic compile/lint-time guard for the partial-scope-close defect
        // class. An `agent` node's `prompt` is planner/authored free text; when it pairs a GitHub
        // closing keyword (`Closes/Fixes/Resolves #N`) with NO explicit full-scope acknowledgement
        // marker, it is the field-case defect (a brief scoped to PART of an issue told to close it).
        // Reject it path-qualified so the planner must either scope the brief to the issue's FULL
        // stated scope (and say so) or reference the issue non-blockingly (`Part of #N` / `Refs #N`).
        if (kind === "agent" && typeof config.prompt === "string" && isPartialScopeClose(config.prompt)) {
          errors.push({
            path: `${path}.${configKey}.prompt`,
            message:
              "`agent.prompt` closes an issue (`Closes/Fixes/Resolves #N`) but carries no full-scope " +
              "acknowledgement TIED to that issue — a brief scoped to PART of an issue must not be " +
              "told to close it (issue #858). Anchor the acknowledgement to the SAME issue you close " +
              "(e.g. \"delivers #N's full stated scope\" / \"every acceptance criterion of #N\"); a " +
              "marker for a different issue, or one attributed to siblings, does not count. Otherwise " +
              "reference the issue non-blockingly (`Part of #N` / `Refs #N`) and leave it open.",
            code: "partial-scope-close",
          });
        }
        // #548: register a converge-connector / pr-wait as a PR-binding consumer (pass 4 validates the
        // binding once edges are resolved). Only when the id is usable so pass 4 can key by node id.
        if (typeof id === "string" && id.length > 0) {
          if (kind === "connector" && typeof config.target === "string" && isConvergeTarget(config.target)) {
            const payload = isRecord(config.payload) ? config.payload : undefined;
            prBindConsumers.push({
              path,
              field: "connector.payload.pr",
              id,
              authored: payload !== undefined && typeof payload.pr === "string" ? payload.pr : undefined,
            });
          } else if (kind === "wait" && config.kind === "pr") {
            prBindConsumers.push({
              path,
              field: "wait.target",
              id,
              authored: typeof config.target === "string" ? config.target : undefined,
            });
          }
        }
      }
    } else if (rawNode.human !== undefined && !isRecord(rawNode.human)) {
      // `human` config is OPTIONAL (formKey/prompt both resolve to a generic fallback in S3), but
      // when PRESENT it must be a plain object so later slices can safely read `human.formKey` /
      // `human.prompt` — a string/array/null `human` would crash them downstream.
      errors.push({
        path: `${path}.human`,
        message: "`human` config, when present, must be an object",
        code: "missing-config",
      });
    }

    // Collect + validate this node's typed emitted facts (uniqueness within the node). Registered
    // under the id even when other fields are invalid, so downstream edge resolution is best-effort.
    const facts = new Set<string>();
    const factTypes = new Map<string, DeliveryFactType>();
    if (rawNode.emits !== undefined) {
      if (!Array.isArray(rawNode.emits)) {
        errors.push({
          path: `${path}.emits`,
          message: "`emits` must be an array of typed fact declarations",
          code: "missing-config",
        });
      } else if (rawNode.emits.length > NODE_MAX_EMITS) {
        errors.push({
          path: `${path}.emits`,
          message: `node declares too many emitted facts (${rawNode.emits.length}) — the limit is ${NODE_MAX_EMITS}`,
          code: "too-many-emits",
        });
      } else {
        rawNode.emits.forEach((rawFact, j) => {
          if (!isRecord(rawFact) || typeof rawFact.name !== "string" || rawFact.name.length === 0) {
            errors.push({
              path: `${path}.emits[${j}].name`,
              message: "each emitted fact needs a non-empty string `name`",
              code: "missing-config",
            });
            return;
          }
          if (facts.has(rawFact.name)) {
            errors.push({
              path: `${path}.emits[${j}].name`,
              message: `duplicate emitted fact "${rawFact.name}" on node "${String(id)}"`,
              code: "duplicate-fact",
            });
            return;
          }
          if (rawFact.name.length > FACT_NAME_MAX_LENGTH || !FACT_NAME_PATTERN.test(rawFact.name)) {
            // A fact name must be a dot-free identifier within openapi's 128-char cap (openapi's
            // `DeliveryFact.name` `pattern` + `maxLength`) so a qualified edge `from`
            // "<nodeId>.<fact>" resolves unambiguously and a later step trusting the cap can't be
            // overrun — enforced here too, in case the OpenAPI shape gate is bypassed.
            errors.push({
              path: `${path}.emits[${j}].name`,
              message:
                `emitted fact name "${rawFact.name}" must be a bare identifier ` +
                "(`^[A-Za-z_][A-Za-z0-9_]*$`, no dots) of " +
                `\u2264 ${FACT_NAME_MAX_LENGTH} chars so qualified edge \`from\` references stay unambiguous`,
              code: "invalid-fact-name",
            });
            return;
          }
          if (!isDeliveryFactType(rawFact.type)) {
            // emits are TYPED (Decision 3/4). An invalid/missing `type` must be rejected even when the
            // OpenAPI shape validator is bypassed, or a later step reading the type allowlist breaks.
            errors.push({
              path: `${path}.emits[${j}].type`,
              message:
                `emitted fact "${rawFact.name}" has an invalid \`type\` — must be one of ` +
                `${DELIVERY_FACT_TYPES.join(", ")}`,
              code: "invalid-fact-type",
            });
          } else {
            factTypes.set(rawFact.name, rawFact.type);
          }
          facts.add(rawFact.name);
        });
      }
    }
    if (typeof id === "string" && id.length > 0 && !nodeFacts.has(id)) {
      nodeFacts.set(id, facts);
      nodeFactTypes.set(id, factTypes);
    }
  });

  // Pass 2: edges. Resolve each endpoint against the node set and each qualified `from` against the
  // upstream node's declared facts, and build the adjacency for the cycle check.
  const edges: readonly unknown[] = Array.isArray(graph.edges) ? graph.edges : [];
  if (graph.edges !== undefined && !Array.isArray(graph.edges)) {
    // A non-array `edges` must not be silently treated as "no edges" — that would let a malformed
    // body pass semantic validation when the OpenAPI shape validator is bypassed. This is a
    // shape/type error (not an endpoint-resolution failure), so it carries `invalid-edges` — callers
    // branching on error codes must distinguish "edges isn't a list" from a genuine dangling endpoint.
    errors.push({
      path: "edges",
      message: "`edges`, when present, must be an array of `{ from, to }` dependency edges",
      code: "invalid-edges",
    });
  } else if (edges.length > GRAPH_MAX_EDGES) {
    // Re-enforce openapi's `edges.maxItems: 1024` INDEPENDENTLY of the bypassed shape gate, so an
    // oversized-but-compilable graph cannot reach the layout/compiler and be persisted. Short-circuit
    // on the cap BEFORE the `edges.forEach` walk: like the node cap, a raw import that bypasses
    // `maxItems` must not force endpoint resolution, `guardEdges` allocation, and adjacency work for
    // every edge before returning the same 400 — so the advertised resource limit stays effective.
    // Any node-level errors already accumulated in pass 1 are returned alongside the cap.
    errors.push({
      path: "edges",
      message: `delivery graph has too many edges (${edges.length}) — the limit is ${GRAPH_MAX_EDGES}`,
      code: "too-many-edges",
    });
    return errors;
  }
  // consumer (`to`) → set of upstream node ids (`from`'s node) — the dependency direction.
  const adjacency = new Map<string, Set<string>>();
  // #548: consumer (`to`) → the resolved fact edges threaded INTO it (`<node>.<fact>` refs + declared
  // types), so pass 4 can confirm a converge/wait PR reference is actually threaded and `pr`-typed.
  const incomingFactRefs = new Map<string, { ref: string; factName: string; factType: DeliveryFactType | undefined }[]>();
  // Resolved, well-formed edges captured for the guard/topology pass (pass 3). Only edges whose BOTH
  // endpoints resolve are kept — a dangling/self edge is already reported and must not reach pass 3.
  const guardEdges: {
    index: number;
    fromNode: string;
    to: string;
    when?: unknown;
    equals?: unknown;
    hasWhen: boolean;
    hasEquals: boolean;
    isDefault: boolean;
  }[] = [];
  edges.forEach((rawEdge, i) => {
    const path = `edges[${i}]`;
    // A non-object entry or a missing/empty `from`/`to` is an edge *shape* error, not an
    // endpoint-resolution failure — so it carries `invalid-edges` (like the non-array `edges` case
    // above), reserving `dangling-edge` for a well-formed endpoint that names no node/fact.
    if (!isRecord(rawEdge)) {
      errors.push({ path, message: "each edge must be an object with `from` and `to`", code: "invalid-edges" });
      return;
    }
    const from = rawEdge.from;
    const to = rawEdge.to;
    if (typeof from !== "string" || from.length === 0) {
      errors.push({ path: `${path}.from`, message: "edge is missing a string `from`", code: "invalid-edges" });
    }
    if (typeof to !== "string" || to.length === 0) {
      errors.push({ path: `${path}.to`, message: "edge is missing a string `to`", code: "invalid-edges" });
    }
    if (typeof from !== "string" || typeof to !== "string" || from.length === 0 || to.length === 0) {
      return;
    }

    if (!nodeFacts.has(to)) {
      errors.push({
        path: `${path}.to`,
        message: `edge \`to\` "${to}" names no node in the graph`,
        code: "dangling-edge",
      });
    }

    const { nodeId, fact, ambiguousWith } = resolveFrom(from, nodeFacts);
    if (ambiguousWith !== undefined) {
      errors.push({
        path: `${path}.from`,
        message:
          `edge \`from\` "${from}" is ambiguous — it names both node "${from}" (a completion ` +
          `dependency) and fact "${ambiguousWith.fact}" of node "${ambiguousWith.nodeId}"; rename ` +
          "a node id or choose a different fact to disambiguate",
        code: "bad-from",
      });
    }
    const upstreamFacts = nodeFacts.get(nodeId);
    if (upstreamFacts === undefined) {
      errors.push({
        path: `${path}.from`,
        message: `edge \`from\` "${from}" names no node in the graph`,
        code: "dangling-edge",
      });
    } else if (fact !== undefined && !upstreamFacts.has(fact)) {
      errors.push({
        path: `${path}.from`,
        message:
          `edge \`from\` "${from}" references fact "${fact}" that node "${nodeId}" does not ` +
          "declare in its `emits[]`",
        code: "bad-from",
      });
    }

    if (nodeId === to) {
      errors.push({
        path,
        message: `node "${to}" cannot depend on itself`,
        code: "self-edge",
      });
      return;
    }

    // Only wire the cycle graph for edges whose endpoints both resolve — a dangling edge is already
    // reported and must not crash the walk.
    if (nodeFacts.has(to) && upstreamFacts !== undefined) {
      const ups = adjacency.get(to) ?? new Set<string>();
      ups.add(nodeId);
      adjacency.set(to, ups);
      // #548: record a resolved, DECLARED fact edge so pass 4 can confirm a converge/wait PR reference
      // is actually threaded into its consumer (and is `pr`-typed).
      if (fact !== undefined && upstreamFacts.has(fact)) {
        const refs = incomingFactRefs.get(to) ?? [];
        refs.push({ ref: `${nodeId}.${fact}`, factName: fact, factType: nodeFactTypes.get(nodeId)?.get(fact) });
        incomingFactRefs.set(to, refs);
      }
      guardEdges.push({
        index: i,
        fromNode: nodeId,
        to,
        when: rawEdge.when,
        equals: rawEdge.equals,
        hasWhen: rawEdge.when !== undefined,
        hasEquals: rawEdge.equals !== undefined,
        isDefault: rawEdge.default === true,
      });
    }
  });

  collectCycle(adjacency, errors);
  // Passes 3 & 4 assume an otherwise structurally-sound graph (every edge resolved, no cycle) — a
  // malformed base graph is reported first, and guard/binding analysis assumes a DAG with resolved
  // fact edges. Both run under the SAME soundness snapshot so a pass-3 guard error can't suppress a
  // pass-4 binding error (they are independent classes and should surface together).
  if (errors.length === 0) {
    // Pass 3: guard (S7) semantics.
    validateGuardedEdges(guardEdges, nodeFactTypes, errors);
    // Pass 4 (#548): converge/wait PR late-binding — a referenced PR fact must be threaded + `pr`-typed.
    validatePrBindings(prBindConsumers, incomingFactRefs, nodeFacts, nodeFactTypes, errors);
  }
  return errors;
}

/** Pass 4 (#548) — validate that every converge-connector / pr-wait node can resolve its target PR.
 * A converge/wait node needs a PR to enroll or poll; it may name it three ways (mirroring the runtime
 * `resolveConvergePr` / the wait compiler `context put` late-bind):
 *   • a LITERAL `owner/repo#N` — never `<node>.<fact>`-shaped, so it resolves to no graph node and is
 *     accepted here (the worker/probe validates the literal at runtime);
 *   • a fact REFERENCE `<node>.pr` — REQUIRES that the referenced node declares a `pr`-typed fact of
 *     that name AND that a fact edge actually threads it into this consumer (else it can never bind);
 *   • OMITTED (connectors only) — auto-binds the single incoming `pr` fact, else the single incoming
 *     fact; rejected when there is no PR to bind or the choice is ambiguous.
 * Rejecting these at compile (fail closed, path-qualified) turns a silent runtime "requires payload.pr"
 * / unparseable-target failure into an actionable authoring error. */
function validatePrBindings(
  consumers: readonly {
    path: string;
    field: "connector.payload.pr" | "wait.target";
    id: string;
    authored: string | undefined;
  }[],
  incomingFactRefs: ReadonlyMap<string, { ref: string; factName: string; factType: DeliveryFactType | undefined }[]>,
  nodeFacts: ReadonlyMap<string, ReadonlySet<string>>,
  nodeFactTypes: ReadonlyMap<string, ReadonlyMap<string, DeliveryFactType>>,
  errors: DeliveryGraphError[],
): void {
  for (const c of consumers) {
    const incoming = incomingFactRefs.get(c.id) ?? [];
    const errPath = `${c.path}.${c.field}`;
    if (c.authored !== undefined) {
      // `resolveFrom` returns a `fact` iff the reference's prefix is an existing node — so a real PR
      // literal (`owner/repo#N`, no node-qualified dot) resolves to no fact and passes through.
      const resolved = resolveFrom(c.authored, nodeFacts);
      if (resolved.fact === undefined) continue; // a literal — validated at runtime.
      const ref = `${resolved.nodeId}.${resolved.fact}`;
      const declaredType = nodeFactTypes.get(resolved.nodeId)?.get(resolved.fact);
      if (declaredType === undefined) {
        errors.push({
          path: errPath,
          message:
            `${c.id}'s PR reference "${c.authored}" points at fact "${resolved.fact}" that node ` +
            `"${resolved.nodeId}" does not declare in its \`emits[]\``,
          code: "unbound-pr",
        });
      } else if (declaredType !== "pr") {
        errors.push({
          path: errPath,
          message:
            `${c.id}'s PR reference "${c.authored}" resolves to a "${declaredType}" fact — a converge/` +
            "wait PR binding must reference a `pr`-typed fact",
          code: "unbound-pr",
        });
      } else if (!incoming.some((f) => f.ref === ref)) {
        errors.push({
          path: errPath,
          message:
            `${c.id}'s PR reference "${ref}" is not threaded into it — add a fact edge ` +
            `{ from: "${ref}", to: "${c.id}" } so the emitted PR late-binds`,
          code: "unbound-pr",
        });
      }
      continue;
    }
    // OMITTED. Only a connector may omit its PR (auto-bind); a wait's `target` is a required field
    // already reported missing elsewhere, so skip it here to avoid a duplicate error.
    if (c.field !== "connector.payload.pr") continue;
    const prNamed = incoming.filter((f) => f.factName === "pr");
    if (prNamed.length === 1) {
      if (prNamed[0].factType !== "pr") {
        errors.push({
          path: errPath,
          message:
            `converge connector "${c.id}" auto-binds its single incoming \`pr\` fact, but that fact is ` +
            `typed "${prNamed[0].factType}" — declare it as \`pr\` or set connector.payload.pr explicitly`,
          code: "unbound-pr",
        });
      }
    } else if (prNamed.length === 0 && incoming.length === 1) {
      if (incoming[0].factType !== "pr") {
        errors.push({
          path: errPath,
          message:
            `converge connector "${c.id}" would auto-bind its single incoming fact "${incoming[0].ref}", ` +
            `but it is typed "${incoming[0].factType}", not \`pr\` — thread a \`pr\` fact or set ` +
            "connector.payload.pr to a literal or `<node>.pr` reference",
          code: "unbound-pr",
        });
      }
    } else {
      errors.push({
        path: errPath,
        message:
          prNamed.length === 0
            ? `converge connector "${c.id}" has no target PR — set connector.payload.pr to a literal ` +
              '"owner/repo#N" or a "<node>.pr" reference, or thread a single `pr` fact edge into it'
            : `converge connector "${c.id}" has ${prNamed.length} incoming \`pr\` facts — disambiguate ` +
              'by setting connector.payload.pr to the specific "<node>.pr" reference',
        code: "unbound-pr",
      });
    }
  }
}

/** True when a guard `equals` literal's JSON type matches the referenced fact's declared scalar type. */
function equalsMatchesFactType(equals: unknown, factType: DeliveryGuardScalarType): boolean {
  switch (factType) {
    case "string":
      return typeof equals === "string";
    case "number":
      return typeof equals === "number";
    case "boolean":
      return typeof equals === "boolean";
  }
}

/** Pass 3 — validate the S7 guarded-edge (exclusive-split) semantics over the already-resolved edge
 * set (ADR 0005 S7). Enforces, per edge: `when`⇔`equals` presence, `when`/`default` mutual exclusion,
 * and that a `when` references a DECLARED SCALAR fact of its own producer whose type matches `equals`.
 * Then, per split node: no fan-out that MIXES guarded and unconditional out-edges, at most one
 * `default`, and exhaustiveness (a guarded split must carry a `default` unless it fully covers a
 * boolean fact). Finally, the exclusive-MERGE parity the compiler relies on: a fan-in must be either
 * a pure parallel join (all producers unconditional) or a clean exclusive merge (all producers on the
 * branches of one split that reconverges here) — never a mix (a parallel AND-join fed by a conditional
 * branch would deadlock; an exclusive merge fed by an always-firing producer would double-fire). */
function validateGuardedEdges(
  guardEdges: {
    index: number;
    fromNode: string;
    to: string;
    when?: unknown;
    equals?: unknown;
    hasWhen: boolean;
    hasEquals: boolean;
    isDefault: boolean;
  }[],
  nodeFactTypes: ReadonlyMap<string, ReadonlyMap<string, DeliveryFactType>>,
  errors: DeliveryGraphError[],
): void {
  const nodeFacts = new Map<string, Set<string>>();
  for (const [id, facts] of nodeFactTypes) nodeFacts.set(id, new Set(facts.keys()));

  // Per-edge guard shape + reference validation. `guardFactType` is cached per edge for the split-level
  // exhaustiveness check below.
  const guardFactTypeByIndex = new Map<number, DeliveryGuardScalarType>();
  for (const e of guardEdges) {
    const path = `edges[${e.index}]`;
    if (e.isDefault && (e.hasWhen || e.hasEquals)) {
      errors.push({
        path,
        message: "a `default` edge cannot also carry `when`/`equals` — a default is the unguarded else-branch",
        code: "guard-default-conflict",
      });
      continue;
    }
    if (e.hasWhen && !e.hasEquals) {
      errors.push({
        path: `${path}.equals`,
        message: "a guarded edge with `when` requires an `equals` literal to compare the fact against",
        code: "guard-missing-equals",
      });
      continue;
    }
    if (e.hasEquals && !e.hasWhen) {
      errors.push({
        path: `${path}.when`,
        message: "`equals` is only meaningful with a `when` guard reference — add `when` or drop `equals`",
        code: "guard-missing-when",
      });
      continue;
    }
    if (!e.hasWhen) continue; // plain or default edge — nothing more to check here.

    const whenStr = e.when;
    if (typeof whenStr !== "string" || whenStr.length === 0) {
      errors.push({ path: `${path}.when`, message: "`when` must be a `<nodeId>.<fact>` string", code: "bad-when" });
      continue;
    }
    const { nodeId: whenNode, fact: whenFact } = resolveFrom(whenStr, nodeFacts);
    if (whenFact === undefined) {
      errors.push({
        path: `${path}.when`,
        message: `guard \`when\` "${whenStr}" must be a qualified \`<nodeId>.<fact>\` reference to a declared fact`,
        code: "bad-when",
      });
      continue;
    }
    if (whenNode !== e.fromNode) {
      errors.push({
        path: `${path}.when`,
        message:
          `guard \`when\` "${whenStr}" must reference a fact of this edge's producer "${e.fromNode}" ` +
          `(the exclusive-split point), not "${whenNode}"`,
        code: "bad-when",
      });
      continue;
    }
    const factType = nodeFactTypes.get(whenNode)?.get(whenFact);
    if (factType === undefined || !isDeliveryGuardScalarType(factType)) {
      errors.push({
        path: `${path}.when`,
        message:
          `guard \`when\` "${whenStr}" must reference a declared SCALAR fact ` +
          `(${DELIVERY_GUARD_SCALAR_TYPES.join(", ")}) of "${whenNode}"`,
        code: "bad-when",
      });
      continue;
    }
    if (!equalsMatchesFactType(e.equals, factType)) {
      errors.push({
        path: `${path}.equals`,
        message:
          `guard \`equals\` for "${whenStr}" must be a ${factType} to match the fact's declared type`,
        code: "guard-type-mismatch",
      });
      continue;
    }
    // A string `equals` is baked VERBATIM into the compiled `<bpmn:conditionExpression>` FEEL literal,
    // so an XML-1.0-invalid character in it (a C0 control, U+FFFE/U+FFFF, a lone surrogate) cannot be
    // entity-escaped and the compiler's display-text sanitiser would silently STRIP it — mutating
    // executable FEEL (e.g. `"a\uFFFEb"` → `"ab"`) and potentially routing the split down the wrong
    // edge. Reject it here rather than silently rewrite the guard (issue #778 review).
    if (typeof e.equals === "string" && hasXmlInvalidChars(e.equals)) {
      errors.push({
        path: `${path}.equals`,
        message:
          `guard \`equals\` for "${whenStr}" contains XML-1.0-invalid characters (control characters, ` +
          "U+FFFE/U+FFFF, or an unpaired surrogate) that cannot be represented in the compiled FEEL " +
          "condition — remove them rather than let the guard be silently rewritten",
        code: "guard-invalid-equals",
      });
      continue;
    }
    guardFactTypeByIndex.set(e.index, factType);
  }

  // Group out-edges by producer node to check fan-out shape (mixing / defaults / exhaustiveness).
  const outByNode = new Map<string, typeof guardEdges>();
  for (const e of guardEdges) {
    const list = outByNode.get(e.fromNode) ?? [];
    list.push(e);
    outByNode.set(e.fromNode, list);
  }
  const splitNodes = new Set<string>();
  for (const [node, outs] of outByNode) {
    const guarded = outs.filter((e) => e.hasWhen && !e.isDefault);
    const defaults = outs.filter((e) => e.isDefault);
    const plain = outs.filter((e) => !e.hasWhen && !e.isDefault);
    const isSplit = guarded.length > 0 || defaults.length > 0;
    if (!isSplit) continue;
    // Only a GUARDED (`when`) fan-out to >=2 DISTINCT downstream targets is an exclusive split for
    // topology. A lone `default: true` edge (no guarded sibling) always fires, and a node whose
    // guarded + `default` edges all converge on ONE downstream node has no real fan-out — that node
    // fires whenever its producer does. Adding either here would spuriously mark downstream
    // nodes/leaves conditional and trip false exclusive-merge parity (or misselect the End join). The
    // per-node mixing/exhaustiveness checks below still run for any `default` fan-out (they gate on
    // `isSplit`); only the topology set is guard-derived and fan-out-shaped.
    const branchTargets = new Set([...guarded, ...defaults].map((e) => e.to));
    if (guarded.length > 0 && branchTargets.size > 1) splitNodes.add(node);

    if (plain.length > 0) {
      // No mixing: a node is a fork (all edges unconditional) OR an XOR-split (all edges guarded/
      // default), never both — a plain edge always fires and would break exclusive-branch selection.
      errors.push({
        path: `edges[${plain[0].index}]`,
        message:
          `node "${node}" mixes guarded/default out-edges with an unconditional one — a split node's ` +
          "out-edges must ALL be guarded (`when`) or `default`",
        code: "mixed-fan-out",
      });
    }
    if (defaults.length > 1) {
      errors.push({
        path: `edges[${defaults[1].index}]`,
        message: `node "${node}" has more than one \`default\` out-edge — at most one else-branch per split`,
        code: "multiple-defaults",
      });
    }

    // Exhaustiveness: a guarded split must carry a `default`, UNLESS it fully covers a single boolean
    // fact (both `true` and `false` guarded) — the only value domain equality guards can exhaust.
    if (defaults.length === 0) {
      const guardFactTypes = new Set(guarded.map((e) => guardFactTypeByIndex.get(e.index)));
      const booleanFacts = new Set(
        guarded.filter((e) => guardFactTypeByIndex.get(e.index) === "boolean").map((e) => String(e.when)),
      );
      let exhaustive = false;
      if (guardFactTypes.size === 1 && booleanFacts.size === 1) {
        const covered = new Set(guarded.map((e) => e.equals));
        exhaustive = covered.has(true) && covered.has(false);
      }
      if (!exhaustive) {
        errors.push({
          path: `edges[${guarded[0]?.index ?? outs[0].index}]`,
          message:
            `guarded split "${node}" is not exhaustive — add a \`default\` else-branch (or cover both ` +
            "values of a boolean fact) so no runtime value strands the token",
          code: "non-exhaustive-split",
        });
      }
    }
  }

  // Exclusive-merge parity. An edge is CONDITIONAL if it leaves a split (a guarded/default branch) or
  // its producer is itself only conditionally reached; both are computed from the split set + forward
  // reachability. A fan-in must be uniformly conditional (a clean exclusive merge) or uniformly
  // unconditional (a parallel join) — a mix is the deadlock/double-fire shape the compiler cannot wire.
  const forwardAdj = new Map<string, string[]>();
  const allNodes = new Set<string>();
  for (const [id] of nodeFactTypes) allNodes.add(id);
  for (const e of guardEdges) {
    allNodes.add(e.fromNode);
    allNodes.add(e.to);
    const list = forwardAdj.get(e.fromNode) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    forwardAdj.set(e.fromNode, list);
  }
  const topo = analyzeExclusiveTopology([...allNodes], forwardAdj, splitNodes);

  // producers per consumer (node id), from resolved edges.
  const producersByNode = new Map<string, Set<string>>();
  for (const e of guardEdges) {
    const set = producersByNode.get(e.to) ?? new Set<string>();
    set.add(e.fromNode);
    producersByNode.set(e.to, set);
  }
  const edgeConditional = (fromNode: string): boolean => splitNodes.has(fromNode) || topo.conditional.has(fromNode);

  for (const [node, producers] of producersByNode) {
    if (producers.size < 2) continue;
    const conditional = [...producers].filter(edgeConditional);
    const unconditional = [...producers].filter((p) => !edgeConditional(p));
    if (conditional.length > 0 && unconditional.length > 0) {
      errors.push({
        path: "edges",
        message:
          `node "${node}" joins a conditional (exclusive-split) branch with an always-firing branch — ` +
          "a parallel AND-join here deadlocks (the untaken branch never arrives). Route both through " +
          "one exclusive split so they re-converge as an exclusive merge",
        code: "exclusive-merge-parity",
      });
    } else if (conditional.length === producers.size && !topo.mergeNodes.has(node)) {
      errors.push({
        path: "edges",
        message:
          `node "${node}" merges conditional branches that do not re-converge from a single exclusive ` +
          "split — its incoming branches are not provably mutually exclusive, so it cannot merge safely",
        code: "exclusive-merge-parity",
      });
    }
  }

  // Same parity, now for the implicit End sink: the compiler joins every LEAF (a node with no
  // out-edge) at the process End. A leaf is conditional iff it may not fire on a given run
  // (`topo.conditional`). A leaf set that MIXES a conditional tail with an always-firing one is the
  // exact deadlock/double-fire shape the End gateway cannot wire — a parallel AND-join waits forever
  // for the untaken branch, an exclusive merge double-fires when both arrive — so reject it here (this
  // is the invariant the compiler's End-gateway selection relies on).
  const leaves = [...allNodes].filter((n) => (forwardAdj.get(n)?.length ?? 0) === 0);
  if (leaves.length > 1) {
    const conditionalLeaves = leaves.filter((n) => topo.conditional.has(n));
    if (conditionalLeaves.length > 0 && conditionalLeaves.length < leaves.length) {
      errors.push({
        path: "edges",
        message:
          "the graph's terminal nodes mix a conditional (exclusive-split) tail with an always-firing " +
          "tail — the End sink would deadlock as a parallel join (the untaken branch never arrives) or " +
          "double-fire as an exclusive merge. Route the conditional tails so they re-converge before the end",
        code: "exclusive-merge-parity",
      });
    }
  }
}

/** Depth-first cycle detection over the consumer(`to`)→producer(`from`) graph. Pushes ONE
 * {@link DeliveryGraphError} naming the offending cycle (the "reject at the offending edge"
 * guarantee) — a pure in-memory walk, no I/O. Reports at most one cycle so the message stays
 * actionable; the author fixes it and re-validates to surface any next one. */
function collectCycle(adjacency: Map<string, Set<string>>, errors: DeliveryGraphError[]): void {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  let reported = false;
  const visit = (node: string, stack: string[]): void => {
    if (reported) return;
    state.set(node, VISITING);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (reported) break;
      const s = state.get(next);
      if (s === VISITING) {
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next];
        errors.push({
          path: "edges",
          message: `dependency cycle detected: ${cycle.join(" → ")} — the graph must be a DAG`,
          code: "cycle",
        });
        reported = true;
        return;
      }
      if (s !== DONE) visit(next, stack);
    }
    stack.pop();
    state.set(node, DONE);
  };
  for (const node of adjacency.keys()) {
    if (reported) break;
    if (state.get(node) !== DONE) visit(node, []);
  }
}

/** The exclusive-split topology derived from a graph's node-level forward adjacency and its set of
 * exclusive-split node ids (ADR 0005 S7). This is the SINGLE canonical analysis both the semantic
 * validator (parity enforcement) and the S1 compiler (gateway-type selection) consume, so the two
 * never drift on which fan-in is an exclusive merge vs a parallel join:
 *
 *   • `mergeNodes` — nodes where ≥2 DISTINCT branch targets of the SAME split re-converge (following
 *     edges forward). These fan-ins must compile to an exclusive/OR merge (first-token-proceeds), not
 *     a parallel AND-join, which would deadlock waiting for the untaken branch.
 *   • `conditional` — nodes that MAY NOT execute on a given run: reachable from some split's branch
 *     target and not yet re-established as always-firing by a re-convergence merge (a merge node and
 *     everything downstream of it is guaranteed again — exactly one branch always reaches the merge).
 *
 * Pure and deterministic — set iteration order does not affect membership, and callers sort before
 * emitting. */
export interface ExclusiveTopology {
  readonly mergeNodes: ReadonlySet<string>;
  readonly conditional: ReadonlySet<string>;
}

export function analyzeExclusiveTopology(
  nodeIds: readonly string[],
  forwardAdj: ReadonlyMap<string, readonly string[]>,
  splitNodes: ReadonlySet<string>,
): ExclusiveTopology {
  const reachFrom = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n === undefined || seen.has(n)) continue;
      seen.add(n);
      for (const next of forwardAdj.get(n) ?? []) if (!seen.has(next)) stack.push(next);
    }
    return seen;
  };

  const mergeNodes = new Set<string>();
  const splitDownstream = new Set<string>();
  for (const split of splitNodes) {
    const branchTargets = forwardAdj.get(split) ?? [];
    const reachCount = new Map<string, number>();
    for (const target of branchTargets) {
      const reach = reachFrom(target);
      for (const n of reach) {
        splitDownstream.add(n);
        reachCount.set(n, (reachCount.get(n) ?? 0) + 1);
      }
    }
    for (const [n, count] of reachCount) if (count >= 2) mergeNodes.add(n);
  }

  // A merge node (and everything reachable from it) is guaranteed to fire again — exactly one branch of
  // the split always reaches the merge — so it is NOT conditional even though it sits downstream of a
  // split. Subtract that closure from the raw split-downstream set.
  const guaranteedAgain = new Set<string>();
  for (const merge of mergeNodes) for (const n of reachFrom(merge)) guaranteedAgain.add(n);

  const conditional = new Set<string>();
  for (const n of splitDownstream) if (!guaranteedAgain.has(n)) conditional.add(n);

  // `nodeIds` participates only to keep the surface honest (every referenced node is known); the sets
  // above are already complete over the reachable graph.
  void nodeIds;
  return { mergeNodes, conditional };
}

/** Build the `nodeId → declared-fact-names` map for a graph that has ALREADY passed
 * {@link validateDeliveryGraph} (every id/emit is well-formed by then). This is the same map the
 * validator builds internally for edge resolution; exported so a downstream consumer (the S1
 * compiler) derives it from ONE canonical place rather than re-deriving — and thus resolves edge
 * `from` endpoints identically (no drift). Nodes without a valid string id, and duplicate ids, are
 * skipped exactly as the validator does (first id wins). */
export function deliveryNodeFacts(graph: DeliveryGraphLike): Map<string, Set<string>> {
  const nodeFacts = new Map<string, Set<string>>();
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  for (const rawNode of nodes) {
    if (!isRecord(rawNode)) continue;
    const id = rawNode.id;
    if (typeof id !== "string" || id.length === 0 || nodeFacts.has(id)) continue;
    const facts = new Set<string>();
    if (Array.isArray(rawNode.emits)) {
      for (const rawFact of rawNode.emits) {
        if (isRecord(rawFact) && typeof rawFact.name === "string" && rawFact.name.length > 0) {
          facts.add(rawFact.name);
        }
      }
    }
    nodeFacts.set(id, facts);
  }
  return nodeFacts;
}

/** The minimal read surface {@link deliveryNodeFacts} / {@link resolveDeliveryFrom} need — a graph
 * with a `nodes` array. Kept structural so both the untyped request body and the generated
 * `DeliveryGraph` type satisfy it. */
export interface DeliveryGraphLike {
  readonly nodes?: unknown;
}

/** Resolve an edge `from` endpoint (`<nodeId>` or `<nodeId>.<fact>`) against a graph's node/fact map,
 * for a graph that has ALREADY passed {@link validateDeliveryGraph} (so the reference is known
 * resolvable and unambiguous). Returns the upstream `nodeId` and, when the `from` was qualified, the
 * referenced `fact`. Shares the exact disambiguation rule the validator uses (a node id may contain
 * dots; a fact name cannot), so the compiler builds the SAME DAG the validator checked — no drift. */
export function resolveDeliveryFrom(
  from: string,
  nodeFacts: ReadonlyMap<string, ReadonlySet<string>>,
): { nodeId: string; fact?: string } {
  const { nodeId, fact } = resolveFrom(from, nodeFacts);
  return fact !== undefined ? { nodeId, fact } : { nodeId };
}

/** A DETERMINISTIC canonical JSON serialization: object keys sorted recursively while ARRAY order is
 * preserved (object key order and insignificant whitespace are not semantic). Two byte-different-but-
 * equivalent encodings (reordered keys, reflowed whitespace) serialize identically, while any genuine
 * value difference still diverges. Shared single source of truth (issue #778 review): the dispatch
 * run-key hashes it and the compiler's `payload` disambiguator canonicalises with it, so neither can
 * drift from the other. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}
