// Unit tests for the epic coordination blackboard (Tier 1, issues #51 / #49 D4).
//
// H4 (#147) migrated the storage onto `@nanobpm/agentic/blackboard`'s shared `BlackboardStore`
// (table `agentic_blackboard`), reached over the app DataLayer's raw SQLite handle. These tests run
// the adapter against a REAL in-memory SQLite engine (see `test/blackboardDb.ts`), so the
// idempotency, conflict, and incremental-read behaviour is verified end-to-end, not against a mock.
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import { memBlackboardData } from "../test/blackboardDb.ts";
import {
  APP_BLACKBOARD_KINDS,
  appendEntry,
  blackboardUrl,
  detectContractDeclarationConflicts,
  detectFileClaimConflicts,
  isUniqueViolation,
  mintBlackboardToken,
  normalizeAppKind,
  normalizeKind,
  parseContractRef,
  planKeyForToken,
  planKeyForTokenSync,
  publicBaseUrl,
  readBlackboard,
  readBlackboardPage,
  renderCoordinationBrief,
} from "./blackboard.ts";

test("mintBlackboardToken: URL-safe, unguessable, unique", () => {
  const a = mintBlackboardToken();
  const b = mintBlackboardToken();
  assert(a !== b, "two mints must differ");
  assert(/^[A-Za-z0-9_-]+$/.test(a), `token must be URL-safe base64url, got ${a}`);
  assert(a.length >= 32, "token should carry enough entropy");
});

test("publicBaseUrl: honours the env override and trims a trailing slash", () => {
  assertEquals(publicBaseUrl("https://pr.example.com/"), "https://pr.example.com");
  assertEquals(publicBaseUrl("https://pr.example.com///"), "https://pr.example.com");
});

test("publicBaseUrl: a blank/whitespace override falls back instead of yielding a bad URL", () => {
  assertEquals(publicBaseUrl(""), "http://localhost:3000");
  assertEquals(publicBaseUrl("   "), "http://localhost:3000");
  assertEquals(blackboardUrl("t", publicBaseUrl("")), "http://localhost:3000/app/api/hooks/blackboard?token=t");
});

test("blackboardUrl: capability token rides the query string", () => {
  assertEquals(
    blackboardUrl("tok+en/x", "https://h"),
    "https://h/app/api/hooks/blackboard?token=tok%2Ben%2Fx",
  );
});

test("normalizeKind: valid passes through, anything else becomes note", () => {
  assertEquals(normalizeKind("file-claim"), "file-claim");
  assertEquals(normalizeKind("constraint-change"), "constraint-change");
  assertEquals(normalizeKind("learning"), "learning");
  assertEquals(normalizeKind("bogus"), "note");
  assertEquals(normalizeKind(undefined), "note");
});

test("normalizeAppKind: passes contract through (the store's own normaliser would coerce it to note)", () => {
  assertEquals(normalizeAppKind("contract"), "contract");
  assertEquals(normalizeAppKind("file-claim"), "file-claim");
  assertEquals(normalizeAppKind("bogus"), "note");
  assert(APP_BLACKBOARD_KINDS.includes("contract"), "contract is an app-recognised kind");
  assert(APP_BLACKBOARD_KINDS.includes("note"), "app kinds are a superset of the store's kinds");
});

test("parseContractRef: parses the <category>:<name> dedupe_key convention", () => {
  assertEquals(parseContractRef("env:NANO_X"), { category: "env", name: "NANO_X" });
  assertEquals(parseContractRef("type:BlackboardEntry"), { category: "type", name: "BlackboardEntry" });
  assertEquals(parseContractRef("bogus:X"), undefined);
  assertEquals(parseContractRef("nocolon"), undefined);
  assertEquals(parseContractRef(undefined), undefined);
});

test("detectContractDeclarationConflicts: flags a retired synonym; clean for a genuinely new key", () => {
  const rejected = detectContractDeclarationConflicts({ dedupe_key: "env:NANO_PR_BASE_URL", body: "base url" });
  assertEquals(rejected[0]?.kind, "rejected-synonym");
  assertEquals(detectContractDeclarationConflicts({ dedupe_key: "env:NANO_TOTALLY_NEW", body: "an unrelated brand new thing about caching" }), []);
  // No convention → nothing to reconcile against.
  assertEquals(detectContractDeclarationConflicts({ body: "freeform" }), []);
});

