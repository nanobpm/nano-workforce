// Operator feedback (issue #985): trusted-human issue/PR comments and review threads posted after a run
// starts must reach the round agent and gate convergence until acknowledged.
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import { evaluateConvergeGate } from "./convergeGate.ts";
import { type IssueComment, listIssueComments } from "./issuePrLink.ts";
import {
  CLAIM_COMMENT_PREFIX,
  deriveOperatorFeedback,
  feedbackAckMarker,
  IMPLEMENT_FEEDBACK_CHECKPOINTS,
  issueReadCommand,
  parseClosingIssueNumbers,
  renderOperatorFeedbackBrief,
  runStartOnIssue,
} from "./operatorFeedback.ts";

const c = (id: number, login: string, association: string, createdAt: string, body: string): IssueComment => ({
  id,
  login,
  association,
  createdAt,
  body,
});

const START = "2026-11-21T10:00:00Z";
const claim = c(1, "jwulf", "OWNER", START, `${CLAIM_COMMENT_PREFIX} — branch \`feat/issue-9\`.`);

function derive(issueComments: IssueComment[], prComments: IssueComment[] = []) {
  const comments = [claim, ...issueComments];
  return deriveOperatorFeedback({
    repo: "o/r",
    issues: [{ number: 9, comments, since: runStartOnIssue(comments, null) }],
    prComments,
    threads: [],
  });
}

test("an unacknowledged post-start trusted issue comment blocks convergence (ack-only route)", () => {
  const items = derive([c(42, "jwulf", "OWNER", "2026-11-21T10:05:00Z", "also update the docs")]);
  assertEquals(items.length, 1);
  assertEquals(items[0].id, 42);
  const gate = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [],
    acknowledgedKeys: [],
    operatorFeedback: items.map((i) => ({ label: i.label })),
  });
  assertEquals(gate.convergeBlocked, true);
  assertEquals(gate.ackOnly, true);
  assertStringIncludes(gate.convergeBlockReason, "issuecomment-42");
  assertStringIncludes(renderOperatorFeedbackBrief(items), "nano-ack: issuecomment-42");
});

test("an acknowledged operator comment passes (ack on the issue or on the PR)", () => {
  const fb = c(42, "jwulf", "OWNER", "2026-11-21T10:05:00Z", "also update the docs");
  assertEquals(derive([fb, c(43, "jwulf", "OWNER", "2026-11-21T10:09:00Z", "Done.\nnano-ack: issuecomment-42")]), []);
  assertEquals(derive([fb], [c(77, "jwulf", "OWNER", "2026-11-21T10:09:00Z", "nano-ack: issuecomment-42")]), []);
  const gate = evaluateConvergeGate({ unresolvedThreadCount: 0, suppressedAdvisories: [], acknowledgedKeys: [], operatorFeedback: [] });
  assertEquals(gate.convergeBlocked, false);
});

test("pre-start, bot, untrusted and the run's own comments are ignored", () => {
  assertEquals(
    derive([
      c(10, "jwulf", "OWNER", "2026-11-21T09:00:00Z", "old scope note"),
      c(11, "copilot-swe-agent[bot]", "NONE", "2026-11-21T10:05:00Z", "bot noise"),
      c(12, "rando", "NONE", "2026-11-21T10:05:00Z", "drive-by"),
      c(13, "jwulf", "OWNER", "2026-11-21T10:06:00Z", "🤖 Pull request opened: #5\n\n<!-- nwf:pr-linked:#5 x -->"),
    ]),
    [],
  );
});

test("a PR conversation comment and a trusted review thread are operator feedback; a Copilot thread is not", () => {
  const items = deriveOperatorFeedback({
    repo: "o/r",
    issues: [],
    prComments: [c(50, "maint", "MEMBER", "2026-11-21T11:00:00Z", "please rename this")],
    threads: [
      { isResolved: false, path: "a.ts", bodies: ["nit"], rootLogin: "maint", rootAssociation: "COLLABORATOR" },
      { isResolved: false, path: "b.ts", bodies: ["x"], rootLogin: "Copilot", rootAssociation: "NONE" },
      { isResolved: true, path: "c.ts", bodies: ["y"], rootLogin: "maint", rootAssociation: "MEMBER" },
    ],
  });
  assertEquals(
    items.map((i) => i.source),
    ["pr", "thread"],
  );
});

test("only CLOSING-keyword issues are scanned (an epic slice's `Part of #N` parent is advisory)", () => {
  assertEquals(parseClosingIssueNumbers("feat: x\n\nCloses #9\nPart of #3\nFixes o/r#11\nResolves x/y#12", "o/r"), [9, 11]);
});

test("pagination: comments beyond the first 100 are read (the ONE issue-comments pager)", async () => {
  const prevT = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevF = globalThis.fetch;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  const mk = (id: number) => ({ id, body: `c${id}`, user: { login: "jwulf" }, author_association: "OWNER", created_at: START });
  // biome-ignore lint/plugin: test stub for the fetch boundary
  globalThis.fetch = (async (url: string | URL | Request) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    const arr = page === 1 ? Array.from({ length: 100 }, (_, i) => mk(i + 1)) : page === 2 ? [mk(101)] : [];
    return new Response(JSON.stringify(arr), { status: 200 });
  }) as typeof fetch;
  try {
    const all = await listIssueComments("o/r", 9, "tok");
    assert(all !== null);
    assertEquals(all.length, 101);
    assertEquals(all[100].id, 101);
  } finally {
    globalThis.fetch = prevF;
    if (prevT === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prevT;
  }
});

