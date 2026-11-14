// pr.reconverge (issue #939): findings on a head-current review hand the PR back to the ONE canonical
// convergence entry (`submitPr`), declaring the merge-loop instance as the hand-off source.
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { makeHandler, type FetchPrHead, type ReadLiveness, type Submit } from "./worker.ts";

// Deterministic liveness stub for hand-off tests: never reach the real GitHub transport.
const openLive: ReadLiveness = async () => "open";
const nullHead = (async () => null) as unknown as FetchPrHead;

// Issue #959: a reconverge hand-off can fire AFTER the PR landed out-of-band (a gate override /
// Mergify / a manual merge). Re-entering `submitPr` on a landed PR would restart a redundant
// convergence loop against a deleted head branch (the nano-bpm#1579 clone incident). The worker must
// instead stamp the row `merged` (so the merge-aware derivation reports `merged`, not `abandoned`,
// when the instance then ends), record the already-merged audit row, and end the loop cleanly — NOT
// reconverge.
test("an already-merged PR ends the loop cleanly instead of reconverging (#959)", async () => {
  const merges: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 0 } : undefined),
        find: async () => [],
        findOne: async () => undefined,
        insert: async (r: Record<string, unknown>) => (merges.push(r), 1),
        update: async (_k: string, patch: Record<string, unknown>) => (updates.push(patch), undefined),
      }),
      source: () => ({ on: () => {}, off: () => {}, emit: () => {} }),
    },
    engine: { createInstance: async () => ({ processInstanceKey: "retro-1" }) },
    log: noopLog(),
  } as any;
  let submitted = false;
  const submit = (async () => {
    submitted = true;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const head = (async () => ({ headRef: "feat/x", headSha: "b".repeat(40), baseRef: "main", headRepo: "acme/w" })) as unknown as FetchPrHead;
  const live: ReadLiveness = async () => "merged";
  const out = await makeHandler(submit, head, live)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  // Ends cleanly — NO reconverge submit, no mergeStatus routing (the loop completes at MergeReconverged).
  assertEquals(submitted, false);
  assertEquals(out, {});
  // The row is stamped landed (merged_at set) so the derivation reports `merged` on termination.
  assert(updates.some((u) => u.status === "merged" && typeof u.merged_at === "string"), "row must be stamped merged");
  // The audit trail carries the already-merged landing (alongside the reconverge-findings record).
  const landing = merges.filter((m) => m.outcome === "merged");
  assertEquals(landing.length, 1);
  assertEquals(landing[0].method, "already-merged");
});

// The guard must NOT fire on a still-open PR: the normal reconverge hand-off proceeds.
test("a still-open PR proceeds with the normal reconverge hand-off", async () => {
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 0 } : undefined),
        insert: async () => 1,
        update: async () => undefined,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let submitted = false;
  const submit = (async () => {
    submitted = true;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const head = (async () => ({ headRef: "feat/x", headSha: "b".repeat(40), baseRef: "main", headRepo: "acme/w" })) as unknown as FetchPrHead;
  const live: ReadLiveness = async () => "open";
  const out = await makeHandler(submit, head, live)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(submitted, true);
  assertEquals(out, {});
});

// An unreadable liveness read (transport hiccup) must not block a genuine reconverge — fail open.
test("an unreadable liveness read falls through to the normal hand-off (fail-open)", async () => {
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 0 } : undefined),
        insert: async () => 1,
        update: async () => undefined,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let submitted = false;
  const submit = (async () => {
    submitted = true;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const head = (async () => ({ headRef: "feat/x", headSha: "b".repeat(40), baseRef: "main", headRepo: "acme/w" })) as unknown as FetchPrHead;
  const live: ReadLiveness = async () => {
    throw new Error("github unreachable");
  };
  await makeHandler(submit, head, live)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(submitted, true);
});

test("re-submits through submitPr with auto-merge on and handoffFrom = this merge-loop instance", async () => {
  const merges: Record<string, unknown>[] = [];
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 1 } : undefined),
        insert: async (r: Record<string, unknown>) => (merges.push(r), 1),
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let args: unknown[] = [];
  const submit = (async (...a: unknown[]) => {
    args = a;
    return { prKey: "acme/w#7" };
  }) as unknown as Submit;
  await makeHandler(submit, nullHead, openLive)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals((args[2] as { prKey: string }).prKey, "acme/w#7");
  assertEquals(args[7], false, "no re-gate on human approval");
  assertEquals(args[8], true, "steward opt-in carried from the row");
  assertEquals(args[9], true, "auto-merge stays on");
  assertEquals(args[10], "4242", "hand-off source is this merge-loop instance");
  assertEquals(merges[0].outcome, "reconverge");
});

