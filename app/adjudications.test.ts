// Unit tests for the durable wait-answer adjudication store (issue #806).
//
// The convergence loop must remember a human's answer to a `wait-answer` question so a later
// stateless round that re-derives the IDENTICAL question auto-resumes with it instead of re-parking
// a human. These cover the pure fingerprint match + the INSERT-if-absent persistence, both keyed by
// the CANONICAL `questionFingerprint` (app/github.ts) — the same normaliser/fingerprint advisory acks
// use, so there is no second fingerprint implementation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { invalidateAdjudication, invalidateAdjudicationByCompletion, matchAdjudication, prAdjudications, type PrAdjudicationRow, recordAdjudication, resetAdjudications } from "./adjudications.ts";
import { questionFingerprint } from "./github.ts";

function row(over: Partial<PrAdjudicationRow>): PrAdjudicationRow {
  return {
    id: 1,
    pr_key: "o/r#1",
    question_fingerprint: questionFingerprint("Which retry cap?"),
    answer: "Cap at 5.",
    adjudicated_by: "alice",
    adjudicated_kind: "human",
    adjudicated_at: "2025-01-01T00:00:00.000Z",
    invalidated_at: null,
    source_completion_id: null,
    ...over,
  };
}

test("matchAdjudication: a TOMBSTONED (reverted) row is not replayable even with a valid answer", () => {
  // A human revert of an auto-apply tombstones the source row (`invalidated_at`); the poller must
  // NOT re-apply it, so the same question re-parks a human until a fresh submission (issue #806 review).
  assertEquals(matchAdjudication([row({ invalidated_at: "2025-02-02T00:00:00.000Z" })], "Which retry cap?"), undefined);
  assertEquals(matchAdjudication([row({ invalidated_at: "   " })], "Which retry cap?")?.answer, "Cap at 5.", "a blank tombstone marker is treated as live");
});

test("matchAdjudication: matches a byte/semantic-identical question via the canonical fingerprint", () => {
  const rows = [row({})];
  // Whitespace/case/leading-bullet differences normalise away, exactly as an advisory ack keys.
  const hit = matchAdjudication(rows, "  which   Retry   cap?  ");
  assertEquals(hit?.answer, "Cap at 5.");
});

test("matchAdjudication: a materially different question does NOT match (still escalates)", () => {
  const rows = [row({})];
  assertEquals(matchAdjudication(rows, "Which timeout should we use?"), undefined);
});

test("matchAdjudication: a settled row with a blank/absent answer is not replayable", () => {
  assertEquals(matchAdjudication([row({ answer: null })], "Which retry cap?"), undefined);
  assertEquals(matchAdjudication([row({ answer: "   " })], "Which retry cap?"), undefined);
});


// ── recordAdjudication I/O against the REAL provisioned SQLite data layer ───────────────────────────
// The write path uses raw guarded SQL (an atomic generation-fenced conditional INSERT and a
// compare-and-set blank→known UPDATE), so it is exercised against the actual data layer — not a table
// double — so the guards are validated, not modelled (mirrors deliveryGraphProposals.test.ts).
const APP_ROOT = resolve(import.meta.dirname, "..");

async function withData(
  fn: (data: DataLayer, seedPr: (prKey: string, processKey?: string | null) => Promise<void>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-adj-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    const seedPr = async (prKey: string, processKey: string | null = null) => {
      const ts = new Date().toISOString();
      // pr_adjudications.pr_key is an FK onto pull_requests; the generation guard also reads its
      // process_key, so seed a minimal PR row carrying the run generation under test.
      await app.db.table("pull_requests", "pr_key").insert({
        pr_key: prKey,
        repo: "o/r",
        number: 1,
        url: `https://github.com/o/r/pull/1#${prKey}`,
        status: "converging",
        current_round: 0,
        process_key: processKey,
        created_at: ts,
        updated_at: ts,
      });
    };
    await fn(app.db, seedPr);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const findAdj = (data: DataLayer, prKey: string) => prAdjudications(data).find({ pr_key: prKey });

test("recordAdjudication: persists one settled row keyed by the canonical fingerprint", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].question_fingerprint, questionFingerprint("Which retry cap?"));
    assertEquals(rows[0].answer, "Cap at 5.");
    assertEquals(rows[0].adjudicated_by, "alice");
    assertEquals(rows[0].adjudicated_kind, "human", "the adjudicator's kind is preserved for a faithful auto-resume attribution");
    assertEquals(typeof rows[0].adjudicated_at, "string");
  });
});

