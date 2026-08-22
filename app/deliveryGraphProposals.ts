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
 * out of its TTL before an operator dispatched it. `superseded`/`dispatched`/`expired` all drop out of
 * the cockpit's staged list (which filters to `status = 'staged'`). */
export const DELIVERY_PROPOSAL_STATUSES = ["staged", "superseded", "dispatched", "expired"] as const;
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
 * address; a preview, not a dispatch affordance. */
export function buildProposalPreview(compiled: CompileDeliveryGraphResult): DeliveryProposalPreview {
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

/** Persist a compiled graph as a `staged` proposal and SUPERSEDE any prior staged proposal for the
* same logical graph. Idempotent on `digest` (a re-stage of an identical, still-live digest refreshes
* `updated_at` but preserves `created_at`, so the TTL stays anchored to the first stage; a re-stage of
* a digest that has already aged out re-anchors the TTL to now so it is dispatchable again). After the
* upsert, every
 * OTHER `staged` proposal sharing this `logical_key` is flipped to `superseded` — so the cockpit shows
 * exactly one live proposal per logical graph (the latest digest the operator would dispatch). The
 * supersede is ORDERED (older-than the just-written row, `digest`-tie-broken) so concurrent stages of
 * two different digests can never clobber each other into ZERO live proposals — the newest survives. */
export async function stageProposal(data: DataLayer, row: DeliveryGraphProposal): Promise<DeliveryGraphProposal> {
  const table = deliveryGraphProposals(data);
  const existing = await table.get(row.digest);
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
  // Supersede prior staged proposals for the same logical graph (different digest) in one statement.
  // ORDER the supersede so an OLDER stage can never clobber a NEWER one: only flip rows that are
  // strictly older than the row we just wrote, with a deterministic `digest` tie-breaker for the
  // same-`updated_at` case. Without this ordering, two callers staging different digests for the same
  // logical_key concurrently each supersede the other's row (upsert-then-supersede-all is a split
  // read/modify/write), ending with BOTH `superseded` and ZERO live proposals for the logical key.
  // Ordering guarantees the globally-newest stage always survives every racing supersede pass.
  await data
    .open()
    .exec(
      `UPDATE "delivery_graph_proposals" SET "status" = 'superseded', "updated_at" = ? WHERE "logical_key" = ? AND "digest" <> ? AND "status" = 'staged' AND ("updated_at" < ? OR ("updated_at" = ? AND "digest" < ?))`,
      [now(), row.logical_key, row.digest, toWrite.updated_at, toWrite.updated_at, row.digest],
    );
  return toWrite;
}

/** Load a proposal that is live and dispatchable RIGHT NOW: it exists, is `staged` (not superseded or
 * already dispatched), and has not aged out of its TTL. Returns null otherwise, so the cockpit
 * dispatch action refuses a stale/unknown/already-dispatched digest cleanly. */
export async function getStagedProposal(
  data: DataLayer,
  digest: string,
  at: Date = new Date(),
): Promise<DeliveryGraphProposal | null> {
  const row = await deliveryGraphProposals(data).get(digest);
  if (!row) return null;
  if (row.status !== "staged") return null;
  if (isProposalExpired(row.expires_at, at)) return null;
  return row;
}

/** Mark a staged proposal `dispatched` once the operator launches it — it drops out of the cockpit's
 * staged list (the run then shows in the in-flight grid). */
export async function markProposalDispatched(data: DataLayer, digest: string): Promise<void> {
  await deliveryGraphProposals(data).update(digest, { status: "dispatched", updated_at: now() });
}

/** Age out every `staged` proposal whose TTL has elapsed by flipping it to `expired`, so it drops out
 * of the cockpit's staged grid (which filters to `status = 'staged'`). The grid's datasource filter can
 * only express equality/set-membership — not an `expires_at > now` comparison — so an expired-but-still-
 * `staged` row would otherwise linger in the list indefinitely, only to fail dispatch with "no live
 * staged proposal". This reconciliation sweep (driven by the poller) is the single writer that realises
 * the TTL, reusing the canonical `isProposalExpired` predicate so there is no second definition of
 * "expired". Returns the number of proposals swept. Idempotent: a proposal already terminal (superseded/
 * dispatched/expired) is left untouched. */
export async function sweepExpiredProposals(data: DataLayer, at: Date = new Date()): Promise<number> {
  const table = deliveryGraphProposals(data);
  const staged = await table.find({ status: "staged" });
  const ts = now();
  let swept = 0;
  for (const row of staged) {
    if (isProposalExpired(row.expires_at, at)) {
      await table.update(row.digest, { status: "expired", updated_at: ts });
      swept++;
    }
  }
  return swept;
}