test("renderCoordinationBrief: leads with a separator and teaches the protocol + URL", () => {
  const url = "https://h/app/api/hooks/blackboard?token=abc";
  const brief = renderCoordinationBrief(url);
  assert(brief.startsWith("\n\n---"), "must own a leading separator (appendPrompt adds none)");
  assertStringIncludes(brief, url);
  // read + write halves of the protocol
  assertStringIncludes(brief, "curl -s");
  assertStringIncludes(brief, "-X POST");
  assertStringIncludes(brief, "author_task");
  assertStringIncludes(brief, "file-claim");
  assertStringIncludes(brief, "dedupe_key");
  // Tier 2: teaches incremental re-reading via the cursor and reacting to a claim conflict.
  assertStringIncludes(brief, "cursor");
  assertStringIncludes(brief, "&since=");
  assertStringIncludes(brief, "conflicts");
  // Learnings: teaches reading prior gotchas and posting a reusable `learning`.
  assertStringIncludes(brief, "learning");
  assertStringIncludes(brief, "Share what you learn");
  // Contracts (#227): teaches consulting the registry + blackboard and posting a `contract` entry.
  assertStringIncludes(brief, "contract");
  assertStringIncludes(brief, "app/contracts.ts");
  assertStringIncludes(brief, "kind\":\"contract\"");
});

test("planKeyForToken: resolves a token to its plan, undefined otherwise (async + sync agree)", async () => {
  const { data, db } = memBlackboardData();
  await data.table("plans", "plan_key").insert({ plan_key: "o/r#7", blackboard_token: "tok7" });
  assertEquals(await planKeyForToken(data, "tok7"), "o/r#7");
  assertEquals(await planKeyForToken(data, "nope"), undefined);
  assertEquals(await planKeyForToken(data, ""), undefined);
  // The sync resolver (used by the agentic channel's scopeOf) resolves the identical mapping, so the
  // HTTP hook and the channel scope a plan's board to the same plan_key.
  assertEquals(planKeyForTokenSync(db, "tok7"), "o/r#7");
  assertEquals(planKeyForTokenSync(db, "nope"), undefined);
  assertEquals(planKeyForTokenSync(db, ""), undefined);
});

test("appendEntry + readBlackboard: append, encode files, read back in write order", async () => {
  const { data } = memBlackboardData();
  await appendEntry(data, "o/r#1", { author_task: "gap-2", kind: "file-claim", files: ["a.rs"], body: "touches a.rs" });
  await appendEntry(data, "o/r#1", { author_task: "gap-8", kind: "note", body: "heads up" });
  await appendEntry(data, "o/r#2", { body: "other plan" }); // must not leak across plans

  const entries = await readBlackboard(data, "o/r#1");
  assertEquals(entries.map((e) => e.author_task), ["gap-2", "gap-8"], "write order, scoped to plan");
  assertEquals(entries[0].files, ["a.rs"], "files decoded to an array");
  assertEquals(entries[1].files, [], "no files → empty array");
  assertEquals(entries[1].author_task, "gap-8");
});

test("appendEntry: trims whitespace-padded file paths so stored/read values are clean", async () => {
  const { data } = memBlackboardData();
  await appendEntry(data, "p", { kind: "file-claim", files: ["  engine/state.rs  ", "\tengine/mine.rs\n"], body: "claims" });
  const [e] = await readBlackboard(data, "p");
  assertEquals(e.files, ["engine/state.rs", "engine/mine.rs"], "paths stored trimmed, not whitespace-padded");
});

test("appendEntry: a missing author defaults to 'system' and kind is normalised", async () => {
  const { data } = memBlackboardData();
  await appendEntry(data, "p", { body: "x", kind: "weird" as unknown });
  const [e] = await readBlackboard(data, "p");
  assertEquals(e.author_task, "system");
  assertEquals(e.kind, "note");
});

