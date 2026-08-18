// nano-workforce — the durable contract registry (issue #227, ADR 0004).
//
// THE PROBLEM this exists to kill: parallel/sliced agent work keeps producing *two divergent
// representations of one contract* — an env-key synonym (the canonical `NANO_WORKFORCE_BASE_URL`
// vs. retired names like `NANO_PR_PUBLIC_BASE_URL`/`NANO_PR_BASE_URL`, #226/#223), a wire-shape
// drift (a producer emitting a legacy frame the hub no longer accepts, nano-ide #234), two type
// names for one shape — each authored independently against a mock, with the divergence only
// discovered at runtime.
//
// THE FIX: a first-class, *committed and executable* source of truth for every cross-cutting
// contract. Declare-once entries (env/config keys, wire-frame shapes, shared exported type/interface
// names, capability-URL schemes) with an owner + semantics per entry. Because the registry is code:
//   - env/config keys are parsed through ONE typed schema ({@link ENV_CONTRACTS} + {@link readEnv}),
//     so a duplicate or synonymous key is a compile/lint failure (`scripts/check-contracts.ts`),
//     never a silent runtime fallback — the #223 cascade cannot be reintroduced;
//   - a rejected synonym (an old name we deliberately retired) is recorded here, so its reappearance
//     in code is a hard CI failure, not a phantom fallback;
//   - the reconciliation pass (`app/contractReconcile.ts`) reads this registry alongside the whole
//     blackboard and flags synonyms / contradictions / mock-vs-real skew.
//
// The registry is the DURABLE truth; the blackboard `contract` kind (app/blackboard.ts) is the
// LIVE, in-flight signal ("I am introducing / consuming contract X") so siblings in a wave see a new
// contract *before* they independently invent a synonym. Neither alone suffices.

/** The kinds of cross-cutting contract the registry coordinates. */
export type ContractCategory = "env" | "wire" | "type" | "capability-url";

/** Fields shared by every contract entry: a stable name, an owning subsystem, and human semantics. */
interface ContractBase {
  /** The canonical name (env var, wire op/frame, exported type, or URL scheme id). */
  readonly name: string;
  /** The subsystem/module that owns this contract (where its canonical definition lives). */
  readonly owner: string;
  /** What the contract means — enough for a sibling to decide "is mine the same as this?". */
  readonly semantics: string;
}

/** An env/config key. Parsed through the one typed schema; `default` documents the fallback. */
export interface EnvContract extends ContractBase {
  readonly category: "env";
  /** The documented default when the key is unset/blank (omit for a required secret). */
  readonly default?: string;
  /** Names we DELIBERATELY retired for this value. Their reappearance in code is a CI failure — a
   * retired synonym must never come back as a silent fallback (the #223 failure mode). */
  readonly rejectedSynonyms?: readonly string[];
  /** True for a secret/credential whose value must never be logged or defaulted. */
  readonly secret?: boolean;
}

/** A wire-frame shape that crosses a process/transport boundary (e.g. a relay control frame). */
export interface WireContract extends ContractBase {
  readonly category: "wire";
  /** A concise, executable-where-possible description of the frame shape both sides must share. */
  readonly shape: string;
}

/** A shared exported type/interface name that more than one slice depends on. */
export interface TypeContract extends ContractBase {
  readonly category: "type";
  /** The module the canonical definition is exported from — the ONE import both sides must use. */
  readonly module: string;
}

/** A capability-URL scheme: how a token-scoped side-channel URL is assembled. */
export interface CapabilityUrlContract extends ContractBase {
  readonly category: "capability-url";
  /** The URL template (documented), e.g. `<base>/app/api/hooks/blackboard?token=<token>`. */
  readonly scheme: string;
}

export type Contract = EnvContract | WireContract | TypeContract | CapabilityUrlContract;

// ---------------------------------------------------------------------------------------------
// The one typed env schema. EVERY config-family env key MUST be declared here; the CI check
// (`scripts/check-contracts.ts`) fails the build if code reads a config key that is not declared,
// or reads a rejected synonym. This makes the schema the single source of truth for config keys.
// ---------------------------------------------------------------------------------------------

