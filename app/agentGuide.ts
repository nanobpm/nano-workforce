// The agent operator guide served by GET /app/api/agent (operationId `getAgentInstructions`).
//
// The guide itself is authored as plain markdown in `docs/agent-guide.md` (kept OUT of
// `resources/` so the deploy-by-convention walk does NOT treat it as a deployable model — docs
// live under `docs/`, ADR 0062) and read from the checkout at
// module load — same "run the .ts sources directly, inspect the working tree at runtime" approach
// as version.ts. Two placeholders are substituted per request/deployment so the embedded examples
// are copy-pasteable against THIS instance:
//   • __BASE__   → the app control-API base the caller reached us on (e.g. https://host/app/api)
//   • __ENGINE__ → the engine's Camunda-8 v2 REST base this app is configured to talk to
//
// Reading is best-effort: a missing file yields a short built-in fallback rather than throwing, so
// the endpoint never 500s just because the doc is absent from a stripped-down deploy.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUIDE_PATH = join(REPO_ROOT, "docs", "agent-guide.md");

// Read the raw guide once, at module load. Frozen for the life of the process.
const RAW_GUIDE: string = (() => {
  try {
    return readFileSync(GUIDE_PATH, "utf8");
  } catch {
    return [
      "# Nano Workforce — agent operator guide",
      "",
      "The full guide document could not be read from this deployment.",
      "",
      "Key endpoints (under the app control-API base `__BASE__`):",
      "- `GET /status` — every PR in flight, with its engine `processKey` and any open escalation.",
      "- `GET /version` — which code is live.",
      "- `POST /actions/start/convergence-loop` — submit a PR (`{ pr, convergeOnly?, maxRounds?, dependsOn? }`).",
      "- `POST /actions/start/plan-fanout` — submit an epic (`{ issue, baseBranch }` or `{ url, baseBranch }`; base is required — a missing `epic/*` base is auto-created, and `confirmDefaultBase`/`allowSharedBase` gate the default-branch and shared-base cases — see ADR 0003).",
      "- `POST /actions/complete-user-task` — answer an escalation (`{ userTaskKey, variables }`); the parked user task's key comes from `GET /status`/the Tasks inbox, and the typed variables match its `.form` (e.g. a PR escalation's `{ answer }`).",
      "- `POST /actions/message` — publish a BPMN message (optionally correlated) into the engine.",
      "",
      "Engine (Camunda-8 v2 REST) base for debugging: `__ENGINE__`.",
      "Source repository: `nanobpm/nano-workforce`.",
      "",
    ].join("\n");
  }
})();

/**
 * The engine's Camunda-8 v2 REST base this app talks to, resolved exactly as `main.ts` does:
 * an explicit `CAMUNDA_REST_ADDRESS` wins, else `${NANOBPMN_BASE_URL}/v2` (default localhost:8080).
 * Trailing slashes are trimmed so the guide's `__ENGINE__/jobs/search` examples are well-formed.
 */
export function resolveEngineBase(): string {
  const explicit = process.env.CAMUNDA_REST_ADDRESS;
  const base = explicit?.trim()
    ? explicit.trim()
    : `${(process.env.NANOBPMN_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "")}/v2`;
  return base.replace(/\/+$/, "");
}

/**
 * Render the guide for a given app control-API base (e.g. "https://host/app/api"). The engine base
 * is resolved from the environment. Substitutes every `__BASE__`/`__ENGINE__` occurrence.
 *
 * This is the FULL guide, byte-for-byte the same content the non-MCP fallback doors serve
 * (`GET /app/api/agent`, and — via the skill — `GET /app/api/agent/skill`). The addressable helpers
 * below (`guideToc` / `renderGuideSection`) never touch this path, so those doors stay unchanged.
 */