test("appendEntry: idempotent on dedupe_key (a job retry re-POST is a no-op)", async () => {
  const { data, db } = memBlackboardData();
  const first = await appendEntry(data, "p", { author_task: "t", body: "claim", dedupe_key: "t:claim:1" });
  const again = await appendEntry(data, "p", { author_task: "t", body: "claim", dedupe_key: "t:claim:1" });
  assertEquals(first.inserted, true);
  assertEquals(again.inserted, false, "second write with same dedupe_key is a no-op");
  assertEquals(again.id, first.id, "returns the existing id");
  const [{ n }] = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM agentic_blackboard WHERE scope = ?", ["p"]);
  assertEquals(n, 1, "exactly one row persisted");
});

test("appendEntry: a repeat dedupe_key collapses to the existing row instead of a fresh insert", async () => {
  // The store's idempotent short-circuit (and its lost-UNIQUE-race recovery) means re-appending a
  // fact under a stable dedupe_key returns the winning row as inserted:false rather than throwing —
  // an engine job retry never duplicates or 500s.
  const { data } = memBlackboardData();
  const winner = await appendEntry(data, "p", { author_task: "t", body: "claim", dedupe_key: "t:claim:1" });
  assertEquals(winner.inserted, true);
  const retry = await appendEntry(data, "p", { author_task: "t", body: "claim", dedupe_key: "t:claim:1" });
  assertEquals(retry.inserted, false, "a repeat is not a fresh insert");
  assertEquals(retry.id, winner.id, "returns the winning row's id");
});

test("appendEntry: a blank body is rejected", async () => {
  const { data } = memBlackboardData();
  let threw = false;
  try {
    await appendEntry(data, "p", { body: "   " });
  } catch {
    threw = true;
  }
  assert(threw, "blank body must throw");
});

test("appendEntry: a contract append patches the kind even when it collapses onto an existing row (deterministic round-trip)", async () => {
  const { data } = memBlackboardData();
  // A prior append under this dedupe_key stored kind `note` (the store's default for an unknown kind).
  const first = await appendEntry(data, "p", { author_task: "t", body: "seed", kind: "note", dedupe_key: "env:NANO_X" });
  assertEquals(first.inserted, true);
  // A later `contract` append with the SAME dedupe_key is a no-op insert (`inserted: false`) — but it
  // must still leave the row readable as `contract`, not lingering as `note`.
  const again = await appendEntry(data, "p", { author_task: "t", body: "seed", kind: "contract", dedupe_key: "env:NANO_X" });
  assertEquals(again.inserted, false, "same dedupe_key is a no-op insert");
  const entries = await readBlackboard(data, "p");
  assertEquals(entries.length, 1);
  assertEquals(entries[0].kind, "contract", "the contract kind is patched deterministically regardless of res.inserted");
});

test("readBlackboard: since returns only newer entries (incremental poll)", async () => {
  const { data } = memBlackboardData();
  await appendEntry(data, "p", { body: "one" });
  await appendEntry(data, "p", { body: "two" });
  await appendEntry(data, "p", { body: "three" });
  const all = await readBlackboard(data, "p");
  const tail = await readBlackboard(data, "p", { since: all[0].id });
  assertEquals(tail.map((e) => e.body), ["two", "three"]);
});

test("readBlackboardPage: cursor is the plan head and lets an agent poll to caught-up (Tier 2)", async () => {
  const { data } = memBlackboardData();
  await appendEntry(data, "p", { body: "one" });
  await appendEntry(data, "p", { body: "two" });

  const first = await readBlackboardPage(data, "p");
  assertEquals(first.entries.map((e) => e.body), ["one", "two"]);
  assertEquals(first.cursor, first.entries[1].id, "cursor is the head id");

  // Poll again from the cursor: nothing new, and the cursor holds at the head (not reset to 0).
  const caughtUp = await readBlackboardPage(data, "p", { since: first.cursor });
  assertEquals(caughtUp.entries, []);
  assertEquals(caughtUp.cursor, first.cursor, "a caught-up poll keeps the head cursor");

  // A sibling posts; the next poll from the cursor returns only the new entry and advances.
  await appendEntry(data, "p", { body: "three" });
  const next = await readBlackboardPage(data, "p", { since: first.cursor });
  assertEquals(next.entries.map((e) => e.body), ["three"]);
  assertEquals(next.cursor, next.entries[0].id);
});

