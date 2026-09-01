// Base-branch name validation — the canonical, side-effect-free gate shared by every door that
// accepts a caller-supplied branch name (the epic launch doors via `app/plan.ts`, and the
// operator delivery-graph dispatch door in `operations/dispatchDeliveryGraph.ts`).
//
// This is a deliberate LEAF module: it imports nothing and runs no top-level initialization, so an
// API door can pull in the validator without dragging in `app/plan.ts`'s substantial transitive
// imports and its import-time env seeding (`ESCALATION_SLA_TIMEOUT`/`CAPS_WAIT_TIMEOUT`). `plan.ts`
// re-exports these symbols, so existing importers are unaffected — this is derivation over
// duplication (one implementation), just hoisted below the heavy module.

/** Raised when a caller supplies a `baseBranch` that isn't a plausible git branch name. The
 * value is interpolated into the authoritative implementer prompt (which carries `git`/`gh`
 * shell snippets and inline-code Markdown), so a non-ref value could break the rendered
 * instructions or smuggle in a command/prompt fragment — reject it at the edge instead. */
export class InvalidBaseBranchError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`invalid base branch name: ${JSON.stringify(value)}`);
    this.name = "InvalidBaseBranchError";
    this.value = value;
  }
}

/** Raised when a caller supplies a blank/absent `baseBranch`. Every epic launch must name its base
 * branch explicitly (ADR 0003): "land on the default branch" is a conscious, named, confirmed choice
 * (the confirm-default gate), never a silent fallback. The operation edge maps this to a 400. */
export class MissingBaseBranchError extends Error {
  constructor() {
    super("base branch is required (blank/absent base branches are rejected)");
    this.name = "MissingBaseBranchError";
  }
}

/** Conservative allowlist gate for a base-branch name. Stricter than `git check-ref-format` on
 * purpose: only `[A-Za-z0-9._/-]`, no leading `/`/`.`/`-` (a leading dash reads as a CLI flag),
 * no trailing `/`/`.`, no `..`/`//`, no empty or `.lock`-suffixed path component, bounded length.
 * This rejects whitespace, shell metacharacters, command substitution, and newlines outright. */
export function isPlausibleBranchName(s: string): boolean {
  if (s.length === 0 || s.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return false;
  if (/^[/.-]/.test(s) || /[/.]$/.test(s)) return false;
  if (s.includes("..") || s.includes("//")) return false;
  return s.split("/").every((seg) => seg.length > 0 && !seg.startsWith(".") && !seg.endsWith(".lock"));
}

/** Normalise a caller-supplied base branch: trim, then require it. A blank/absent value is rejected
 * (`MissingBaseBranchError`) — ADR 0003 removed the implicit default-branch fallback, so every epic
 * launch must name its base explicitly. A non-blank value that is not a plausible git branch name is
 * rejected (`InvalidBaseBranchError`) rather than persisted or rendered into the agent prompt. The
 * operation edge maps both to a 400. Always returns a non-null branch on success. */
export function normalizeBaseBranch(input: string | null | undefined): string {
  const s = (input ?? "").trim();
  if (s.length === 0) throw new MissingBaseBranchError();
  if (!isPlausibleBranchName(s)) throw new InvalidBaseBranchError(s);
  return s;
}
