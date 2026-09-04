// app/deliveryGraphProposals.ts — the `staged` delivery-graph proposal AGGREGATE (ADR 0005 Decision 7,
// issue #460). The seam that makes dispatch OPERATOR-ONLY: the agent-facing compile door persists a
// valid compiled graph HERE as a `staged` proposal and hands the agent only a preview + a navigational
// `reviewUrl`. There is no run key, token, or dispatch handle in that response — nothing the agent can
// replay to start a run. A human previews the staged proposal in the cockpit and dispatches it.
//
// This dissolves the self-approval hole the old `approvalToken` left open: the token was a REPLAYABLE
// content digest returned to the same caller, so any holder of the API credential self-approved. By
// removing the dispatch affordance from the agent surface entirely (capability by absence, not by an
// auth check), there is nothing to replay — the boundary becomes self-documenting.
//
// The pure helpers (`proposalLogicalKey`, `proposalExpiry`, `isProposalExpired`, `buildProposalPreview`,
// `buildProposalRow`) are DB-free so they unit-test in isolation; `stageProposal` / `getStagedProposal`
// supply the I/O and the supersede-by-logical-key + TTL semantics.

import type { DataLayer } from "@nanobpm/urban";
import type {
  CompileDeliveryGraphResult,
  DeliveryHumanStop,
  DeliverySideEffect,
} from "../nano-generated/api-io.d.ts";
import { publicBaseUrl } from "./blackboard.ts";

const now = () => new Date().toISOString();

/** The staged-proposal TTL (24h). A staged proposal an operator never dispatches ages out of the
 * cockpit list at `created_at + TTL`, so the surface only ever shows live, dispatchable proposals. */
export const DELIVERY_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The NAVIGATIONAL cockpit deep-link to a staged proposal — a pointer the agent can hand the human,
 * NOT a dispatch handle. Points at the Delivery Graphs cockpit page (where the staged-proposals grid
 * lives), fragment-scoped to the proposal's digest so the operator can find it. */
export function proposalReviewUrl(digest: string, base: string = publicBaseUrl()): string {
  return `${base}/app/pages/delivery-graphs#proposal-${encodeURIComponent(digest)}`;
}

/** The proposal lifecycle. `staged` = awaiting operator review/dispatch; `superseded` = replaced by a
 * newer digest for the same logical graph; `dispatched` = the operator launched it; `expired` = it aged
 * out of its TTL before an operator dispatched it; `dismissed` = an operator explicitly discarded it as
 * noise. `superseded`/`dispatched`/`expired`/`dismissed` all drop out of the cockpit's staged list
 * (which filters to `status = 'staged'`). */
export const DELIVERY_PROPOSAL_STATUSES = ["staged", "superseded", "dispatched", "expired", "dismissed"] as const;
export type DeliveryProposalStatus = typeof DELIVERY_PROPOSAL_STATUSES[number];

/** One staged delivery-graph proposal — the durable row keyed by content `digest`. `side_effecting`
 * is a SQLite boolean (0/1); `graph`/`preview` are JSON text columns. */