test("recordAdjudication: INSERT-if-absent — a second answer to the identical question keeps the first", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    // A later auto-resume re-runs record-answer with the SAME fingerprint (whitespace-variant) — the
    // original adjudicator/answer must survive rather than be overwritten by the auto-apply attribution.
    await recordAdjudication(data, { prKey: "o/r#1", question: "which retry cap?", answer: "Cap at 9.", adjudicatedBy: "auto-applied", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1, "no duplicate row for the same (pr, question)");
    assertEquals(rows[0].answer, "Cap at 5.", "the ORIGINAL answer is preserved");
    assertEquals(rows[0].adjudicated_by, "alice", "the ORIGINAL adjudicator is preserved");
  });
});

test("recordAdjudication: a blank answer is not a decision and is not recorded", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "   ", adjudicatedBy: "alice", adjudicatedKind: "human" });
    assertEquals((await findAdj(data, "o/r#1")).length, 0);
  });
});

// --- issue #806 review: an UNKNOWN-provenance row (an answer that could not be correlated to an
// adjudicator, recorded with a blank `adjudicated_by`) is not auto-resumable — `pollUserTasks` refuses
// to launder an unattributed replay into a human authority — so it re-parks a human every round. A
// later KNOWN-adjudicator answer to the SAME question must HEAL the row to a replayable decision. ---

test("recordAdjudication: heals an unknown-provenance row when a known adjudicator later answers (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    // Round A: an uncorrelated answer records the decision with UNKNOWN provenance (blank adjudicator).
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 3.", adjudicatedBy: undefined, adjudicatedKind: undefined });
    assertEquals((await findAdj(data, "o/r#1"))[0].adjudicated_by, null, "recorded with unknown provenance");
    // Round B: the human answers, now with a KNOWN adjudicator — the row is promoted to that decision.
    await recordAdjudication(data, { prKey: "o/r#1", question: "which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1, "still one row for the same (pr, question)");
    assertEquals(rows[0].adjudicated_by, "alice", "provenance is healed to the known adjudicator");
    assertEquals(rows[0].adjudicated_kind, "human", "the healed row carries the known adjudicator kind");
    assertEquals(rows[0].answer, "Cap at 5.", "the healed row replays the human's answer, not the earlier uncorrelated one");
  });
});

test("recordAdjudication: a KNOWN-provenance row is immutable — a later answer never overwrites it (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 9.", adjudicatedBy: "bob", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].adjudicated_by, "alice", "the ORIGINAL known adjudicator is preserved");
    assertEquals(rows[0].answer, "Cap at 5.", "the ORIGINAL answer is preserved");
  });
});

test("recordAdjudication: an unknown-provenance row stays unknown when a later answer is also uncorrelated (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 3.", adjudicatedBy: undefined, adjudicatedKind: undefined });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 7.", adjudicatedBy: "   ", adjudicatedKind: undefined });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].adjudicated_by, null, "no known adjudicator to heal with, so it stays unknown");
    assertEquals(rows[0].answer, "Cap at 3.", "the row is untouched when there is nothing to heal to");
  });
});

// --- issue #806 review (round 8): the blank→known promotion is a compare-and-set, so two concurrent
// known healers cannot clobber each other — only the FIRST promotion of a blank row wins, keeping the
// documented first-known decision immutable. (A read-then-unconditional-update let the later writer
// overwrite the earlier known answer/adjudicator.) ---

