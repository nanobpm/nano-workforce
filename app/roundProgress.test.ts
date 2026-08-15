// No-progress guard — unit tests for the canonical router (app/roundProgress.ts), the
// pr.progress-check worker, and a structural guard over the committed convergence-loop BPMN.
//
// The convergence loop used to trust the agent's self-reported `addressed` status to trigger the
// next Copilot review round. An agent could return `addressed` (or fall back to the safe default)
// WITHOUT pushing a commit, so Copilot re-reviewed byte-identical code and the loop burned rounds
// making no progress until the round cap escalated. The fix inserts a deterministic
// `pr.progress-check` step that compares the PR head SHA across rounds and routes an `addressed`
// round whose head did not advance to the human `wait-answer` escalation instead of another review.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import { routeProgress } from "./roundProgress.ts";

// ── The canonical router ────────────────────────────────────────────────────

test("routeProgress: an addressed round whose head did not advance escalates", () => {
  assertEquals(routeProgress("addressed", "sha-1", "sha-1"), "escalate");
});

test("routeProgress: an addressed round whose head advanced continues", () => {
  assertEquals(routeProgress("addressed", "sha-1", "sha-2"), "continue");
});

test("routeProgress: an explicit non-addressed round always continues (no push is expected)", () => {
  // These are the statuses gw-status routes AWAY from the addressed/default arm — a legit no-push
  // round. They always continue regardless of the head.
  for (const status of ["waiting", "converged", "needs_input", "blocked"]) {
    assertEquals(
      routeProgress(status, "sha-1", "sha-1"),
      "continue",
      `status ${JSON.stringify(status)} must continue even with an unchanged head`,
    );
  }
});

test("routeProgress: blank/unknown status behaves like addressed (the safe-default trap)", () => {
  // gw-status defaults blank/unknown/unrecognized status down the addressed arm and pr.persist-round
  // records a missing status as `addressed`, so the no-progress guard must apply to them too: an
  // unchanged head escalates, an advanced head continues.
  for (const status of [undefined, null, "", "x"]) {
    assertEquals(
      routeProgress(status, "sha-1", "sha-1"),
      "escalate",
      `blank/unknown status ${JSON.stringify(status)} with an unchanged head must escalate like addressed`,
    );
    assertEquals(
      routeProgress(status, "sha-1", "sha-2"),
      "continue",
      `blank/unknown status ${JSON.stringify(status)} with an advanced head must continue`,
    );
  }
});

test("routeProgress: fails OPEN when either head is unknown (no baseline / unreadable head)", () => {
  for (const [prev, cur] of [
    [null, "sha-1"],
    [undefined, "sha-1"],
    ["sha-1", null],
    ["sha-1", undefined],
    [null, null],
  ] as const) {
    assertEquals(
      routeProgress("addressed", prev, cur),
      "continue",
      `unknown head (${JSON.stringify(prev)} -> ${JSON.stringify(cur)}) must fail open`,
    );
  }
});

// ── The worker (with an injected head reader — never touches git/network) ────

function fakeApp(row?: { last_round_head: string | null }) {
  const updates: { key: string; patch: Record<string, unknown> }[] = [];
  const store = new Map<string, unknown>();
  if (row) store.set("o/r#1", { pr_key: "o/r#1", ...row });
  const app = {
    data: {
      table(_name: string, _key: string) {
        return {
          async get(key: string) {
            return store.get(key);
          },
          async update(key: string, patch: Record<string, unknown>) {
            updates.push({ key, patch });
          },
        };
      },
    },
  };
  return { app, updates };
}

async function makeUnderTest(readHead: (repo: string, n: number) => Promise<string | null>) {
  const { makeHandler } = await import("../workers/progress-check/worker.ts");
  return makeHandler({ readHead });
}

test("progress-check: skips the head read entirely for a non-addressed round", async () => {
  let called = false;
  const handler = await makeUnderTest(async () => {
    called = true;
    return "sha-2";
  });
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "waiting", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: true });
  assertEquals(called, false, "a waiting round never reads the head");
  assertEquals(updates.length, 0, "and never rewrites the baseline");
});

test("progress-check: a blank/unknown status is treated as addressed — reads the head and can report no progress", async () => {
  let called = false;
  const handler = await makeUnderTest(async () => {
    called = true;
    return "sha-1";
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: false }, "a blank-status no-progress round is caught, not waved through");
  assertEquals(called, true, "a blank status (the safe-default addressed trap) still reads the head");
});