test("readBlackboardPage: an empty plan yields no entries and a zero cursor", async () => {
  const { data } = memBlackboardData();
  const page = await readBlackboardPage(data, "empty");
  assertEquals(page.entries, []);
  assertEquals(page.cursor, 0);
});

test("detectFileClaimConflicts: a sibling's prior claim on the same file is surfaced", async () => {
  const { data } = memBlackboardData();
  await appendEntry(data, "p", { author_task: "gap-2", kind: "file-claim", files: ["engine/state.rs"], body: "owns state.rs" });

  const conflicts = await detectFileClaimConflicts(data, "p", {
    author_task: "gap-8",
    files: ["engine/state.rs", "engine/mine.rs"],
  });
  assertEquals(conflicts.length, 1, "only the overlapping file is a conflict");
  assertEquals(conflicts[0].file, "engine/state.rs");
  assertEquals(conflicts[0].author_task, "gap-2", "reports the first (winning) claimer");
});

test("detectFileClaimConflicts: your own prior claim and non-file-claim entries are not conflicts", async () => {
  const { data } = memBlackboardData();
  await appendEntry(data, "p", { author_task: "gap-2", kind: "file-claim", files: ["a.rs"], body: "my earlier claim" });
  await appendEntry(data, "p", { author_task: "gap-8", kind: "note", files: ["a.rs"], body: "just a note about a.rs" });

  // Re-claiming my own file: no self-conflict, and the sibling's note (not a file-claim) is ignored.
  assertEquals(
    await detectFileClaimConflicts(data, "p", { author_task: "gap-2", files: ["a.rs"] }),
    [],
  );
  // No files to claim → nothing to conflict on.
  assertEquals(await detectFileClaimConflicts(data, "p", { author_task: "gap-9", files: [] }), []);
});

test("detectFileClaimConflicts: beforeId restricts to strictly prior claims (insertion order wins)", async () => {
  const { data } = memBlackboardData();
  const prior = await appendEntry(data, "p", {
    author_task: "gap-2",
    kind: "file-claim",
    files: ["a.rs"],
    body: "prior sibling claim",
  });
  const mine = await appendEntry(data, "p", {
    author_task: "gap-8",
    kind: "file-claim",
    files: ["a.rs"],
    body: "my claim",
  });
  const later = await appendEntry(data, "p", {
    author_task: "gap-9",
    kind: "file-claim",
    files: ["a.rs"],
    body: "sibling that claimed after me",
  });

  // Computed after my insert, filtered to id < mine: only the strictly-prior sibling is a conflict —
  // my own row and the later sibling's row are excluded even though both overlap the file.
  const conflicts = await detectFileClaimConflicts(data, "p", {
    author_task: "gap-8",
    files: ["a.rs"],
    beforeId: Number(mine.id),
  });
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].id, Number(prior.id));
  assertEquals(conflicts[0].author_task, "gap-2");
  assert(Number(later.id) > Number(mine.id));
});

test("isUniqueViolation: true for UNIQUE/PK, false for FOREIGN KEY and unrelated errors", () => {
  // Extended SQLite codes.
  assert(isUniqueViolation(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_UNIQUE" })));
  assert(isUniqueViolation(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" })));
  // Message-only (driver surfaced no code).
  assert(isUniqueViolation(new Error("UNIQUE constraint failed: plan_retros.plan_key")));
  assert(isUniqueViolation(new Error("PRIMARY KEY constraint failed")));
  // The bug this guards: a bare "constraint" match would swallow an FK failure.
  assert(!isUniqueViolation(new Error("FOREIGN KEY constraint failed")));
  assert(!isUniqueViolation(Object.assign(new Error("fk"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" })));
  // Unrelated / non-errors.
  assert(!isUniqueViolation(new Error("network down")));
  assert(!isUniqueViolation(null));
  assert(!isUniqueViolation("nope"));
});