test("recordAdjudication: two known healers race a blank row — only the first promotion wins (CAS) (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    // A blank-provenance row exists (an uncorrelated answer landed first).
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 3.", adjudicatedBy: undefined, adjudicatedKind: undefined });
    // First known healer promotes it to alice.
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    // Second known healer read the SAME blank row but writes AFTER alice's promotion: the CAS blank guard
    // is now false, so its update affects zero rows and alice's decision stands (no clobber).
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 9.", adjudicatedBy: "bob", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].adjudicated_by, "alice", "the FIRST known healer's attribution is immutable");
    assertEquals(rows[0].answer, "Cap at 5.", "the FIRST known healer's answer is not clobbered by the later one");
  });
});

// --- issue #806 review (round 8): every write is fenced on the run generation (the PR's current
// process_key) so a pre-reset straggler — one whose run was superseded by a re-submit that advanced
// process_key and cleared the memory — cannot resurrect a stale adjudication for the fresh run. ---

test("recordAdjudication: a stale-generation straggler's INSERT is fenced out; the current generation writes (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    // The PR has been re-submitted: its current run generation is P2.
    await seedPr("o/r#1", "P2");
    // A straggler from the OLD run (P1) tries to record after the reset — the generation fence no-ops it.
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Stale.", adjudicatedBy: "ghost", adjudicatedKind: "human", expectedProcessKey: "P1" });
    assertEquals((await findAdj(data, "o/r#1")).length, 0, "the pre-reset straggler cannot insert for the fresh run");
    // The current run (P2) records normally.
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human", expectedProcessKey: "P2" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].adjudicated_by, "alice");
    assertEquals(rows[0].answer, "Cap at 5.");
  });
});

test("recordAdjudication: a stale-generation straggler's blank→known HEAL is fenced out (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1", "P2");
    // The current run recorded an unknown-provenance row (blank adjudicator).
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 3.", adjudicatedBy: undefined, adjudicatedKind: undefined, expectedProcessKey: "P2" });
    // A stale straggler (P1) with a known adjudicator must NOT heal it — the generation fence blocks it,
    // so it cannot attribute the fresh run's decision to an old run's actor.
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Ghost.", adjudicatedBy: "ghost", adjudicatedKind: "human", expectedProcessKey: "P1" });
    assertEquals((await findAdj(data, "o/r#1"))[0].adjudicated_by, null, "the stale straggler cannot heal after the reset");
    // The current run (P2) heals it correctly.
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human", expectedProcessKey: "P2" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows[0].adjudicated_by, "alice", "the current-generation known adjudicator heals it");
    assertEquals(rows[0].answer, "Cap at 5.");
  });
});

test("recordAdjudication: an absent expectedProcessKey fails open (unclassifiable job still records) (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    // Even though the PR carries a process_key, a job with NO expected key cannot be classified as
    // stale — it must still record (mirrors the worker's staleness gate fail-open).
    await seedPr("o/r#1", "P2");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human", expectedProcessKey: undefined });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1, "an unclassifiable job is not silently dropped");
    assertEquals(rows[0].adjudicated_by, "alice");
  });
});

// --- fence classification & error propagation: exercised via a data double that injects the raw exec
// outcome, so we assert the `isUniqueConstraintFence` triage without racing a real concurrent writer. ---

