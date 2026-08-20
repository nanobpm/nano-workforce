// pr.converge-gate — the human-override door for the scope-integrity block (issue #395).
//
// The scope-integrity gate re-derives `scopeBlocked` from the PR body every converged round. Before
// this fix, answering its escalation re-entered the loop, the gate re-blocked identically, and the
// operator was trapped in an infinite escalation (a fresh escalationId each cycle) — the only escape
// was mangling the PR body into a non-closing ref. These tests pin the override door: an escalation
// answer bound to the SAME reviewed HEAD satisfies the gate (audited), a different HEAD (a new push)
// re-opens it, and an unreadable HEAD keeps the block (fail closed).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { makeHandler } from "./worker.ts";

// A PR body that trips the scope-integrity guard: it defers scope (`## Scope`) yet closes a
// broader-scoped parent (`Closes #631`) and links no filed follow-up.
const SCOPE_BLOCKING_BODY =
  "Delivers the first half.\n\n## Scope\nThe embedded tools remain the deferred refinement.\n\nCloses #631";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory app double, mirrors persist-escalation.test
function fakeApp(escalations: Record<string, unknown>[]): any {
  const stores: Record<string, Record<string, unknown>[]> = { escalations };
  return {
    stores,
    data: {
      table(name: string, key: string) {
        const store = (stores[name] ??= []);
        return {
          // biome-ignore lint/suspicious/noExplicitAny: test double
          find: (q: any) => Promise.resolve(store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
        };
      },
    },
    log: noopLog(),
  };
}

function deps(overrides: {
  headSha?: string | null;
  prBody?: string;
  headThrows?: boolean;
}) {
  const headSha = "headSha" in overrides ? (overrides.headSha ?? null) : "HEAD1";
  return {
    readThreads: () => Promise.resolve([]),
    readReviewBody: () => Promise.resolve(""),
    readPrBody: () => Promise.resolve(overrides.prBody ?? SCOPE_BLOCKING_BODY),
    readHeadSha: () => (overrides.headThrows ? Promise.reject(new Error("gh down")) : Promise.resolve(headSha)),
  };
}

const job = { variables: { prKey: "o/r#5", repo: "o/r", prNumber: 5 } } as never;

test("scope blocks with no answered escalation → blocked, and surfaces the reviewed HEAD to bind the escalation", async () => {
  const app = fakeApp([]);
  const out = (await makeHandler(deps({ headSha: "HEAD1" }))(job, app)) as Record<string, unknown>;
  assertEquals(out.convergeBlocked, true);
  assertEquals(out.scopeBlocked, true);
  assertEquals(out.headSha, "HEAD1", "the reviewed HEAD is returned so persist-escalation can bind it");
});

test("scope blocks but a human answered the escalation for the SAME HEAD → override honoured (loop broken)", async () => {
  const app = fakeApp([
    { id: 7, pr_key: "o/r#5", status: "answered", scope_block: 1, head_sha: "HEAD1", answer: "Full delivery — keep Closes." },
  ]);
  const out = (await makeHandler(deps({ headSha: "HEAD1" }))(job, app)) as Record<string, unknown>;
  assertEquals(out.convergeBlocked, false, "the same-HEAD human answer satisfies the scope gate");
  assertEquals(out.convergeBlockReason, "");
  // A cleared scope block routes to finalize, so the block-only binding fields are not emitted.
  assertEquals(out.scopeBlocked, undefined);
});

test("scope blocks and the answer was for a DIFFERENT HEAD (a new push) → still blocked", async () => {
  const app = fakeApp([
    { id: 7, pr_key: "o/r#5", status: "answered", scope_block: 1, head_sha: "OLDHEAD", answer: "Full delivery." },
  ]);
  const out = (await makeHandler(deps({ headSha: "HEAD1" }))(job, app)) as Record<string, unknown>;
  assertEquals(out.convergeBlocked, true, "a stale override never carries across a new push");
  assertEquals(out.scopeBlocked, true);
});

test("scope blocks and an answered NON-scope escalation sits at the same HEAD → not an override", async () => {
  const app = fakeApp([
    { id: 7, pr_key: "o/r#5", status: "answered", scope_block: 0, head_sha: "HEAD1", answer: "unrelated" },
  ]);
  const out = (await makeHandler(deps({ headSha: "HEAD1" }))(job, app)) as Record<string, unknown>;
  assertEquals(out.convergeBlocked, true, "only a scope-integrity escalation opens the scope override door");
});

test("scope blocks but the reviewed HEAD is unreadable → keep the block (fail closed)", async () => {
  const app = fakeApp([
    { id: 7, pr_key: "o/r#5", status: "answered", scope_block: 1, head_sha: "HEAD1", answer: "override" },
  ]);
  const nullHead = (await makeHandler(deps({ headSha: null }))(job, app)) as Record<string, unknown>;
  assertEquals(nullHead.convergeBlocked, true, "cannot verify an override against an unknown HEAD");
  const throwHead = (await makeHandler(deps({ headThrows: true }))(job, app)) as Record<string, unknown>;
  assertEquals(throwHead.convergeBlocked, true, "a HEAD read error keeps the block");
});

test("scope passes → not blocked, and no override lookup is needed", async () => {
  const app = fakeApp([]);
  const out = (await makeHandler(deps({ prBody: "Implements the whole thing.\n\nCloses #631" }))(job, app)) as Record<
    string,
    unknown
  >;
  assertEquals(out.convergeBlocked, false);
  assertEquals(out.scopeBlocked, undefined);
});

test("newest answered scope escalation wins when a re-escalation was answered again at the same HEAD", async () => {
  const app = fakeApp([
    { id: 7, pr_key: "o/r#5", status: "answered", scope_block: 1, head_sha: "HEAD1", answer: "first" },
    { id: 9, pr_key: "o/r#5", status: "answered", scope_block: 1, head_sha: "HEAD1", answer: "latest" },
  ]);
  const out = (await makeHandler(deps({ headSha: "HEAD1" }))(job, app)) as Record<string, unknown>;
  assertEquals(out.convergeBlocked, false, "a re-answered override at the unchanged HEAD is honoured");
});