export const ENV_CONTRACTS = {
  NANO_WORKFORCE_BASE_URL: {
    category: "env",
    name: "NANO_WORKFORCE_BASE_URL",
    owner: "app/blackboard.ts",
    semantics:
      "Externally-reachable base URL agents use to reach this app (must resolve from wherever the agent runs). Drives every plan's blackboard capability URL.",
    default: "http://localhost:3000",
    // Retired synonyms, recorded so their reintroduction is a CI failure rather than a silent second
    // name for one value: `NANO_PR_PUBLIC_BASE_URL` was coalesced into this canonical name in #226;
    // `NANO_PR_BASE_URL` was a phantom fallback introduced in #53 (2dcfb8a) and cleaned up per #223.
    rejectedSynonyms: ["NANO_PR_PUBLIC_BASE_URL", "NANO_PR_BASE_URL"],
  },
  NANO_PR_POLL_MS: {
    category: "env",
    name: "NANO_PR_POLL_MS",
    owner: "main.ts",
    semantics: "Poller cadence in milliseconds for the self-scheduling reconciliation loop.",
    default: "60000",
  },
  NANO_PR_MAX_ROUNDS: {
    category: "env",
    name: "NANO_PR_MAX_ROUNDS",
    owner: "app/service.ts",
    semantics: "Maximum review rounds before a PR escalates.",
    default: "20",
  },
  NANO_PR_MAX_CI_FIX_ROUNDS: {
    category: "env",
    name: "NANO_PR_MAX_CI_FIX_ROUNDS",
    owner: "app/service.ts",
    semantics: "Maximum CI-fix attempts per PR.",
    default: "3",
  },
  NANO_PR_MAX_REBASE_ROUNDS: {
    category: "env",
    name: "NANO_PR_MAX_REBASE_ROUNDS",
    owner: "app/service.ts",
    semantics: "Maximum rebase attempts per PR.",
    default: "3",
  },
  NANO_PR_REVIEW_WAIT_TIMEOUT: {
    category: "env",
    name: "NANO_PR_REVIEW_WAIT_TIMEOUT",
    owner: "app/service.ts",
    semantics: "How long to wait for a review before nudging/escalating (FEEL/ISO-8601 duration).",
  },
  NANO_PR_REVIEW_NUDGE_MINUTES: {
    category: "env",
    name: "NANO_PR_REVIEW_NUDGE_MINUTES",
    owner: "app/service.ts",
    semantics: "Minutes between review nudges.",
  },
  NANO_PR_AUTO_MERGE: {
    category: "env",
    name: "NANO_PR_AUTO_MERGE",
    owner: "app/service.ts",
    semantics: "Whether the app auto-merges a converged PR (1/0).",
    default: "1",
  },
  NANO_PR_MERGE_METHOD: {
    category: "env",
    name: "NANO_PR_MERGE_METHOD",
    owner: "app/service.ts",
    semantics: "Merge method for auto-merge (squash|merge|rebase).",
    default: "squash",
  },
  NANO_PR_MERGE_ADMIN: {
    category: "env",
    name: "NANO_PR_MERGE_ADMIN",
    owner: "app/service.ts",
    semantics: "Whether to merge with admin override (1/0).",
    default: "0",
  },
  NANO_PR_GITHUB_TRANSPORT: {
    category: "env",
    name: "NANO_PR_GITHUB_TRANSPORT",
    owner: "app/github.ts",
    semantics: "GitHub transport selector (auto|cli|rest).",
    default: "auto",
  },
  NANO_PR_WEBHOOK_SECRET: {
    category: "env",
    name: "NANO_PR_WEBHOOK_SECRET",
    owner: "operations/*.ts (agentic HTTP hooks)",
    semantics:
      "Shared secret authenticating the agentic supply HTTP-hook operations (getAgenticSupply / getAgentInstructions / listActivePrs / getVersion / agentCompleteEscalation / revertEscalationCompletion). Also the fallback secret for NANO_AGENTIC_SECRET.",
    secret: true,
  },
  NANO_AGENTIC_SECRET: {
    category: "env",
    name: "NANO_AGENTIC_SECRET",
    owner: "main.ts",
    semantics:
      "Secret authenticating the agentic supply endpoint; falls back to NANO_PR_WEBHOOK_SECRET when unset.",
    secret: true,
  },
  NANO_AGENTIC: {
    category: "env",
    name: "NANO_AGENTIC",
    owner: "main.ts",
    semantics:
      "Feature flag for the agentic supply endpoint; a value of 0/off/false/no disables it (enabled when unset).",
  },
  NANO_WORKFORCE_GIT_SHA: {
    category: "env",
    name: "NANO_WORKFORCE_GIT_SHA",
    owner: "app/version.ts",
    semantics:
      "Explicit git SHA override for version reporting on deploys shipped without a .git directory; version derivation reads .git when unset.",
  },
  NANO_AUTO_RETRO: {
    category: "env",
    name: "NANO_AUTO_RETRO",
    owner: "app/retro.ts",
    semantics: "Opt-out toggle for the epic retrospective stage (0/false disables).",
    default: "1",
  },
  NANO_ESCALATION_SLA_TIMEOUT: {
    category: "env",
    name: "NANO_ESCALATION_SLA_TIMEOUT",
    owner: "app/plan.ts",
    semantics: "SLA timeout for an escalation user task (FEEL/ISO-8601 duration).",
  },
  NANO_PR_AGENT_SLA_TIMEOUT: {
    category: "env",
    name: "NANO_PR_AGENT_SLA_TIMEOUT",
    owner: "app/service.ts",
    semantics:
      "SLA timeout for an agent (service) task before its boundary timer fires and the PR escalates for human attention (ISO-8601 duration). A malformed value falls back to the default.",
    default: "PT2H",
  },
  NANO_READINESS_POLL_TIMEOUT: {
    category: "env",
    name: "NANO_READINESS_POLL_TIMEOUT",
    owner: "app/readiness.ts",
    semantics:
      "Default bounded timeout (FEEL/ISO-8601 duration) for a ReadinessProbe wait-gate when the probe descriptor declares no poll.timeoutMs. The gate's event-based-gateway timer arm fires after it and escalates, so a probe that never goes green can never wedge a plan. A malformed value falls back to the default.",
    default: "PT30M",
  },
  NANO_READINESS_POLL_EVERY_MS: {
    category: "env",
    name: "NANO_READINESS_POLL_EVERY_MS",
    owner: "workers/readiness-probe/worker.ts",
    semantics:
      "Default interval in milliseconds between ReadinessProbe attempts when the probe descriptor declares no poll.everyMs.",
    default: "15000",
  },
  NANO_APP_DB_URL: {
    category: "env",
    name: "NANO_APP_DB_URL",
    owner: "nano.app.json / DataLayer",
    semantics: "Connection URL for the app SQLite DataLayer.",
  },
  NANOBPMN_BASE_URL: {
    category: "env",
    name: "NANOBPMN_BASE_URL",
    owner: "app/agentGuide.ts",
    semantics: "Base URL of the nanobpmn engine REST API (used to derive CAMUNDA_REST_ADDRESS).",
    default: "http://localhost:8080",
  },
  PR_REVIEW_PORT: {
    category: "env",
    name: "PR_REVIEW_PORT",
    owner: "main.ts",
    semantics: "TCP port the app HTTP server binds.",
    default: "3000",
  },
  GITHUB_TOKEN: {
    category: "env",
    name: "GITHUB_TOKEN",
    owner: "app/github.ts",
    semantics: "GitHub API credential the app uses for all GitHub calls.",
    secret: true,
  },
  CAMUNDA_REST_ADDRESS: {
    category: "env",
    name: "CAMUNDA_REST_ADDRESS",
    owner: "app/agentGuide.ts",
    semantics: "Explicit REST address of the engine (overrides NANOBPMN_BASE_URL derivation).",
  },
  CAMUNDA_TOKEN: {
    category: "env",
    name: "CAMUNDA_TOKEN",
    owner: "app/agentGuide.ts",
    semantics: "Bearer token for the engine REST API.",
    secret: true,
  },
  CAMUNDA_TRANSPORT: {
    category: "env",
    name: "CAMUNDA_TRANSPORT",
    owner: "app/agentGuide.ts",
    semantics: "Engine transport selector.",
  },
} as const satisfies Record<string, EnvContract>;