test("recordAdjudication: a NON-fence insert error still propagates (#806 review)", async () => {
  // The conditional INSERT's raw exec fails with a non-UNIQUE error — it must NOT be swallowed.
  const data = {
    open() {
      return {
        exec() {
          throw new Error("disk full");
        },
      };
    },
    table() {
      throw new Error("re-read must not be reached when the insert error propagates");
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal data double for error injection
  } as any;
  let threw = false;
  try {
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "a non-fence error is not swallowed");
});

test("recordAdjudication: heals the winner on a UNIQUE-fence collision when the winner is unknown-provenance and we are known (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    // A concurrent uncorrelated (unknown-provenance) answer already inserted the row; our conditional
    // insert then trips the UNIQUE fence. Because WE carry a known adjudicator, the catch re-reads the
    // winner and applies the blank→known promotion — so the row does not stay non-replayable forever.
    await prAdjudications(data).insert({
      pr_key: "o/r#1",
      question_fingerprint: questionFingerprint("Which retry cap?"),
      answer: "Cap at 3.",
      adjudicated_by: null,
      adjudicated_kind: null,
      adjudicated_at: "2025-01-01T00:00:00.000Z",
    });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].adjudicated_by, "alice", "the fenced-out known writer heals the unknown-provenance winner");
    assertEquals(rows[0].adjudicated_kind, "human");
    assertEquals(rows[0].answer, "Cap at 5.", "the healed row replays the human's answer, not the racer's uncorrelated one");
  });
});

test("recordAdjudication: a UNIQUE-fence collision against an already-known winner is a pure no-op (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await prAdjudications(data).insert({
      pr_key: "o/r#1",
      question_fingerprint: questionFingerprint("Which retry cap?"),
      answer: "Cap at 3.",
      adjudicated_by: "bob",
      adjudicated_kind: "human",
      adjudicated_at: "2025-01-01T00:00:00.000Z",
    });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].adjudicated_by, "bob", "an already-attributed fence winner is immutable");
    assertEquals(rows[0].answer, "Cap at 3.", "the ORIGINAL answer stands");
  });
});

// ── resetAdjudications / invalidateAdjudication: the fresh-run and revert boundary invalidations ────
// (Copilot review of #806). `submitPr` wipes a PR's whole adjudication memory on reopen in ONE atomic
// statement (never a partial row-by-row loop), and a human revert of an auto-applied completion
// invalidates the exact adjudication it replayed so the poller cannot silently re-apply it.

test("resetAdjudications: atomically clears EVERY adjudication for the PR (fresh-run boundary)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which timeout?", answer: "30s", adjudicatedBy: "alice", adjudicatedKind: "human" });
    assertEquals((await findAdj(data, "o/r#1")).length, 2, "two distinct questions were remembered");
    await resetAdjudications(data, "o/r#1");
    assertEquals((await findAdj(data, "o/r#1")).length, 0, "the whole PR's memory is wiped in one statement");
  });
});

test("resetAdjudications: only touches the target PR, not a sibling's memory", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await seedPr("o/r#2");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    await recordAdjudication(data, { prKey: "o/r#2", question: "Which retry cap?", answer: "Cap at 9.", adjudicatedBy: "bob", adjudicatedKind: "human" });
    await resetAdjudications(data, "o/r#1");
    assertEquals((await findAdj(data, "o/r#1")).length, 0);
    assertEquals((await findAdj(data, "o/r#2")).length, 1, "a sibling PR's memory is untouched");
  });
});

test("invalidateAdjudication: TOMBSTONES exactly the replayed row so the poller cannot re-apply it", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which timeout?", answer: "30s", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const rows = await findAdj(data, "o/r#1");
    const target = rows.find((r) => r.answer === "Cap at 5.");
    await invalidateAdjudication(data, target?.id as number);
    const after = await findAdj(data, "o/r#1");
    // The row is NOT deleted — a DELETE would let a redelivered record-answer re-insert the same
    // fingerprint and resurrect the reverted decision. It is tombstoned so UNIQUE still fences.
    assertEquals(after.length, 2, "the reverted row is tombstoned, not deleted (both rows survive)");
    assertEquals(matchAdjudication(after, "Which retry cap?"), undefined, "the tombstoned decision is no longer replayable");
    assertEquals(matchAdjudication(after, "Which timeout?")?.answer, "30s", "the unrelated adjudication still replays");
    // Idempotent — a second call (or a prior reset) is a harmless no-op that does not re-stamp.
    const firstStamp = (await findAdj(data, "o/r#1")).find((r) => r.answer === "Cap at 5.")?.invalidated_at;
    await invalidateAdjudication(data, target?.id as number);
    const secondStamp = (await findAdj(data, "o/r#1")).find((r) => r.answer === "Cap at 5.")?.invalidated_at;
    assertEquals(secondStamp, firstStamp, "a second invalidate leaves the original tombstone stamp untouched");
  });
});