// Issue #941 review: `submitPr` can return `processKey: null` after rewriting the row to
// `converging` with no owner (a create-instance failure window). Completing the job successfully
// then ends the merge loop at `MergeReconverged`, leaving the PR with NO live convergence or merge
// instance to advance it. The worker must throw on a null process key so the job stays retryable
// instead of stranding the PR.
test("throws on a null processKey so the hand-off stays retryable (#941)", async () => {
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 0 } : undefined),
        insert: async () => 1,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  const submit = (async () => ({ prKey: "acme/w#7", processKey: null })) as unknown as Submit;
  const err = await assertRejects(
    () => makeHandler(submit, nullHead, openLive)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app),
    Error,
    "null processKey",
  );
  assertStringIncludes(err.message, "acme/w#7");
});

// Issue #941 round-4 review (Copilot "previously missed", high): the world checkpoint is written
// ONLY by the convergence loop's `pr.persist-round` — a merge-stage rebase/fix-ci push advances the
// PR head WITHOUT updating the checkpoint. On a durable-resume fleet a reconverge hand-off that
// re-enters `submitPr` on the checkpoint therefore provisions the fresh convergence agent at the
// PRE-MERGE tree, not the head whose review raised the findings. The hand-off must carry the
// CURRENT PR head SHA as `submitPr`'s restore override.
test("hands off at the CURRENT PR head, not the stale convergence checkpoint (#941 round 4)", async () => {
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 0 } : undefined),
        insert: async () => 1,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let args: unknown[] = [];
  const submit = (async (...a: unknown[]) => {
    args = a;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const head = (async () => ({
    headRef: "feat/x",
    headSha: "b".repeat(40),
    baseRef: "main",
    headRepo: "acme/w",
  })) as unknown as FetchPrHead;
  await makeHandler(submit, head, openLive)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(args[11], "b".repeat(40), "the restore override is the live PR head SHA");
});

test("a head read that resolves no SHA degrades to the checkpoint restore (no override)", async () => {
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 0 } : undefined),
        insert: async () => 1,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let args: unknown[] = [];
  const submit = (async (...a: unknown[]) => {
    args = a;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const head = (async () => null) as unknown as FetchPrHead;
  await makeHandler(submit, head, openLive)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(args[11], null, "no live head SHA → no override (checkpoint restore, the pre-fix behaviour)");
});

// Issue #956 review (Copilot thread 4547353262): a merge-stage reconverge re-enters `submitPr`
// WITHOUT the run's operator custom instructions, so the replacement convergence loop runs
// unsteered (and `submitPr`'s run-scoped reopen resets `custom_instructions` to 0). The worker must
// read the durable text off the PR row (`custom_instructions_text`, stamped by `submitPr`) and pass
// it through, so convergence → merge → reconvergence keeps the steering.
test("preserves the run's custom instructions across the merge→reconvergence handoff (#956)", async () => {
  const app = {
    data: {
      table: (name: string) => ({
        get: async () =>
          name === "pull_requests"
            ? { auto_resolve_escalations: 1, custom_instructions_text: "  commit as josh.wulf@camunda.com  " }
            : undefined,
        insert: async () => 1,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let args: unknown[] = [];
  const submit = (async (...a: unknown[]) => {
    args = a;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const head = (async () => null) as unknown as FetchPrHead;
  await makeHandler(submit, head, openLive)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(args[12], "  commit as josh.wulf@camunda.com  ", "the durable instruction text rides the handoff into the fresh convergence run");
});

test("a PR row with no stored instructions hands off with null (no steering)", async () => {
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { auto_resolve_escalations: 0, custom_instructions_text: null } : undefined),
        insert: async () => 1,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let args: unknown[] = [];
  const submit = (async (...a: unknown[]) => {
    args = a;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const head = (async () => null) as unknown as FetchPrHead;
  await makeHandler(submit, head, openLive)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(args[12], null, "no stored text → null (the fresh run's prompts stay byte-identical to no-instructions)");
});

// A PR closed WITHOUT merging before the hand-off must be settled abandoned via the canonical
// `abandonClosedPr` (row + plan tasks + audit) — never resubmitted into a replacement run.
test("a closed-unmerged PR is abandoned and no replacement run is submitted", async () => {
  const merges: Record<string, unknown>[] = [];
  const prUpdates: Record<string, unknown>[] = [];
  const app = {
    data: {
      table: (name: string) => ({
        get: async () => (name === "pull_requests" ? { pr_key: "acme/w#7", auto_resolve_escalations: 0 } : undefined),
        find: async () => [],
        findOne: async () => null,
        insert: async (r: Record<string, unknown>) => (name === "merges" && merges.push(r), 1),
        update: async (_k: string, patch: Record<string, unknown>) => (name === "pull_requests" && prUpdates.push(patch), undefined),
        upsert: async () => undefined,
      }),
    },
    engine: {},
    log: noopLog(),
  } as any;
  let submitted = false;
  const submit = (async () => {
    submitted = true;
    return { prKey: "acme/w#7", processKey: "999" };
  }) as unknown as Submit;
  const live: ReadLiveness = async () => "closed";
  const out = await makeHandler(submit, nullHead, live)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(submitted, false);
  assertEquals(out, {});
  assert(merges.some((m) => m.outcome === "abandoned" && m.method === "pr-closed"), "closed audit row written");
  assert(prUpdates.some((u) => u.status === "abandoned"), "row settled abandoned");
});