export function renderAgentGuide(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return RAW_GUIDE.replaceAll("__BASE__", base).replaceAll("__ENGINE__", resolveEngineBase());
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Addressable guide (epic nano-workforce#605, slice S5, issue #611).
//
// The full guide is ~43KB — a single `getAgentInstructions` call can exceed an agent's tool-result
// limit, forcing it to persist the blob and carve out the section it wanted out-of-band. The guide
// is already well-structured as top-level `## N. Title` sections, so we make each one individually
// addressable: a compact table of contents (id + one-line summary), and per-section retrieval.
//
// STABLE IDS ARE THE CONTRACT. `GUIDE_SECTIONS` below is the single source of truth for the stable
// section ids and their summaries, in document order. The section *bodies* are derived by parsing
// the authored markdown (`docs/agent-guide.md`) at module load — never duplicated here — so prose
// edits never drift from the addressable surface. The parity is guarded by a drift test
// (`app/agentGuide.test.ts`): add or remove a `## ` section in the doc without updating this
// registry and the build fails.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One addressable top-level guide section: a stable id and a one-line summary, in document order.
 *  The `id` is the durable handle agents pass to `getAgentGuide(section)`; keep it stable across
 *  prose edits (rename the heading freely, never the id). */
export interface GuideSectionMeta {
  readonly id: string;
  readonly summary: string;
}

/** The stable section registry — ONE per `## N.` heading in `docs/agent-guide.md`, in order. Adding
 *  a section to the doc requires adding an entry here (enforced by the drift test). */
export const GUIDE_SECTIONS: readonly GuideSectionMeta[] = [
  { id: "orient", summary: "Orient first: confirm which instance you're driving; see the live version and every PR in flight." },
  { id: "submit-pr", summary: "Submit a PR to the review-convergence loop — review-only vs. converge-and-merge, dependency barriers, round caps." },
  { id: "submit-epic", summary: "Hand a whole issue to the fleet: plan → implement → converge across coding agents, against a required base branch." },
  { id: "escalations", summary: "Find and answer parked human-in-the-loop escalations (PR-review, feature, plan-review, trial-merge) by user-task key." },
  { id: "lifecycle", summary: "The PR/epic lifecycle and status vocabulary, so you can reason about where a run currently sits." },
  { id: "debug", summary: "Debug: find the engine process instance behind a PR and inspect its jobs, incidents, and element-instances." },
  { id: "debug-models", summary: "Debug the deployed BPMN models and the agent prompts a running instance is actually using." },
  { id: "unstick", summary: "Unstick a wedged process — publish a correlating message, cancel, or otherwise recover a stalled instance." },
  { id: "raise-issue", summary: "Raise an issue or open a PR against the nano-workforce repository itself." },
  { id: "delivery-graphs", summary: "Author, preview, compile/stage and run an agent-authored delivery graph (ADR 0005): node/wait/connector vocabulary." },
  { id: "tool-crosswalk", summary: "Tool↔curl crosswalk: map every guide action to its projected MCP tool (status, version, urban_debug_* engine reads, escalation answer, cancel) with the curl no-MCP fallback." },
] as const;

/** A parsed section: its stable id + summary (from the registry), the derived heading `title` (the
 *  markdown text after `## `, e.g. "9. Author and run a delivery graph (ADR 0005)"), and the raw
 *  section markdown `body` INCLUDING the heading line, with `__BASE__`/`__ENGINE__` un-substituted. */
export interface ParsedGuideSection extends GuideSectionMeta {
  readonly title: string;
  readonly body: string;
}

/** Split raw guide markdown into its top-level `## ` sections, fence-aware (a `## ` inside a fenced
 *  code block is content, not a heading). Everything before the first heading is the preamble.
 *  Pure/​testable — takes the raw text so the drift test can feed it the on-disk doc directly. */
export function splitGuideSections(raw: string): { preamble: string; sections: { title: string; body: string }[] } {
  const lines = raw.split("\n");
  const sections: { title: string; lines: string[] }[] = [];
  const preambleLines: string[] = [];
  let inFence = false;
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const heading = !inFence ? /^## (.+)$/.exec(line) : null;
    if (heading) {
      current = { title: heading[1].trim(), lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  return {
    preamble: preambleLines.join("\n"),
    sections: sections.map((s) => ({ title: s.title, body: s.lines.join("\n").replace(/\s+$/, "") })),
  };
}

/** The parsed sections of THIS deployment's guide, zipped against the stable registry, computed once
 *  at module load. When the doc is unreadable (fallback guide, no `## ` headings) this is empty — the
 *  addressable surface degrades to "no sections", never throws. Length/registry parity is asserted by
 *  the drift test, not at runtime, so a mismatched deploy still serves what it can. */
const PARSED_SECTIONS: readonly ParsedGuideSection[] = (() => {
  const { sections } = splitGuideSections(RAW_GUIDE);
  const n = Math.min(sections.length, GUIDE_SECTIONS.length);
  const out: ParsedGuideSection[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ ...GUIDE_SECTIONS[i], title: sections[i].title, body: sections[i].body });
  }
  return out;
})();

/** The compact table of contents: every addressable section's id, derived heading title, and stable
 *  one-line summary, in document order. Small by construction — safe to return whole under any
 *  tool-result limit. Titles reflect THIS deployment's doc; summaries come from the registry. */
export function guideToc(): { id: string; title: string; summary: string }[] {
  return PARSED_SECTIONS.map((s) => ({ id: s.id, title: s.title, summary: s.summary }));
}

/** Render a SINGLE section's markdown for a given app control-API base, `__BASE__`/`__ENGINE__`
 *  substituted exactly as {@link renderAgentGuide} does for the whole guide. Returns `undefined` for
 *  an unknown id (the caller turns that into a 400 listing the valid ids). */
export function renderGuideSection(id: string, apiBase: string): string | undefined {
  const section = PARSED_SECTIONS.find((s) => s.id === id);
  if (!section) return undefined;
  const base = apiBase.replace(/\/+$/, "");
  return section.body.replaceAll("__BASE__", base).replaceAll("__ENGINE__", resolveEngineBase());
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paginated section retrieval (issue #740).
//
// The addressable guide exists to avoid the ~43KB monolith, but a single section can ITSELF overflow
// a typical MCP tool-result limit — `delivery-graphs` alone renders to ~25KB, the one section an
// author most needs. So a section is additionally retrievable in BOUNDED CHUNKS via a `start`/`length`
// window with a `nextStart` continuation cursor. Offsets are UNICODE CHARACTER (code-point) offsets —
// NOT raw byte offsets — so a chunk boundary never splits a multi-byte character (the arrows/emoji in
// the guide) into mojibake. A plain `renderGuideSection` (no window) is untouched, so existing
// `section=<id>` calls that already fit stay byte-for-byte identical.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The default window size (characters) when a caller engages pagination without an explicit
 *  `length` — comfortably under a typical MCP tool-result limit so a single page never overflows. */
export const GUIDE_SECTION_PAGE_DEFAULT = 12_000;

/** One page of a section's markdown: the `instructions` slice plus the cursor state so a caller can
 *  page through with `nextStart` until it is `null`. Offsets/lengths are CHARACTER counts. */
export interface GuideSectionChunk {
  readonly instructions: string;
  /** The (clamped) character offset this page starts at. */
  readonly start: number;
  /** The number of characters actually returned in this page. */
  readonly length: number;
  /** The total number of characters in the fully-rendered section. */
  readonly totalLength: number;
  /** The character offset to pass as `start` for the next page, or `null` when this is the last page. */
  readonly nextStart: number | null;
}

/** Render a bounded WINDOW of a single section's markdown for a given app control-API base, with
 *  `__BASE__`/`__ENGINE__` substituted exactly as {@link renderGuideSection} does. `start` and
 *  `length` are CHARACTER offsets (clamped to the section bounds; a non-positive `length` yields an
 *  empty page). Returns `undefined` for an unknown id (the caller turns that into a 400). */
export function renderGuideSectionChunk(
  id: string,
  apiBase: string,
  start: number,
  length: number,
): GuideSectionChunk | undefined {
  const full = renderGuideSection(id, apiBase);
  if (full === undefined) return undefined;
  const chars = Array.from(full);
  const total = chars.length;
  const from = Math.min(Math.max(0, Math.trunc(start)), total);
  const take = Math.max(0, Math.trunc(length));
  const slice = chars.slice(from, from + take);
  const end = from + slice.length;
  return {
    instructions: slice.join(""),
    start: from,
    length: slice.length,
    totalLength: total,
    // Only advance when this page actually consumed characters. A zero-length window (`length <= 0`)
    // returns an empty page that made NO progress, so it must terminate the cursor (`null`) rather
    // than hand back a `nextStart` equal to `start` — a non-advancing cursor would loop a caller
    // that pages until `nextStart` is null forever.
    nextStart: slice.length > 0 && end < total ? end : null,
  };
}