test("invalidateAdjudication: a redelivered record-answer after a revert cannot resurrect the tombstoned decision (#806 review)", async () => {
  // Finding A: a plain DELETE was NOT race-safe — an at-least-once `record-answer` redelivery (same run
  // generation, so the generation guard passes) would re-INSERT the same (pr_key, fingerprint) after the
  // human's revert-delete, and the poller would re-auto-apply the overridden answer. The tombstone keeps
  // the row so UNIQUE fences the re-insert as a no-op and matchAdjudication keeps skipping it.
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const target = (await findAdj(data, "o/r#1")).find((r) => r.answer === "Cap at 5.");
    await invalidateAdjudication(data, target?.id as number);
    // The record-answer job is redelivered with the SAME question+answer (at-least-once semantics).
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const after = await findAdj(data, "o/r#1");
    assertEquals(after.length, 1, "the redelivery is a UNIQUE-fenced no-op — no second row is inserted");
    assert(typeof after[0].invalidated_at === "string" && (after[0].invalidated_at as string).length > 0, "the row stays tombstoned across the redelivery");
    assertEquals(matchAdjudication(after, "Which retry cap?"), undefined, "the reverted decision stays un-replayable — the revert is durable");
  });
});

test("recordAdjudication: stamps source_completion_id linking the decision to its winning completion (#806 review)", async () => {
  // A first-hand agent answer records its own decision (auto_applied=0, no source_adjudication_id); the
  // ONLY link back to the completion that produced it is source_completion_id, so a later revert of that
  // completion can tombstone the decision (invalidateAdjudicationByCompletion). Absent → NULL.
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "bot", adjudicatedKind: "agent", sourceCompletionId: 77 });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which timeout?", answer: "30s", adjudicatedBy: "bot", adjudicatedKind: "agent" });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.find((r) => r.answer === "Cap at 5.")?.source_completion_id, 77, "the winning completion id is stamped");
    assertEquals(rows.find((r) => r.answer === "30s")?.source_completion_id, null, "an absent completion id records NULL");
  });
});

test("recordAdjudication: source_completion_id pins to the ORIGINAL first-hand winner across a later auto-apply re-record (#806 review)", async () => {
  // The first-hand answer records with its completion id; a later auto-apply replays the SAME question
  // and re-records — a UNIQUE no-op that must NOT overwrite the link to the first-hand completion, so a
  // revert of the first-hand completion still finds and tombstones the decision.
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "bot", adjudicatedKind: "agent", sourceCompletionId: 10 });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "bot", adjudicatedKind: "agent", sourceCompletionId: 20 });
    const rows = await findAdj(data, "o/r#1");
    assertEquals(rows.length, 1, "the re-record is a UNIQUE no-op");
    assertEquals(rows[0].source_completion_id, 10, "the link stays pinned to the original first-hand winner");
  });
});

