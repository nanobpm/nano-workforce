// POST /app/api/hooks/blackboard?token=<capabilityToken> → operationId `appendBlackboard` (ADR 0059
// webhook operation; was the POST half of the `/hooks/blackboard` action; Tier 1, issues #51 / #49 D4).
//
// The per-plan capability token (query string) IS the credential (see readBlackboard). An unknown
// token is a 404 (never leaks which plans exist).
//
//   POST → append one entry: { author_task?, kind?, files?, body, wave?, dedupe_key? }. Idempotent
//          on (plan, dedupe_key). Returns { id, inserted, conflicts } — `conflicts` lists prior
//          sibling `file-claim`s on the same file(s) (advisory first-writer-wins; never a lock).

import {
  appendEntry,
  detectContractDeclarationConflicts,
  detectFileClaimConflicts,
  normalizeAppKind,
  planKeyForToken,
} from "../app/blackboard.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("appendBlackboard", async ({ req, body }, app) => {
  const token = (req.query.get("token") ?? req.headers.get("x-blackboard-token") ?? "").trim();
  if (!token) return { status: 400, body: { error: "missing blackboard token" } };
  const planKey = await planKeyForToken(app.data, token);
  if (!planKey) {
    app.log.warn("appendBlackboard: unknown blackboard token");
    return { status: 404, body: { error: "unknown blackboard token" } };
  }

  const b = body ?? {};
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (!text) return { status: 400, body: { error: "'body' (the note text) is required" } };
  const kind = normalizeAppKind(b.kind);
  const files = Array.isArray(b.files) ? b.files.map(String) : [];
  // Normalize once (trim + default to "system") so the value we send to appendEntry matches the
  // value we send to detectFileClaimConflicts. Otherwise an omitted/blank author_task is stored as
  // "system" but conflict detection sees "", and the caller's own prior "system" claims are wrongly
  // reported as sibling conflicts.
  const author_task = (typeof b.author_task === "string" ? b.author_task.trim() : "") || "system";
  const dedupe_key = typeof b.dedupe_key === "string" ? b.dedupe_key : undefined;
  const res = await appendEntry(app.data, planKey, {
    author_task,
    kind,
    files,
    body: text,
    wave: typeof b.wave === "number" ? b.wave : null,
    dedupe_key,
  });
  // Advisory conflict-of-intent. For a `file-claim`, surface prior sibling claims on the same
  // file(s) — computed AFTER the append and filtered to claims strictly before ours (id < res.id),
  // so first-writer-wins is decided by insertion order (a sibling that raced a claim in between is
  // still caught, and our own just-written row is never reported). Never blocks the append.
  const conflicts = kind === "file-claim"
    ? await detectFileClaimConflicts(app.data, planKey, {
      author_task,
      files,
      beforeId: res.id,
    })
    : [];
  // For a `contract`, surface near-duplicate DECLARATION conflicts (a synonym/contradiction/rejected
  // synonym vs. the durable registry) so a writer reconciles a divergent contract at authoring time
  // (#227). Advisory — the agent decides how to react.
  const contractConflicts = kind === "contract"
    ? detectContractDeclarationConflicts({ dedupe_key, body: text })
    : [];
  app.log.info("blackboard entry appended", {
    planKey,
    kind,
    inserted: res.inserted,
    conflicts: conflicts.length,
    contractConflicts: contractConflicts.length,
  });
  return {
    status: res.inserted ? 201 : 200,
    body: { id: res.id, inserted: res.inserted, conflicts, contractConflicts },
  };
});
