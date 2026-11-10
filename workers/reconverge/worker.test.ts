// pr.reconverge (issue #939): findings on a head-current review hand the PR back to the ONE canonical
// convergence entry (`submitPr`), declaring the merge-loop instance as the hand-off source.
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { makeHandler, type FetchPrHead, type Submit } from "./worker.ts";

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
  await makeHandler(submit)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
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
    () => makeHandler(submit)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app),
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
  await makeHandler(submit, head)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
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
  await makeHandler(submit, head)({ processInstanceKey: "4242", variables: { prKey: "acme/w#7" } } as any, app);
  assertEquals(args[11], null, "no live head SHA → no override (checkpoint restore, the pre-fix behaviour)");
});