test("progress-check: an addressed round whose head is unchanged reports progressed:false", async () => {
  const handler = await makeUnderTest(async () => "sha-1");
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: false });
});

test("progress-check: an addressed round whose head advanced reports progressed:true and rebaselines", async () => {
  const handler = await makeUnderTest(async () => "sha-2");
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: true });
  assertEquals(updates.length, 1, "the observed head is recorded as the new baseline");
  assertEquals(updates[0]!.patch.last_round_head, "sha-2");
});

test("progress-check: the first observed round (no baseline) continues and records the baseline", async () => {
  const handler = await makeUnderTest(async () => "sha-1");
  const { app, updates } = fakeApp(); // no row yet -> previousHead null
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: true }, "no baseline yet fails open");
  assertEquals(updates[0]!.patch.last_round_head, "sha-1");
});

test("progress-check: an unreadable head fails open and does not clobber the baseline", async () => {
  const handler = await makeUnderTest(async () => null);
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: true }, "a null head fails open");
  assertEquals(updates.length, 0, "a null head never overwrites the good baseline");
});

test("progress-check: resolves repo/prNumber from the prKey when the vars are absent", async () => {
  let seen: [string, number] | null = null;
  const handler = await makeUnderTest(async (repo, n) => {
    seen = [repo, n];
    return "sha-2";
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  await handler({ variables: { prKey: "o/r#1", status: "addressed" } } as any, app as any);
  assertEquals(seen, ["o/r", 1], "falls back to parsing owner/repo#N from the prKey");
});

// ── Structural guard over the committed BPMN (no engine) ─────────────────────

const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

function flowElement(id: string): string | null {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*?\\bid="${id}"[^>]*?(?:/>|>(?:(?!<bpmn:sequenceFlow\\b).)*?</bpmn:sequenceFlow>)`,
  );
  const m = flat.match(re);
  return m ? m[0] : null;
}

test("persist-round routes through check-progress before the review wait", () => {
  const f = flowElement("f_roundWait");
  assert(f, "f_roundWait flow missing");
  assertStringIncludes(f, 'sourceRef="persist-round"');
  assertStringIncludes(f, 'targetRef="check-progress"');
});

test("check-progress feeds the gw-progress gateway", () => {
  const f = flowElement("f_checkGate");
  assert(f, "f_checkGate flow missing");
  assertStringIncludes(f, 'sourceRef="check-progress"');
  assertStringIncludes(f, 'targetRef="gw-progress"');
  // The task runs the deterministic no-progress guard job.
  assertStringIncludes(flat, 'type="pr.progress-check"');
});

test("gw-progress escalates a no-progress round on an explicit progressed = false condition", () => {
  const f = flowElement("f_noProgress");
  assert(f, "f_noProgress flow missing");
  assertStringIncludes(f, 'targetRef="persist-escalation-noprogress"');
  assertStringIncludes(f, "progressed = false");
});

test("gw-progress default arm re-enters the review wait with no condition", () => {
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-progress"[^>]*>/);
  assert(gw, "gw-progress gateway missing");
  assertStringIncludes(gw[0], 'default="f_progressOk"');
  const ok = flowElement("f_progressOk");
  assert(ok, "f_progressOk flow missing");
  assertStringIncludes(ok, 'targetRef="gw-review-wait"');
  assert(!/conditionExpression/.test(ok), "the default arm must carry no conditionExpression");
});

test("the no-progress escalation lands on the human wait-answer task", () => {
  const f = flowElement("f_noprogressWait");
  assert(f, "f_noprogressWait flow missing");
  assertStringIncludes(f, 'sourceRef="persist-escalation-noprogress"');
  assertStringIncludes(f, 'targetRef="wait-answer"');
  // It opens a real, answerable escalation (blocked status + a concrete question) so it is never a
  // blank-question non-escalation that would wedge the token on the wait.
  const task = flat.match(
    /<bpmn:serviceTask\b[^>]*\bid="persist-escalation-noprogress"[^>]*>.*?<\/bpmn:serviceTask>/,
  );
  assert(task, "persist-escalation-noprogress task missing");
  assertStringIncludes(task[0], 'type="pr.persist-escalation"');
  assertStringIncludes(task[0], 'target="status"');
  assertStringIncludes(task[0], 'target="question"');
  // It must NOT double-record the round persist-round already recorded.
  assertStringIncludes(task[0], 'target="recordRound"');
});
