// Unit coverage for app/issueTriage.ts (issue #896): env readers, fail-closed proposal parsing, and the
// ONE validation derivation every label write goes through.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import {
  type IssueTriageDecision,
  type IssueTriageProposal,
  issueTriageEnabled,
  issueTriageMaxIssues,
  issueTriageRepos,
  MAX_LABELS_PER_ISSUE,
  parseCandidates,
  parseProposals,
  triageReviewQuestion,
  validateProposal,
} from "./issueTriage.ts";

test("issue triage is OFF unless explicitly enabled", () => {
  assertEquals(issueTriageEnabled({}), false);
  assertEquals(issueTriageEnabled({ NANO_ISSUE_TRIAGE: "" }), false);
  assertEquals(issueTriageEnabled({ NANO_ISSUE_TRIAGE: "maybe" }), false);
  assertEquals(issueTriageEnabled({ NANO_ISSUE_TRIAGE: "on" }), true);
  assertEquals(issueTriageEnabled({ NANO_ISSUE_TRIAGE: "TRUE" }), true);
  assertEquals(issueTriageEnabled({ NANO_ISSUE_TRIAGE: "1" }), true);
});

test("repos list is trimmed and deduplicated; the issue cap is clamped", () => {
  assertEquals(issueTriageRepos({ NANO_ISSUE_TRIAGE_REPOS: " a/b, ,c/d,a/b " }), ["a/b", "c/d"]);
  assertEquals(issueTriageRepos({}), []);
  assertEquals(issueTriageMaxIssues({}), 20);
  assertEquals(issueTriageMaxIssues({ NANO_ISSUE_TRIAGE_MAX_ISSUES: "5" }), 5);
  assertEquals(issueTriageMaxIssues({ NANO_ISSUE_TRIAGE_MAX_ISSUES: "0" }), 20);
  assertEquals(issueTriageMaxIssues({ NANO_ISSUE_TRIAGE_MAX_ISSUES: "junk" }), 20);
  assertEquals(issueTriageMaxIssues({ NANO_ISSUE_TRIAGE_MAX_ISSUES: "500" }), 100);
});

test("parseProposals is fail-closed: bad JSON → [], malformed entries skipped, confidence clamped", () => {
  assertEquals(parseProposals("not json"), []);
  assertEquals(parseProposals('{"a":1}'), []);
  assertEquals(parseProposals(undefined), []);
  const parsed = parseProposals(JSON.stringify([
    { repo: "o/r", issue: 1, labels: ["bug", 7], confidence: 1.5, rationale: "crash", duplicateOf: " o/r#9 " },
    { repo: "o/r", issue: "2", labels: ["bug"], confidence: 0.9 },
    { repo: "o/r", issue: 3, labels: "bug", confidence: 0.9 },
    { repo: "o/r", issue: 4, labels: [], confidence: Number.NaN },
    null,
  ]));
  assertEquals(parsed, [{ repo: "o/r", issue: 1, labels: ["bug"], confidence: 1, rationale: "crash", duplicateOf: "o/r#9" }]);
});

test("parseCandidates reads the collect step's JSON-string list", () => {
  const c = { repo: "o/r", issue: 1, title: "t", body: "b", url: "u", labels: ["bug"] };
  assertEquals(parseCandidates([JSON.stringify(c), "junk"]), [c]);
  assertEquals(parseCandidates(JSON.stringify([c])), [c]);
  assertEquals(parseCandidates(null), []);
});

const claimed = new Set(["o/r#1"]);
const repoLabels = ["bug", "enhancement", "documentation", "good first issue", "Question"];
const p = (over: Partial<IssueTriageProposal>): IssueTriageProposal => ({ repo: "o/r", issue: 1, labels: ["bug"], confidence: 0.9, rationale: "", ...over });

test("validateProposal: a confident proposal on a claimed issue is applied with the repo's own spelling", () => {
  assertEquals(validateProposal(p({ labels: ["BUG", "question"] }), claimed, repoLabels), { action: "apply", labels: ["bug", "Question"], dropped: [] });
});

test("validateProposal: the claim fence rejects an issue this run did not collect", () => {
  assertEquals(validateProposal(p({ issue: 2 }), claimed, repoLabels).action, "reject");
  assertEquals(validateProposal(p({ repo: "x/y" }), claimed, repoLabels).action, "reject");
});

test("validateProposal: invented, denied and duplicate labels are dropped; the cap is enforced", () => {
  const v = validateProposal(p({ labels: ["bug", "made-up", "queued", "bug", "enhancement", "documentation", "good first issue"] }), claimed, [...repoLabels, "queued", "dequeued"]);
  assertEquals(v, { action: "apply", labels: ["bug", "enhancement", "documentation"], dropped: ["made-up", "queued", "bug", "good first issue"] });
  assertEquals(MAX_LABELS_PER_ISSUE, 3);
});

test("validateProposal: nothing applicable → reject; queued/dequeued alone never get through", () => {
  assertEquals(validateProposal(p({ labels: ["queued", "Dequeued"] }), claimed, [...repoLabels, "queued", "dequeued"]).action, "reject");
  assertEquals(validateProposal(p({ labels: [] }), claimed, repoLabels).action, "reject");
});

test("validateProposal: low confidence escalates (with the validated labels) instead of applying", () => {
  const v = validateProposal(p({ confidence: 0.5, labels: ["bug", "nope"] }), claimed, repoLabels);
  assertEquals(v.action, "escalate");
  if (v.action === "escalate") assertEquals(v.labels, ["bug"]);
  assertEquals(validateProposal(p({ confidence: 0.7 }), claimed, repoLabels).action, "apply");
});

test("triageReviewQuestion lists each parked proposal; empty → null", () => {
  assertEquals(triageReviewQuestion([]), null);
  const row: IssueTriageDecision = {
    triage_key: "o/r#1", repo: "o/r", issue_number: 1, title: "Crash on start", url: null, status: "escalated",
    labels: '["bug"]', confidence: 0.5, rationale: "maybe a bug", duplicate_of: "o/r#9", reason: null, process_key: "P", created_at: "", updated_at: "",
  };
  const q = triageReviewQuestion([row]) ?? "";
  assertEquals(q.includes("o/r#1 Crash on start → [bug] (confidence 0.50) — possible duplicate of o/r#9: maybe a bug"), true);
});

test("the batched review task surfaces in the Tasks inbox and is HUMAN-only (never agent/steward answerable)", async () => {
  const { userTaskKindLabel } = await import("./userTasks.ts");
  const { ESCALATION_TASK_ELEMENTS, HUMAN_COMPLETABLE_ELEMENTS, escalationFormId } = await import("./agentCompletion.ts");
  const { isStewardAnswerableElement } = await import("./escalationSteward.ts");
  const { ISSUE_TRIAGE_REVIEW_ELEMENT } = await import("./issueTriage.ts");
  assertEquals(userTaskKindLabel(ISSUE_TRIAGE_REVIEW_ELEMENT), "Issue label review");
  assertEquals(HUMAN_COMPLETABLE_ELEMENTS.has(ISSUE_TRIAGE_REVIEW_ELEMENT), true);
  assertEquals(ESCALATION_TASK_ELEMENTS.has(ISSUE_TRIAGE_REVIEW_ELEMENT), false);
  assertEquals(isStewardAnswerableElement(ISSUE_TRIAGE_REVIEW_ELEMENT), false);
  assertEquals(escalationFormId(ISSUE_TRIAGE_REVIEW_ELEMENT), "issue-triage-review");
});