/** The set of declared config-key names — the single typed vocabulary of env keys. */
export type EnvKey = keyof typeof ENV_CONTRACTS;

/** Whether `name` is a declared {@link EnvKey}. A runtime-narrowing guard so a value carried in as
 * a plain string (e.g. a probe descriptor's `credentialEnv`) can be validated against the ONE
 * schema before it is read through {@link readEnv} — an undeclared key is rejected, never read. */
export function isEnvKey(name: string): name is EnvKey {
  return Object.hasOwn(ENV_CONTRACTS, name);
}

/** Every declared env contract, widened to {@link EnvContract} (assignment-widening — no `as`), so
 * callers can read the optional `default`/`rejectedSynonyms`/`secret` fields on any entry. */
export function envContracts(): EnvContract[] {
  const list: EnvContract[] = Object.values(ENV_CONTRACTS);
  return list;
}

/** The declared entry for a key, widened to {@link EnvContract} so callers can read `default`/
 * `rejectedSynonyms` (the `as const satisfies` above keeps each entry's narrow literal type, on
 * which those optional fields don't exist for every member). Assignment-widening — no `as` cast. */
export function envContract(key: EnvKey): EnvContract {
  const entry: EnvContract = ENV_CONTRACTS[key];
  return entry;
}

/** Read a declared env key through the one schema. `key` is a compile-time-checked {@link EnvKey},
 * so a typo or a synonymous key (e.g. the retired `NANO_PR_BASE_URL`) is a TYPE error here — it can
 * never resolve to a silent runtime fallback. Returns the trimmed value, or `undefined` when unset
 * or blank/whitespace (so an explicitly-empty key never yields a malformed value). */
