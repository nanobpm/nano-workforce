// Unit tests for the durable wait-answer adjudication store (issue #806).
//
// The convergence loop must remember a human's answer to a `wait-answer` question so a later
// stateless round that re-derives the IDENTICAL question auto-resumes with it instead of re-parking
// a human. These cover the pure fingerprint match + the INSERT-if-absent persistence, both keyed by
// the CANONICAL `questionFingerprint` (app/github.ts) — the same normaliser/fingerprint advisory acks
// use, so there is no second fingerprint implementation.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { matchAdjudication, type PrAdjudicationRow, recordAdjudication } from "./adjudications.ts";
import { questionFingerprint } from "./github.ts";

function row(over: Partial<PrAdjudicationRow>): PrAdjudicationRow {
  return {
    id: 1,
    pr_key: "o/r#1",
    question_fingerprint: questionFingerprint("Which retry cap?"),
    answer: "Cap at 5.",
    adjudicated_by: "alice",
    adjudicated_at: "2025-01-01T00:00:00.000Z",
    ...over,
  };
}

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

// biome-ignore lint/suspicious/noExplicitAny: in-memory table double, mirrors the other app tests
function memData(seed: any[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.length + 1;
  const data = {
    table(name: string) {
      if (name !== "pr_adjudications") throw new Error(`unexpected table ${name}`);
      return {
        // biome-ignore lint/suspicious/noExplicitAny: see above
        async find(where: any = {}) {
          return rows.filter((r) => Object.entries(where).every(([k, v]) => (r as any)[k] === v));
        },
        // biome-ignore lint/suspicious/noExplicitAny: see above
        async insert(r: any) {
          const id = nextId++;
          rows.push({ id, ...r });
          return id;
        },
        // biome-ignore lint/suspicious/noExplicitAny: see above
        async update(id: number, patch: any) {
          const row = rows.find((r) => r.id === id);
          if (row) Object.assign(row, patch);
        },
      };
    },
  };
  return { data: data as any, rows };
}

test("recordAdjudication: persists one settled row keyed by the canonical fingerprint", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].pr_key, "o/r#1");
  assertEquals(rows[0].question_fingerprint, questionFingerprint("Which retry cap?"));
  assertEquals(rows[0].answer, "Cap at 5.");
  assertEquals(rows[0].adjudicated_by, "alice");
  assertEquals(rows[0].adjudicated_kind, "human", "the adjudicator's kind is preserved for a faithful auto-resume attribution");
  assertEquals(typeof rows[0].adjudicated_at, "string");
});

test("recordAdjudication: INSERT-if-absent — a second answer to the identical question keeps the first", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
  // A later auto-resume re-runs record-answer with the SAME fingerprint (whitespace-variant) — the
  // original adjudicator/answer must survive rather than be overwritten by the auto-apply attribution.
  await recordAdjudication(data, { prKey: "o/r#1", question: "which retry cap?", answer: "Cap at 9.", adjudicatedBy: "auto-applied", adjudicatedKind: "human" });
  assertEquals(rows.length, 1, "no duplicate row for the same (pr, question)");
  assertEquals(rows[0].answer, "Cap at 5.", "the ORIGINAL answer is preserved");
  assertEquals(rows[0].adjudicated_by, "alice", "the ORIGINAL adjudicator is preserved");
});

test("recordAdjudication: a blank answer is not a decision and is not recorded", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "   ", adjudicatedBy: "alice", adjudicatedKind: "human" });
  assertEquals(rows.length, 0);
});

// --- issue #806 review: an UNKNOWN-provenance row (an answer that could not be correlated to an
// adjudicator, recorded with a blank `adjudicated_by`) is not auto-resumable — `pollUserTasks` refuses
// to launder an unattributed replay into a human authority — so it re-parks a human every round. A
// later KNOWN-adjudicator answer to the SAME question must HEAL the row to a replayable decision,
// rather than be dropped by INSERT-if-absent (which would re-park forever). ---

test("recordAdjudication: heals an unknown-provenance row when a known adjudicator later answers (#806 review)", async () => {
  const { data, rows } = memData();
  // Round A: an uncorrelated answer records the decision with UNKNOWN provenance (blank adjudicator).
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 3.", adjudicatedBy: undefined, adjudicatedKind: undefined });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].adjudicated_by, null, "recorded with unknown provenance");
  // Round B: the question re-parked a human (unknown provenance fails open); the human answers, now
  // with a KNOWN adjudicator. The row must be promoted to that human's replayable decision.
  await recordAdjudication(data, { prKey: "o/r#1", question: "which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
  assertEquals(rows.length, 1, "still one row for the same (pr, question)");
  assertEquals(rows[0].adjudicated_by, "alice", "provenance is healed to the known adjudicator");
  assertEquals(rows[0].adjudicated_kind, "human", "the healed row carries the known adjudicator kind");
  assertEquals(rows[0].answer, "Cap at 5.", "the healed row replays the human's answer, not the earlier uncorrelated one");
});

test("recordAdjudication: a KNOWN-provenance row is immutable — a later answer never overwrites it (#806 review)", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
  // A later known-adjudicator answer must NOT overwrite an already-attributed decision.
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 9.", adjudicatedBy: "bob", adjudicatedKind: "human" });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].adjudicated_by, "alice", "the ORIGINAL known adjudicator is preserved");
  assertEquals(rows[0].answer, "Cap at 5.", "the ORIGINAL answer is preserved");
});

test("recordAdjudication: an unknown-provenance row stays unknown when a later answer is also uncorrelated (#806 review)", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 3.", adjudicatedBy: undefined, adjudicatedKind: undefined });
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 7.", adjudicatedBy: "   ", adjudicatedKind: undefined });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].adjudicated_by, null, "no known adjudicator to heal with, so it stays unknown");
  assertEquals(rows[0].answer, "Cap at 3.", "the row is untouched when there is nothing to heal to");
});

test("recordAdjudication: tolerates the UNIQUE fence firing on a concurrent duplicate insert (#806 review)", async () => {
  // The `find`-then-`insert` is racy against `UNIQUE(pr_key, question_fingerprint)`: a redelivered
  // answer job can insert the SAME fingerprint between our (empty) read and our write. Simulate that by
  // making the insert reject with the driver's UNIQUE message — it must be swallowed as the idempotent
  // no-op the sequential path yields (the winner's row is already durable), NOT surfaced as an incident.
  const data = {
    table(name: string) {
      if (name !== "pr_adjudications") throw new Error(`unexpected table ${name}`);
      return {
        async find() {
          return [] as PrAdjudicationRow[];
        },
        async insert() {
          throw new Error("UNIQUE constraint failed: pr_adjudications.pr_key, pr_adjudications.question_fingerprint");
        },
      };
      // biome-ignore lint/suspicious/noExplicitAny: in-memory table double
    },
    // biome-ignore lint/suspicious/noExplicitAny: in-memory table double
  } as any;
  // Must resolve, not throw.
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
});

test("recordAdjudication: a NON-fence insert error still propagates (#806 review)", async () => {
  const data = {
    table() {
      return {
        async find() {
          return [] as PrAdjudicationRow[];
        },
        async insert() {
          throw new Error("disk full");
        },
      };
      // biome-ignore lint/suspicious/noExplicitAny: in-memory table double
    },
    // biome-ignore lint/suspicious/noExplicitAny: in-memory table double
  } as any;
  let threw = false;
  try {
    await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice", adjudicatedKind: "human" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "a non-fence error is not swallowed");
});