export interface DeliveryGraphProposal {
  digest: string;
  logical_key: string;
  title: string | null;
  /** The original `DeliveryGraph` JSON — retained so the cockpit dispatch action can run the previewed
   * digest without the agent re-submitting anything. */
  graph: string;
  /** The rendered preview JSON (`{ diagram, sideEffects, humanNodes }`), stamped at stage time so the
   * cockpit list renders without recompiling. */
  preview: string;
  node_count: number;
  human_node_count: number;
  side_effect_count: number;
  side_effecting: number;
  status: DeliveryProposalStatus;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** The rendered preview a staged proposal carries — the operator-facing view of WHAT the graph does
 * (its diagram, the side effects a dispatch authorises, and where it parks on a person). It carries no
 * dispatch handle by construction. */
export interface DeliveryProposalPreview {
  diagram: string;
  sideEffects: DeliverySideEffect[];
  humanNodes: DeliveryHumanStop[];
}

/** The `delivery_graph_proposals` aggregate accessor — the durable staged-proposal store keyed by
 * content `digest`. */
export const deliveryGraphProposals = (data: DataLayer) =>
  data.table<DeliveryGraphProposal>("delivery_graph_proposals", "digest");

/** The LOGICAL graph identity used to supersede: the graph's `name` (trimmed, when non-blank), else
 * the content `digest`. A re-compile of a CHANGED graph (new digest) with the SAME name replaces the
 * prior staged proposal; an unnamed graph is its own logical key (it supersedes only an identical
 * recompile of itself). */
export function proposalLogicalKey(name: string | undefined | null, digest: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed || digest;
}

/** The TTL horizon for a proposal staged at `createdAt` — `createdAt + DELIVERY_PROPOSAL_TTL_MS`. */
export function proposalExpiry(createdAtIso: string): string {
  const created = Date.parse(createdAtIso);
  const base = Number.isNaN(created) ? Date.now() : created;
  return new Date(base + DELIVERY_PROPOSAL_TTL_MS).toISOString();
}

/** Whether a staged proposal has aged out (its `expires_at` is at or before `at`). A corrupt/blank
 * `expires_at` is treated as expired so a bad row can never linger undismissable in the cockpit. */
export function isProposalExpired(expiresAtIso: string | null | undefined, at: Date = new Date()): boolean {
  if (typeof expiresAtIso !== "string" || expiresAtIso.trim() === "") return true;
  const expires = Date.parse(expiresAtIso);
  if (Number.isNaN(expires)) return true;
  return expires <= at.getTime();
}

/** Extract the operator-facing preview from a successful compile — the diagram, the side effects a
 * dispatch authorises, and the human stop-points. No BPMN, no digest handle beyond the content
 * address; a preview, not a dispatch affordance. Accepts either the full compile result or the
 * layout-free {@link compileDeliveryGraphSemantic} result — the preview reads only `diagram`,
 * `sideEffects`, and `humanNodes`, none of which need the laid-out `bpmn` (issue #716). */
export function buildProposalPreview(
  compiled: Pick<CompileDeliveryGraphResult, "diagram" | "humanNodes" | "sideEffects">,
): DeliveryProposalPreview {
  return {
    diagram: compiled.diagram,
    sideEffects: compiled.sideEffects,
    humanNodes: compiled.humanNodes,
  };
}

/** Build the durable proposal row for a compiled graph at stage time. `graph` is the original
 * `DeliveryGraph` JSON (serialised) the cockpit dispatch action re-runs; `createdAt` is preserved
 * across an idempotent re-stage of a still-live proposal so the TTL stays anchored to the first stage
 * (omit it — defaulting to now — to re-anchor the TTL when re-staging an already-expired digest). */
export function buildProposalRow(input: {
  digest: string;
  logicalKey: string;
  title: string | null;
  graphJson: string;
  preview: DeliveryProposalPreview;
  nodeCount: number;
  humanNodeCount: number;
  sideEffectCount: number;
  sideEffecting: boolean;
  createdAt?: string;
}): DeliveryGraphProposal {
  const at = now();
  const createdAt = input.createdAt ?? at;
  return {
    digest: input.digest,
    logical_key: input.logicalKey,
    title: input.title,
    graph: input.graphJson,
    preview: JSON.stringify(input.preview),
    node_count: input.nodeCount,
    human_node_count: input.humanNodeCount,
    side_effect_count: input.sideEffectCount,
    side_effecting: input.sideEffecting ? 1 : 0,
    status: "staged",
    created_at: createdAt,
    updated_at: at,
    expires_at: proposalExpiry(createdAt),
  };
}

/** The outcome of a {@link stageProposal} — the written row PLUS a supersede/sibling summary the stage
 * doors surface so an agent can warn the operator precisely about what its stage did to the cockpit's
 * Delivery Graphs list (issue #740). Supersede keys on the LOGICAL graph key (derived from the graph
 * `name`), so re-staging the "same" runbook under a CHANGED `name` creates a sibling with a different
 * logical key that is NOT superseded — a silent footgun. Making the collision VISIBLE here (rather than
 * silent) lets the agent tell the operator exactly which digests it retired and how many other live
 * proposals remain (potential orphaned siblings). */
export interface StageOutcome {
  /** The row this stage wrote (the freshly-staged proposal). */
  row: DeliveryGraphProposal;
  /** Digests of OTHER proposals sharing this row's logical key that this stage flipped to
   * `superseded` — the same-logical-graph proposals it cleanly replaced. Empty on a first stage. */
  superseded: string[];
  /** How many OTHER live `staged` proposals remain after this stage (a DIFFERENT logical key from this
   * row) — i.e. proposals this stage did NOT supersede. A non-zero count flags possible orphaned
   * siblings (e.g. an earlier stage of the same runbook under a different `name`) cluttering the
   * operator's list, so the agent can name them for cleanup. */
  siblingsStaged: number;
}

/** Persist a compiled graph as a `staged` proposal and SUPERSEDE any prior staged proposal for the
* same logical graph. Idempotent on `digest` (a re-stage of an identical, still-live digest refreshes
* `updated_at` but preserves `created_at`, so the TTL stays anchored to the first stage; a re-stage of
* a digest that has already aged out re-anchors the TTL to now so it is dispatchable again). After the
* upsert, every
 * OTHER `staged` proposal sharing this `logical_key` is flipped to `superseded` — so the cockpit shows
 * exactly one live proposal per logical graph (the latest digest the operator would dispatch). The
 * supersede RECONCILES to the globally-newest staged row (`updated_at`, `digest`-tie-broken) rather than
 * flipping only rows older than the just-written one, so concurrent stages of two different digests
 * converge to EXACTLY ONE live proposal — never zero, and never two — regardless of arrival order.
 *
 * Returns a {@link StageOutcome} — the written row plus the supersede/sibling summary (issue #740) the
 * stage doors surface so an agent can warn the operator precisely about siblings it did / did not
 * retire. */
export async function stageProposal(data: DataLayer, row: DeliveryGraphProposal): Promise<StageOutcome> {
  const table = deliveryGraphProposals(data);
  const existing = await table.get(row.digest);
  // Capture the same-logical-key staged siblings that exist BEFORE this stage writes (excluding our own
  // digest) — the supersede reconcile below normally flips them all to `superseded`; we re-read them
  // after to report exactly which digests this stage retired.
  const priorSameKey = (await table.find({ status: "staged" })).filter(
    (r) => r.logical_key === row.logical_key && r.digest !== row.digest && isLiveStaged(r),
  );
  const toWrite = existing
    ? buildProposalRow({
        digest: row.digest,
        logicalKey: row.logical_key,
        title: row.title,
        graphJson: row.graph,
        preview: JSON.parse(row.preview),
        nodeCount: row.node_count,
        humanNodeCount: row.human_node_count,
        sideEffectCount: row.side_effect_count,
        sideEffecting: row.side_effecting === 1,
        // Re-stage: if the existing row is STILL LIVE, preserve its original stage time so the TTL
        // stays anchored to the first stage. But if it has already aged out of its TTL (or was
        // dispatched/superseded long ago), reusing the stale `created_at` would yield a past
        // `expires_at`, leaving the "re-staged" row immediately non-dispatchable (`getStagedProposal`
        // rejects it as expired) while the preview claims it is staged. In that case re-anchor the TTL
        // to now (omit `createdAt`) so a re-proposed digest is genuinely live again.
        createdAt: isProposalExpired(existing.expires_at) ? undefined : existing.created_at,
      })
    : row;
  if (existing) {
    const { digest, ...patch } = toWrite;
    await table.update(row.digest, patch);
  } else {
    await table.insert(toWrite);
  }
  // Reconcile to EXACTLY ONE live proposal per logical graph: supersede every `staged` row for this
  // `logical_key` that has a strictly-NEWER staged sibling (by `updated_at`, with a deterministic
  // `digest` tie-breaker), leaving only the globally-newest live. This is ORDER-INDEPENDENT — it never
  // references the just-written digest, so it converges to a single live row regardless of the
  // interleaving of concurrent stages. A supersede pass keyed to "only flip rows older than the one *I*
  // just wrote" leaves TWO live proposals when an OLDER stage's pass runs AFTER a newer stage already
  // committed (the older pass won't flip the newer row, and the newer pass ran before the older row
  // existed) — and an unordered supersede-all leaves ZERO. Anchoring on the newest staged sibling avoids
  // both: the newest row is never superseded (no newer sibling), so it stays staged throughout the
  // statement and every older row's `EXISTS` is satisfied by it. Idempotent: a no-op once one row remains.
  await data
    .open()
    .exec(
      `UPDATE "delivery_graph_proposals" SET "status" = 'superseded', "updated_at" = ? WHERE "logical_key" = ? AND "status" = 'staged' AND EXISTS (SELECT 1 FROM "delivery_graph_proposals" AS "newer" WHERE "newer"."logical_key" = "delivery_graph_proposals"."logical_key" AND "newer"."status" = 'staged' AND ("newer"."updated_at" > "delivery_graph_proposals"."updated_at" OR ("newer"."updated_at" = "delivery_graph_proposals"."updated_at" AND "newer"."digest" > "delivery_graph_proposals"."digest")))`,
      [now(), row.logical_key],
    );

  // Report what the stage did to siblings (issue #740). `superseded` = the same-logical-key proposals
  // this stage retired (re-read post-reconcile so a concurrent newer stage that kept ITS row live —
  // leaving ours superseded — is reported honestly). `siblingsStaged` = OTHER live staged proposals
  // with a DIFFERENT logical key that remain (the orphaned-sibling footgun: a re-stage under a changed
  // `name` never supersedes them).
  const superseded: string[] = [];
  for (const prev of priorSameKey) {
    const after = await table.get(prev.digest);
    if (after && after.status !== "staged") superseded.push(prev.digest);
  }
  const siblingsStaged = (await listStagedProposals(data)).filter((r) => r.logical_key !== row.logical_key).length;

  return { row: toWrite, superseded, siblingsStaged };
}

/** The ONE definition of "a live, dispatchable-RIGHT-NOW staged proposal" (issue #608): the row is
 * `staged` (not superseded / dispatched / expired / dismissed) AND has not aged out of its TTL. This is
 * the SINGLE SOURCE OF TRUTH the digest read (`getStagedProposal`), the list read
 * (`listStagedProposals`), and — through them — the cockpit App-View, the dispatch/preview/dismiss
 * doors, and the MCP `listStagedProposals` tool all resolve liveness through, so no two readers can ever
 * drift on which rows are live (AGENTS.md "Derivation over duplication"). A read-after-write from
 * `compileDeliveryGraph` is trustworthy because this predicate is evaluated over the SAME durable
 * `delivery_graph_proposals` store the compile door commits the row to (the app's single default
 * `app.data` source) — a freshly staged row (`status: 'staged'`, `expires_at` a full TTL in the future)
 * is live by construction, with no projection/read-model between the write and the read to lag behind. */
export function isLiveStaged(row: DeliveryGraphProposal, at: Date = new Date()): boolean {
  return row.status === "staged" && !isProposalExpired(row.expires_at, at);
}

/** Load a proposal that is live and dispatchable RIGHT NOW: it exists and satisfies {@link isLiveStaged}
 * (it is `staged` — not superseded or already dispatched — and has not aged out of its TTL). Returns
 * null otherwise, so the cockpit dispatch action refuses a stale/unknown/already-dispatched digest
 * cleanly. Reads the authoritative `delivery_graph_proposals` row by primary key from the same
 * `app.data` store the compile door stages into — a read-your-writes lookup, no read-model in between. */
export async function getStagedProposal(
  data: DataLayer,
  digest: string,
  at: Date = new Date(),
): Promise<DeliveryGraphProposal | null> {
  const row = await deliveryGraphProposals(data).get(digest);
  if (!row) return null;
  return isLiveStaged(row, at) ? row : null;
}

/** Every LIVE staged proposal — {@link isLiveStaged} (`status = 'staged'` AND not aged out of its TTL) —
 * newest first. The staged App-View (`pages/delivery-graphs/staged.mount.js`) and the MCP
 * `listStagedProposals` tool both poll THIS door to render/answer the Preview-DI + Dispatch list.
 *
 * READ-AFTER-WRITE GUARANTEE (issue #608). The list is served by a fresh query against the authoritative
 * `delivery_graph_proposals` table on the app's single default `app.data` source — the SAME store, in
 * the SAME scope, the `compileDeliveryGraph`/`stageProposal` write commits to. There is no
 * projection/read-model or cache between the write and this read, so a digest `compileDeliveryGraph`
 * just returned is listed on the very next call with NO intervening delay (the write is committed before
 * the compile door responds). Liveness is decided by the shared {@link isLiveStaged} predicate — NOT a
 * second `status = 'staged'` datasource filter, which cannot express an `expires_at > now` cutoff and so
 * would linger an aged-out row until the poller's sweep realises the TTL. Read-only; no write. */
export async function listStagedProposals(
  data: DataLayer,
  at: Date = new Date(),
): Promise<DeliveryGraphProposal[]> {
  const rows = await deliveryGraphProposals(data).find({ status: "staged" });
  return rows
    .filter((row) => isLiveStaged(row, at))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Mark a staged proposal `dispatched` once the operator launches it — it drops out of the cockpit's
 * staged list (the run then shows in the in-flight grid). */
export async function markProposalDispatched(data: DataLayer, digest: string): Promise<void> {
  await deliveryGraphProposals(data).update(digest, { status: "dispatched", updated_at: now() });
}

/** Retire a proposal by flipping it to `expired` — its `graph` payload is unusable (e.g. corrupt JSON
 * detected at dispatch), so it can never launch. Reuses the terminal `expired` status the sweep already
 * uses, so a fail-closed retirement drops the row out of the cockpit's staged grid instead of leaving an
 * undismissable `staged` row that fails every dispatch attempt the same way.
 *
 * Like `sweepExpiredProposals`/`markProposalDismissed`, the flip is a GUARDED UPDATE
 * (`... WHERE digest=? AND status='staged'`), not a blind update-by-key. The dispatch door's
 * `getStagedProposal` liveness read and this write are separate statements, so a proposal can leave
 * `staged` in the window between them (an operator dismisses it, or it's superseded/dispatched by another
 * concurrent action); a blind `table.update(digest, …)` would clobber that newer terminal status back to
 * `expired`, breaking monotonic lifecycle transitions. The `status='staged'` guard makes the write a no-op
 * when the row has already moved on.
 *
 * Returns whether the guarded UPDATE actually flipped a row (`res.changed > 0`), mirroring
 * `markProposalDismissed`/`sweepExpiredProposals`. A `false` return means the row was no longer `staged`
 * at write time (a dismiss/supersede/dispatch race won), so the caller must not treat the retirement as
 * having happened. */
export async function markProposalExpired(data: DataLayer, digest: string): Promise<boolean> {
  const db = data.open();
  const res = await db.exec(
    `UPDATE "delivery_graph_proposals" SET "status" = 'expired', "updated_at" = ? WHERE "digest" = ? AND "status" = 'staged'`,
    [now(), digest],
  );
  return res.changed > 0;
}

/** Dismiss a staged proposal at an operator's explicit request — flip it to the terminal `dismissed`
 * status so it drops out of the cockpit's staged grid (which filters to `status = 'staged'`), exactly
 * like `superseded`/`expired`. Unlike `expired` (a TTL sweep) or `superseded` (a newer digest landed),
 * `dismissed` records a deliberate operator "this is noise, hide it" — the proposal was neither aged out
 * nor replaced. Callers (the `dismissProposal` door) gate this behind a `getStagedProposal` liveness
 * check so an unknown or already-terminal digest is refused before this runs, keeping the dismiss
 * idempotent.
 *
 * Like `sweepExpiredProposals`, the flip is a GUARDED UPDATE (`... WHERE digest=? AND status='staged'`),
 * not a blind update-by-key. The door's `getStagedProposal` check and this write are separate statements,
 * so a dispatch (or a supersede/expiry sweep) can move the row off `staged` in the window between them; a
 * blind `table.update(digest, …)` would clobber that newer terminal status back to `dismissed`, silently
 * re-hiding a run the operator just launched. The `status='staged'` guard makes the write a no-op when the
 * row has already moved on, preserving monotonic lifecycle transitions under concurrent operator actions.
 *
 * Returns whether the guarded UPDATE actually flipped a row (`res.changed > 0`), mirroring how
 * `sweepExpiredProposals` counts `res.changed`. A `false` return means the row was no longer `staged` at
 * write time (the dispatch/supersede/expiry race above won), so the caller (the `dismissProposal` door)
 * must NOT report success — the dismiss lost the race and its idempotency contract routes that to a clean
 * 400, exactly as an already-terminal digest does. */
export async function markProposalDismissed(data: DataLayer, digest: string): Promise<boolean> {
  const db = data.open();
  const res = await db.exec(
    `UPDATE "delivery_graph_proposals" SET "status" = 'dismissed', "updated_at" = ? WHERE "digest" = ? AND "status" = 'staged'`,
    [now(), digest],
  );
  return res.changed > 0;
}

/** Age out every `staged` proposal whose TTL has elapsed by flipping it to `expired`, so it drops out
 * of the cockpit's staged grid (which filters to `status = 'staged'`). The grid's datasource filter can
 * only express equality/set-membership — not an `expires_at > now` comparison — so an expired-but-still-
 * `staged` row would otherwise linger in the list indefinitely, only to fail dispatch with "no live
 * staged proposal". This reconciliation sweep (driven by the poller) is the single writer that realises
 * the TTL, reusing the canonical `isProposalExpired` predicate so there is no second definition of
 * "expired". Returns the number of proposals swept. Idempotent: a proposal already terminal (superseded/
 * dispatched/expired) is left untouched.
 *
 * The expiry flip is a GUARDED UPDATE (`... WHERE digest=? AND status='staged'`), not a blind
 * update-by-key. The initial `find()` and the per-row write are separate statements, so a proposal can
 * be dispatched (or superseded) in the window between them; a blind `table.update(digest, …)` would
 * clobber that newer terminal status back to `expired`, silently re-hiding a run the operator just
 * launched. The `status='staged'` guard makes the write a no-op when the row has already moved on, and
 * we count only rows that actually changed (`res.changed`) so the returned tally stays honest. */
export async function sweepExpiredProposals(data: DataLayer, at: Date = new Date()): Promise<number> {
  const table = deliveryGraphProposals(data);
  const staged = await table.find({ status: "staged" });
  const ts = now();
  const db = data.open();
  let swept = 0;
  for (const row of staged) {
    if (isProposalExpired(row.expires_at, at)) {
      const res = await db.exec(
        `UPDATE "delivery_graph_proposals" SET "status" = 'expired', "updated_at" = ? WHERE "digest" = ? AND "status" = 'staged'`,
        [ts, row.digest],
      );
      swept += res.changed;
    }
  }
  return swept;
}