export function readEnv(
  key: EnvKey,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const trimmed = env[key]?.trim();
  return trimmed ? trimmed : undefined;
}

/** Read a declared env key, falling back to its registered `default` (then to `fallback`) when
 * unset/blank. Keeps the default in ONE place — the registry entry — not scattered at call sites. */
export function readEnvOr(
  key: EnvKey,
  fallback = "",
  env: Record<string, string | undefined> = process.env,
): string {
  return readEnv(key, env) ?? envContract(key).default ?? fallback;
}

// ---------------------------------------------------------------------------------------------
// The non-env contracts. These are the shared shapes/types/schemes that parallel slices must
// converge on. Kept alongside the env schema so ONE registry answers "does a contract for X
// already exist?" for every category.
// ---------------------------------------------------------------------------------------------

export const WIRE_CONTRACTS = {
  "relay.produce": {
    category: "wire",
    name: "relay.produce",
    owner: "@nanobpm/agentic/relay",
    semantics:
      "Op-tagged relay control frame a worker terminal chunk producer emits and the hub consumes. The op-tagged shape superseded the legacy positional `{stream, offset, chunk}` frame (nano-ide #234/#236); a producer must emit the op-tagged shape or the hub rejects it as `malformed relay message payload`.",
    shape: '{ op: "produce", incarnation: number, stream: string, offset: number, chunk: string }',
  },
  "io.nanobpm.agentTask.repository": {
    category: "wire",
    name: "io.nanobpm.agentTask.repository",
    owner: "app/service.ts",
    semantics:
      "Repo-provisioning envelope the app emits as a `createInstance` process variable (`repoEnvelopeVars`) and the c8ctl worker harness consumes to provision an isolated clone on the PR head branch. Beyond `{provider,url,ref}`, it carries clone-shaping fields for large monorepos (issue #287): `singleBranch:true` + `filter:\"blob:none\"` (a branch-scoped, blobless partial clone — trees fetched up-front, blobs lazily, no `--depth 1` so the merge-base/3-dot diff stays valid) and an optional `baseRef` (the PR base branch, emitted only when resolvable, so the harness fetches its tip and keeps `origin/<base>` reachable). Gated on c8ctl provisioner support (jwulf/c8ctl-plugin-nano#91).",
    shape:
      '{ provider: "github", url: string, ref: string, singleBranch: true, filter: "blob:none", baseRef?: string }',
  },
} as const satisfies Record<string, WireContract>;

export const TYPE_CONTRACTS = {
  BlackboardEntry: {
    category: "type",
    name: "BlackboardEntry",
    owner: "app/blackboard.ts",
    semantics:
      "The snake_case, agent-facing view of a blackboard entry — the HTTP-hook boundary shape every caller and agent consumes. Both the read and write halves import this ONE definition.",
    module: "app/blackboard.ts",
  },
  PlanDep: {
    category: "type",
    name: "PlanDep",
    owner: "app/plan.ts",
    semantics:
      "One INTER-epic dependency edge (issue #292): dependent epic `plan_key` waits for producer epic `depends_on_plan_key`, gated by the producer's `{ package, capability_ref }` capability descriptor. Set admission (S2), planner lowering (S3), and operator visibility (S4) all import this ONE row shape from app/plan.ts — no re-declared synonym.",
    module: "app/plan.ts",
  },
} as const satisfies Record<string, TypeContract>;

export const CAPABILITY_URL_CONTRACTS = {
  blackboard: {
    category: "capability-url",
    name: "blackboard",
    owner: "app/blackboard.ts",
    semantics:
      "Per-plan blackboard side-channel. The per-plan token IS the credential; it rides the query string so the agent GET/POSTs the exact string it was handed with no header assembly. The base is `NANO_WORKFORCE_BASE_URL` (one env contract), never hardcoded.",
    scheme: "<NANO_WORKFORCE_BASE_URL>/app/api/hooks/blackboard?token=<token>",
  },
} as const satisfies Record<string, CapabilityUrlContract>;