// Defect-class guard: EVERY agent-facing issue-read instruction must read comments. Plain
// `gh issue view` prints only a comment count (#985). A `--json` read selects explicit fields.
test("every agent-facing `gh issue view` instruction carries --comments", () => {
  assertEquals(issueReadCommand(9, "o/r"), "gh issue view 9 -R o/r --comments");
  const files = [
    ...readdirSync("resources/prompts").map((f) => `resources/prompts/${f}`),
    "app/feature.ts",
  ];
  const offenders: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/`gh issue view([^`]*)`/g)) {
      if (!/--comments|--json/.test(m[1])) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assertEquals(offenders, []);
});

test("the review-round agent's appendPrompt injects the converge gate's operatorFeedbackBrief", () => {
  const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");
  const round = bpmn.slice(bpmn.indexOf('id="review-round"'), bpmn.indexOf("</bpmn:serviceTask>", bpmn.indexOf('id="review-round"')));
  assertStringIncludes(round, "operatorFeedbackBrief");
  assertStringIncludes(bpmn, '<nano:extend name="operatorFeedbackBrief"');
});

test("an ack forged by an untrusted commenter does not clear feedback", () => {
  const fb = c(42, "jwulf", "OWNER", "2026-11-21T10:05:00Z", "also update the docs");
  assertEquals(derive([fb, c(43, "rando", "NONE", "2026-11-21T10:09:00Z", "nano-ack: issuecomment-42")]).map((i) => i.id), [42]);
  assertEquals(derive([fb], [c(77, "rando", "NONE", "2026-11-21T10:09:00Z", "nano-ack: issuecomment-42")]).map((i) => i.id), [42]);
  assertEquals(derive([fb], [c(78, "bot[bot]", "MEMBER", "2026-11-21T10:09:00Z", "nano-ack: issuecomment-42")]).map((i) => i.id), [42]);
  // A review-thread reply is not an ack source (no per-reply authorship).
  const items = deriveOperatorFeedback({
    repo: "o/r",
    issues: [],
    prComments: [c(50, "maint", "MEMBER", "2026-11-21T11:00:00Z", "please rename this")],
    threads: [{ isResolved: false, path: "a.ts", bodies: ["x", "nano-ack: issuecomment-50"], rootLogin: "Copilot", rootAssociation: "NONE" }],
  });
  assertEquals(items.map((i) => i.id), [50]);
});

test("a mentioned or quoted ack marker is new feedback, not an ack", () => {
  const fb = c(42, "jwulf", "OWNER", "2026-11-21T10:05:00Z", "also update the docs");
  const followUp = c(44, "jwulf", "OWNER", "2026-11-21T10:10:00Z", "You posted nano-ack: issuecomment-42, but the docs are still missing");
  assertEquals(derive([fb, followUp]).map((i) => i.id), [42, 44]);
  const quoted = c(45, "jwulf", "OWNER", "2026-11-21T10:11:00Z", "> nano-ack: issuecomment-42\nnot done");
  assertEquals(derive([fb, quoted]).map((i) => i.id), [42, 45]);
});

test("URL-form closing references are parsed through the issue grammar", () => {
  assertEquals(
    parseClosingIssueNumbers("Closes https://github.com/o/r/issues/9\nFixes https://github.com/x/y/issues/3\nResolves https://github.com/o/r/pull/4", "o/r"),
    [9],
  );
});

test("runStartOnIssue ignores claim-prefixed comments from untrusted authors and bots (fallback wins)", () => {
  const fallback = "2026-11-21T09:00:00Z";
  const late = "2026-11-21T12:00:00Z";
  const body = `${CLAIM_COMMENT_PREFIX} — branch \`feat/issue-9\`.`;
  assertEquals(runStartOnIssue([c(5, "outsider", "NONE", late, body)], fallback), fallback);
  assertEquals(runStartOnIssue([c(6, "someone", "CONTRIBUTOR", late, body)], fallback), fallback);
  assertEquals(runStartOnIssue([c(7, "github-actions[bot]", "MEMBER", late, body)], fallback), fallback);
  // A trusted claim still sets the cutoff, even alongside an untrusted one.
  assertEquals(runStartOnIssue([c(5, "outsider", "NONE", START, body), c(1, "jwulf", "OWNER", late, body)], fallback), late);
});

// Issue #986: a running implementation agent re-reads the issue at fixed checkpoints, before the PR.
test("feature prompt renders exactly the canonical implement-feedback checkpoints, with the ack marker", () => {
  const md = readFileSync("resources/prompts/feature.md", "utf8");
  const block = md.slice(md.indexOf("<!-- checkpoints:begin -->"), md.indexOf("<!-- checkpoints:end -->"));
  const ids = [...block.matchAll(/\*\*([a-z-]+)\*\*/g)].map((m) => m[1]);
  assertEquals(ids, [...IMPLEMENT_FEEDBACK_CHECKPOINTS]);
  assertStringIncludes(md, feedbackAckMarker(0).replace("0", "<id>"));
  assertStringIncludes(md, "author_association");
});

test("a comment posted mid-implement and acked on the issue before the PR opens does not gate", () => {
  const mid = c(60, "jwulf", "OWNER", "2026-11-21T10:30:00Z", "stop — X already exists, reuse it");
  assertEquals(derive([mid]).map((i) => i.id), [60]);
  const ack = c(61, "jwulf", "OWNER", "2026-11-21T10:40:00Z", `${feedbackAckMarker(60)}\nreused X`);
  assertEquals(derive([mid, ack]), []);
});
