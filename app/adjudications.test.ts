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
      };
    },
  };
  return { data: data as any, rows };
}

test("recordAdjudication: persists one settled row keyed by the canonical fingerprint", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice" });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].pr_key, "o/r#1");
  assertEquals(rows[0].question_fingerprint, questionFingerprint("Which retry cap?"));
  assertEquals(rows[0].answer, "Cap at 5.");
  assertEquals(rows[0].adjudicated_by, "alice");
  assertEquals(typeof rows[0].adjudicated_at, "string");
});

test("recordAdjudication: INSERT-if-absent — a second answer to the identical question keeps the first", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "Cap at 5.", adjudicatedBy: "alice" });
  // A later auto-resume re-runs record-answer with the SAME fingerprint (whitespace-variant) — the
  // original adjudicator/answer must survive rather than be overwritten by the auto-apply attribution.
  await recordAdjudication(data, { prKey: "o/r#1", question: "which retry cap?", answer: "Cap at 9.", adjudicatedBy: "auto-applied" });
  assertEquals(rows.length, 1, "no duplicate row for the same (pr, question)");
  assertEquals(rows[0].answer, "Cap at 5.", "the ORIGINAL answer is preserved");
  assertEquals(rows[0].adjudicated_by, "alice", "the ORIGINAL adjudicator is preserved");
});

test("recordAdjudication: a blank answer is not a decision and is not recorded", async () => {
  const { data, rows } = memData();
  await recordAdjudication(data, { prKey: "o/r#1", question: "Which retry cap?", answer: "   ", adjudicatedBy: "alice" });
  assertEquals(rows.length, 0);
});