/** Every contract, across all categories — the flat list the reconciliation pass and CI check walk. */
export function allContracts(): Contract[] {
  return [
    ...Object.values(ENV_CONTRACTS),
    ...Object.values(WIRE_CONTRACTS),
    ...Object.values(TYPE_CONTRACTS),
    ...Object.values(CAPABILITY_URL_CONTRACTS),
  ];
}

/** All names deliberately retired as synonyms of a live env contract, mapped to the canonical name
 * that replaced them. A read of any synonym is a CI failure — the #223 phantom-fallback failure
 * mode, guarded categorically. */
export function rejectedEnvSynonyms(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of envContracts()) {
    for (const syn of c.rejectedSynonyms ?? []) out.set(syn, c.name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Near-duplicate DECLARATION detection — the write-time / declare-time guard. Given a proposed new
// contract, is there an EXISTING one that is the same thing under a different name (a synonym), or a
// contradicting one (same name, different semantics/owner)? Surfaced to the writer so a duplicate is
// caught at authoring time, not at runtime.
// ---------------------------------------------------------------------------------------------

/** A near-duplicate finding between a proposed declaration and an existing registry contract. */
export interface DeclarationConflict {
  /** `synonym`: same category + equivalent semantics under a different name (two names, one thing).
   *  `contradiction`: same name but different semantics/owner (one name, two meanings).
   *  `rejected-synonym`: the proposed name is a retired synonym of a live env contract. */
  readonly kind: "synonym" | "contradiction" | "rejected-synonym";
  readonly proposedName: string;
  readonly existingName: string;
  readonly detail: string;
}

/** Normalise free-text semantics to a comparable token bag: lowercased, punctuation stripped,
 * short stopwords dropped. Deliberately crude — it only needs to catch "two names for one value". */
function semanticTokens(text: string): Set<string> {
  const STOP = new Set([
    "the", "a", "an", "of", "to", "for", "and", "or", "is", "it", "this", "that", "with",
    "on", "in", "at", "by", "as", "per", "its", "so", "one", "value", "used", "use",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Jaccard overlap of two token bags (0..1). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The semantics-overlap threshold above which two DIFFERENTLY-named contracts of the same category
 * are flagged as probable synonyms. Tuned to be advisory (surface for a human/agent decision), not a
 * hard gate. */
export const SYNONYM_THRESHOLD = 0.6;

/** Detect near-duplicate declarations of `proposed` against `existing` (defaults to the registry).
 * Returns every conflict found so a writer sees synonyms AND contradictions AND rejected synonyms. */
export function detectDeclarationConflicts(
  proposed: { category: ContractCategory; name: string; semantics: string },
  existing: Contract[] = allContracts(),
): DeclarationConflict[] {
  const out: DeclarationConflict[] = [];
  const rejected = rejectedEnvSynonyms();
  if (proposed.category === "env" && rejected.has(proposed.name)) {
    out.push({
      kind: "rejected-synonym",
      proposedName: proposed.name,
      existingName: rejected.get(proposed.name) ?? "",
      detail: `'${proposed.name}' is a retired synonym of '${rejected.get(proposed.name)}'; reuse the canonical key, do not reintroduce the fallback.`,
    });
  }
  const proposedTokens = semanticTokens(proposed.semantics);
  for (const c of existing) {
    if (c.name === proposed.name) {
      if (c.category === proposed.category && overlap(proposedTokens, semanticTokens(c.semantics)) < SYNONYM_THRESHOLD) {
        out.push({
          kind: "contradiction",
          proposedName: proposed.name,
          existingName: c.name,
          detail: `'${proposed.name}' already exists (owner ${c.owner}) with different semantics; reconcile before redeclaring.`,
        });
      }
      continue;
    }
    if (c.category !== proposed.category) continue;
    if (overlap(proposedTokens, semanticTokens(c.semantics)) >= SYNONYM_THRESHOLD) {
      out.push({
        kind: "synonym",
        proposedName: proposed.name,
        existingName: c.name,
        detail: `'${proposed.name}' looks semantically equivalent to existing '${c.name}' (owner ${c.owner}); reuse it instead of authoring a synonym.`,
      });
    }
  }
  return out;
}