test("invalidateAdjudicationByCompletion: tombstones the decision produced by a specific completion (#806 review)", async () => {
  // The first-hand-agent-revert counterpart to invalidateAdjudication: keyed on source_completion_id
  // (there is no source_adjudication_id for a first-hand answer). Tombstones (not deletes), idempotent,
  // and only touches the row that completion produced.
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "bot", adjudicatedKind: "agent", sourceCompletionId: 88 });
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which timeout?", answer: "30s", adjudicatedBy: "bot", adjudicatedKind: "agent", sourceCompletionId: 99 });
    await invalidateAdjudicationByCompletion(data, 88);
    const after = await findAdj(data, "o/r#1");
    assertEquals(after.length, 2, "the decision is tombstoned, not deleted");
    assertEquals(matchAdjudication(after, "Which retry cap?"), undefined, "the completion's decision is no longer replayable");
    assertEquals(matchAdjudication(after, "Which timeout?")?.answer, "30s", "a decision from a different completion is untouched");
    // Idempotent — a retry after a partial revert re-tombstones as a no-op.
    const firstStamp = (await findAdj(data, "o/r#1")).find((r) => r.answer === "Cap at 5.")?.invalidated_at;
    await invalidateAdjudicationByCompletion(data, 88);
    const secondStamp = (await findAdj(data, "o/r#1")).find((r) => r.answer === "Cap at 5.")?.invalidated_at;
    assertEquals(secondStamp, firstStamp, "a second call leaves the original tombstone stamp untouched");
  });
});

test("invalidateAdjudicationByCompletion: a completion with no linked decision is a no-op (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "bot", adjudicatedKind: "agent", sourceCompletionId: 5 });
    await invalidateAdjudicationByCompletion(data, 404);
    const after = await findAdj(data, "o/r#1");
    assertEquals(matchAdjudication(after, "Which retry cap?")?.answer, "Cap at 5.", "an unrelated completion id tombstones nothing");
  });
});

// --- issue #806 review (round 12): a blank→known HEAL must also stamp `source_completion_id`, else a
// healed decision keeps a NULL link and a revert of the healing first-hand agent completion cannot find
// it via `invalidateAdjudicationByCompletion` — the overridden answer stays replayable and the poller
// re-auto-applies it, silently undoing the human's revert. ---

test("healBlankProvenance: a blank→known heal stamps source_completion_id so the healing completion's revert tombstones it (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    // An uncorrelated (blank-provenance, no completion link) answer lands first.
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 3.", adjudicatedBy: undefined, adjudicatedKind: undefined });
    assertEquals((await findAdj(data, "o/r#1"))[0].source_completion_id, null, "the blank row starts with no completion link");
    // A KNOWN first-hand agent answer (carrying its winning completion id) heals it.
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "bot", adjudicatedKind: "agent", sourceCompletionId: 42 });
    const healed = await findAdj(data, "o/r#1");
    assertEquals(healed.length, 1);
    assertEquals(healed[0].adjudicated_by, "bot", "the blank row is promoted to the known adjudicator");
    assertEquals(healed[0].answer, "Cap at 5.");
    assertEquals(healed[0].source_completion_id, 42, "the healing completion is linked so a revert can find the decision");
    // Reverting that completion now tombstones the promoted decision (before the fix, the NULL link made
    // this a no-op and the overridden answer stayed replayable).
    await invalidateAdjudicationByCompletion(data, 42);
    assertEquals(matchAdjudication(await findAdj(data, "o/r#1"), "Which retry cap?"), undefined, "the reverted decision is no longer replayable");
  });
});

test("healBlankProvenance: an uncorrelated heal (no completion id) preserves an existing link (#806 review)", async () => {
  await withData(async (data, seedPr) => {
    await seedPr("o/r#1");
    // A blank-provenance row that DID carry a completion link (a first-hand answer whose adjudicator was
    // not correlated but whose winning completion was known).
    await prAdjudications(data).insert({
      pr_key: "o/r#1",
      question_fingerprint: questionFingerprint("Which retry cap?"),
      answer: "Cap at 3.",
      adjudicated_by: null,
      adjudicated_kind: null,
      adjudicated_at: "2025-01-01T00:00:00.000Z",
      source_completion_id: 7,
    });
    // A known heal WITHOUT its own completion id must not NULL the existing link (COALESCE preserves it).
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
    const healed = await findAdj(data, "o/r#1");
    assertEquals(healed[0].adjudicated_by, "alice", "the row is promoted");
    assertEquals(healed[0].source_completion_id, 7, "an uncorrelated heal preserves the original completion link");
  });
});
