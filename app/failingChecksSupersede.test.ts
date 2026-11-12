// Derivation-layer guard for the CI-concurrency-cancellation drift class (issue #348).
//
// GitHub's CI concurrency cancels a superseded workflow run while a newer run on the *identical
// head SHA* takes over. Both land in the head's `statusCheckRollup` under the same check name — the
// stale one stamped `CANCELLED`, the live one green. The merge poller's check derivation used to
// count that stale `CANCELLED` as a failing required check, so a PR whose head is actually green
// read as `blocked`, armed `senior:fix-ci`, which honestly pushed nothing and (pre-#348) returned
// `blocked` → a human merge-escalation for a self-healing PR.
//
// The fix collapses the rollup to the NEWEST run per check before classifying, so a superseded
// `CANCELLED` never counts. These are pure unit tests over the exported derivation helpers.

import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { allCheckNames, applyRollupEvents, checkConclusions, checkGateConclusions, failingCheckNames, latestRunPerCheck } from "./github.ts";

test("a CANCELLED run superseded by a newer green run on the same head does not count as failing", () => {
  const rollup = [
    // The superseded run: GitHub CI concurrency cancelled it when a newer run started.
    { name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z", completedAt: "2024-01-01T00:01:00Z" },
    // The live run on the identical head SHA: green.
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z", completedAt: "2024-01-01T00:05:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "the stale CANCELLED must not read as a failing gate");
});

test("every CANCELLED-superseded required check on one head SHA is dropped (the #348 instance)", () => {
  // The exact PR #887 evidence: four required checks each with a superseded CANCELLED + a newer
  // green run on the same head. None must count as failing.
  const names = ["engine-core", "engine-wasm read-model wasm32 type-check", "processos", "server"];
  const rollup = names.flatMap((name) => [
    { name, conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name, conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
  ]);
  assertEquals(failingCheckNames(rollup), [], "no superseded CANCELLED may count as a failing check");
});

test("a genuine failure on the newest run still counts (no false-negative)", () => {
  const rollup = [
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:00:00Z" },
    // Newest run genuinely failed — this must still be reported.
    { name: "engine-core", conclusion: "FAILURE", startedAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), ["engine-core"], "a real failure on the newest run must count");
});

test("a lone CANCELLED with no superseding run still counts (nothing green replaced it)", () => {
  const rollup = [{ name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" }];
  assertEquals(failingCheckNames(rollup), ["engine-core"], "an unsuperseded CANCELLED remains a failing gate");
});

test("ties (missing timestamps) prefer the non-CANCELLED run so the real result wins", () => {
  // GitHub sometimes omits run times; a superseded CANCELLED alongside a completed run must not
  // shadow the real conclusion even when neither carries a timestamp.
  const cancelledFirst = [
    { name: "server", conclusion: "CANCELLED" },
    { name: "server", conclusion: "SUCCESS" },
  ];
  const successFirst = [
    { name: "server", conclusion: "SUCCESS" },
    { name: "server", conclusion: "CANCELLED" },
  ];
  assertEquals(failingCheckNames(cancelledFirst), [], "CANCELLED-first tie resolves to the real (green) result");
  assertEquals(failingCheckNames(successFirst), [], "success-first tie keeps the real (green) result");
});

test("latestRunPerCheck keeps exactly one run per check name (newest)", () => {
  const rollup = [
    { name: "a", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name: "a", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
    { name: "b", conclusion: "FAILURE", startedAt: "2024-01-01T00:00:00Z" },
  ];
  const latest = latestRunPerCheck(rollup);
  assertEquals(latest.length, 2, "one run per distinct check name");
  const a = latest.find((c) => c.name === "a");
  assert(a && a.conclusion === "SUCCESS", "check `a` resolves to its newest (green) run");
});

test("allCheckNames dedupes superseded reruns to a single name", () => {
  const rollup = [
    { name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(allCheckNames(rollup), ["engine-core"], "a superseded rerun must not double-list the check name");
});

test("legacy StatusContext (state + context) supersession is handled by createdAt", () => {
  const rollup = [
    { context: "ci/legacy", state: "ERROR", createdAt: "2024-01-01T00:00:00Z" },
    { context: "ci/legacy", state: "SUCCESS", createdAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "a superseded legacy status context is not a failing gate");
});

// ── Issue #955: same display name, DIFFERENT triggering events — not the same gate ──────────────
//
// One workflow file with both `pull_request` and `push` jobs named `build` puts TWO runs named
// `build` on the same head SHA. They are different gates: the ruleset / branch-protection required
// context gates the `pull_request` run, so a red PR `build` must never be collapsed away by a newer
// green push `build` (camunda/console-api-js#17: the collapse hid the red required check, the merge
// loop classified `waiting`, and `senior:fix-ci` never ran).

test("#955: a red pull_request `build` is not collapsed away by a newer green push `build`", () => {
  const rollup = [
    // The required gate: PR-event run, failed (biome check on CHANGELOG.md), completed 00:41:34Z.
    { name: "build", event: "pull_request", conclusion: "FAILURE", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:41:34Z" },
    // A different gate sharing the display name: push-event run, green, completed 4s later.
    { name: "build", event: "push", conclusion: "SUCCESS", startedAt: "2026-11-12T00:41:30Z", completedAt: "2026-11-12T00:41:38Z" },
  ];
  assertEquals(
    failingCheckNames(rollup),
    ["build"],
    "the red required pull_request run must survive the collapse — a green push job must not satisfy it",
  );
  assertEquals(
    checkConclusions(rollup).build,
    "FAILURE",
    "the gate's conclusion is the red pull_request run's, so requiredChecksVerdict sees the failure",
  );
});

test("#955: the #348 collapse still holds WITHIN one event — a cancelled rerun of the same job collapses", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "CANCELLED", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:31:00Z" },
    { name: "build", event: "pull_request", conclusion: "SUCCESS", startedAt: "2026-11-12T00:32:00Z", completedAt: "2026-11-12T00:35:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "a CANCELLED rerun of the SAME workflow/event still collapses to the newest run");
  assertEquals(checkConclusions(rollup).build, "SUCCESS");
});

test("#955: a green pull_request run does not mask a red push run of the same name (symmetric)", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "SUCCESS", startedAt: "2026-11-12T00:41:30Z", completedAt: "2026-11-12T00:41:38Z" },
    { name: "build", event: "push", conclusion: "FAILURE", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:41:34Z" },
  ];
  assertEquals(failingCheckNames(rollup), ["build"], "any non-superseded failed run of the name fails the gate");
});

test("#955: distinct events keep both runs in latestRunPerCheck (one per gate, not one per name)", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "FAILURE", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", event: "push", conclusion: "SUCCESS", completedAt: "2026-11-12T00:41:38Z" },
  ];
  const latest = latestRunPerCheck(rollup);
  assertEquals(latest.length, 2, "two different gates sharing a name must both survive");
});

test("#955: runs without event identity keep the pre-#955 name-only collapse (legacy shapes unchanged)", () => {
  // A rollup whose entries carry no `event` (older gh, a StatusContext-only head) collapses exactly
  // as before: same name → newest run wins.
  const rollup = [
    { name: "build", conclusion: "FAILURE", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", conclusion: "SUCCESS", completedAt: "2026-11-12T00:41:38Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "no event identity → the name-only #348 collapse is unchanged");
  assertEquals(latestRunPerCheck(rollup).length, 1);
});

test("#955: allCheckNames still reports the display name once when events differ", () => {
  const rollup = [
    { name: "build", event: "pull_request", conclusion: "FAILURE", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", event: "push", conclusion: "SUCCESS", completedAt: "2026-11-12T00:41:38Z" },
  ];
  assertEquals(allCheckNames(rollup), ["build"], "presence is by required-context name, not per (name, event) pair");
});

// ── PR #957 review: the gate key must be an unambiguous tuple ────────────────────────────────────
//
// A bare `name + event` concatenation lets two DIFFERENT identities collide: `name:"build",
// event:"push"` and an event-less `context:"buildpush"` both produce `"buildpush"`, so a newer green
// entry could discard an unrelated red check (and the known-event bucket could merge with the
// unknown-event one). The key is length-prefixed (`${name.length}:${name}${event}`) so no
// `(name, event)` pair aliases a different pair or a name-only key.

test("#957: an eventful `build`+`push` never collides with an event-less `buildpush` context", () => {
  const rollup = [
    // The event-less legacy StatusContext whose context string happens to equal the concatenation.
    { context: "buildpush", state: "FAILURE", createdAt: "2026-11-12T00:41:34Z" },
    // A different gate: a CheckRun named `build` triggered by `push`, green, newer.
    { name: "build", event: "push", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-11-12T00:41:38Z" },
  ];
  const latest = latestRunPerCheck(rollup);
  assertEquals(latest.length, 2, "distinct identities must not collapse into one gate");
  assertEquals(
    failingCheckNames(rollup),
    ["buildpush"],
    "the event-less red `buildpush` survives — the green `build`+`push` run must not discard it",
  );
});

test("#957: a known-event gate never merges with the unknown-event bucket of the same name", () => {
  // Same display name, one run event-ful, one event-less: these are different gates, so both survive.
  const rollup = [
    { name: "build", conclusion: "FAILURE", completedAt: "2026-11-12T00:41:34Z" }, // event-less (legacy)
    { name: "build", event: "push", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-11-12T00:41:38Z" },
  ];
  assertEquals(latestRunPerCheck(rollup).length, 2, "known-event and unknown-event runs of one name stay separate");
  assertEquals(failingCheckNames(rollup), ["build"], "the event-less red run is not shadowed by the eventful green one");
});

// ── PR #957 review: the real transport must populate `event` ─────────────────────────────────────
//
// The `gh pr view --json statusCheckRollup` exporter omits `event` (cli/cli `api/export_pr.go`), so
// `fetchPrState` enriches the rollup from GraphQL `CheckRun.checkSuite.workflowRun.event` before
// grouping. `applyRollupEvents` is the pure mapping; these cover the transport normalisation path.

test("#957: applyRollupEvents stamps each CheckRun's triggering event so the collapse separates events", () => {
  // What `gh pr view --json statusCheckRollup` actually returns: NO `event` field on either run.
  const rollup = [
    { name: "build", conclusion: "FAILURE", status: "COMPLETED", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", conclusion: "SUCCESS", status: "COMPLETED", startedAt: "2026-11-12T00:41:30Z", completedAt: "2026-11-12T00:41:38Z" },
  ];
  // Without enrichment the name-only fallback collapses the red run away (the #955 hole).
  assertEquals(failingCheckNames(rollup), [], "pre-enrichment: the newer green run hides the red one");
  // The GraphQL `statusCheckRollup.contexts` nodes for the same head, joined by (name, startedAt).
  const nodes = [
    { __typename: "CheckRun", databaseId: 1001, name: "build", startedAt: "2026-11-12T00:30:00Z", checkSuite: { workflowRun: { event: "pull_request" } } },
    { __typename: "CheckRun", databaseId: 1002, name: "build", startedAt: "2026-11-12T00:41:30Z", checkSuite: { workflowRun: { event: "push" } } },
  ];
  applyRollupEvents(rollup, nodes);
  assertEquals(rollup[0].event, "pull_request");
  assertEquals(rollup[0].databaseId, 1001);
  assertEquals(rollup[1].event, "push");
  assertEquals(rollup[1].databaseId, 1002);
  assertEquals(
    failingCheckNames(rollup),
    ["build"],
    "post-enrichment: the red pull_request run survives — #955 is actually fixed on the real transport",
  );
});

test("#957: applyRollupEvents leaves a StatusContext / misaligned / unreadable node event-less", () => {
  const rollup = [
    { context: "ci/legacy", state: "SUCCESS", createdAt: "2026-11-12T00:41:34Z" }, // a StatusContext
    { name: "build", conclusion: "SUCCESS", status: "COMPLETED", startedAt: "2026-11-12T00:41:30Z", completedAt: "2026-11-12T00:41:38Z" },
    { name: "test", conclusion: "SUCCESS", status: "COMPLETED", startedAt: "2026-11-12T00:41:31Z", completedAt: "2026-11-12T00:41:39Z" },
  ];
  const nodes = [
    { __typename: "StatusContext", context: "ci/legacy" }, // no event on this type
    { __typename: "CheckRun", name: "DIFFERENT", startedAt: "2026-11-12T00:41:30Z", checkSuite: { workflowRun: { event: "push" } } }, // misaligned name
    { __typename: "CheckRun", name: "test", startedAt: "2026-11-12T00:41:31Z", checkSuite: { workflowRun: { event: null } } }, // unreadable run
  ];
  applyRollupEvents(rollup, nodes);
  assertEquals(rollup[0].event, undefined, "a StatusContext never gains an event");
  assertEquals(rollup[1].event, undefined, "a misaligned node is not stamped blindly");
  assertEquals(rollup[2].event, undefined, "a null/absent event leaves the entry event-less");
});

// ── PR #957 review round 3: the join is by run identity, never array position ────────────────────
//
// The `gh pr view` read and the GraphQL contexts read are two SEPARATE GitHub calls that can observe
// different runs or heads, so index `i` in one is not reliably run `i` in the other. A positional
// join can stamp one run's event onto another (the name guard cannot catch it for duplicate `build`
// names), re-creating the cross-event collapse #955 fixed. The join keys on `(name, startedAt)` and
// stamps only an exact 1:1 bucket match.

test("#957: applyRollupEvents joins by run identity, not position — a reordered read stamps the right runs", () => {
  // The GraphQL read returns the two same-named runs in the OPPOSITE order from the CLI rollup.
  const rollup = [
    { name: "build", conclusion: "FAILURE", status: "COMPLETED", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:41:34Z" },
    { name: "build", conclusion: "SUCCESS", status: "COMPLETED", startedAt: "2026-11-12T00:41:30Z", completedAt: "2026-11-12T00:41:38Z" },
  ];
  const nodes = [
    // Reversed order vs the rollup: a positional join would stamp push onto the red run.
    { __typename: "CheckRun", databaseId: 1002, name: "build", startedAt: "2026-11-12T00:41:30Z", checkSuite: { workflowRun: { event: "push" } } },
    { __typename: "CheckRun", databaseId: 1001, name: "build", startedAt: "2026-11-12T00:30:00Z", checkSuite: { workflowRun: { event: "pull_request" } } },
  ];
  applyRollupEvents(rollup, nodes);
  assertEquals(rollup[0].event, "pull_request", "the red run keeps ITS event despite the reorder");
  assertEquals(rollup[1].event, "push", "the green run keeps ITS event despite the reorder");
  assertEquals(failingCheckNames(rollup), ["build"], "no cross-run stamp → the red pull_request run survives");
});

test("#957: applyRollupEvents stamps nothing when the two reads observed different run sets", () => {
  // A rerun landed between the `gh pr view` read and the GraphQL read: the GraphQL side has an
  // EXTRA `build` run at the SAME start instant (a cancelled/re-run pair re-queued together), so the
  // node bucket (2) out-sizes the rollup bucket (1) and stamping anything would risk a cross-run stamp.
  const rollup = [
    { name: "build", conclusion: "FAILURE", status: "COMPLETED", startedAt: "2026-11-12T00:30:00Z", completedAt: "2026-11-12T00:41:34Z" },
  ];
  const nodes = [
    { __typename: "CheckRun", databaseId: 1001, name: "build", startedAt: "2026-11-12T00:30:00Z", checkSuite: { workflowRun: { event: "pull_request" } } },
    { __typename: "CheckRun", databaseId: 1003, name: "build", startedAt: "2026-11-12T00:30:00Z", checkSuite: { workflowRun: { event: "push" } } },
  ];
  applyRollupEvents(rollup, nodes);
  assertEquals(rollup[0].event, undefined, "a bucket-size mismatch (the reads disagree) stamps nothing");
});

// ── PR #957 review round 3: the gate key is encoded for EVERY entry, event-less included ─────────
//
// Encoding only the known-event bucket leaves the two key spaces overlapping: `name:"build",
// event:"push"` produces `5:buildpush`, and an event-less `context:"5:buildpush"` ALSO produces
// `5:buildpush`, so a newer green entry could still discard an unrelated red check. Every entry —
// event-less ones included — is encoded as the same length-prefixed tuple.

test("#957: an eventful `build`+`push` never collides with an event-less `5:buildpush` context", () => {
  const rollup = [
    // An event-less legacy StatusContext whose context string equals the ENCODED tuple of the other gate.
    { context: "5:buildpush", state: "FAILURE", createdAt: "2026-11-12T00:41:34Z" },
    // A different gate: a CheckRun named `build` triggered by `push`, green, newer.
    { name: "build", event: "push", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-11-12T00:41:38Z" },
  ];
  const latest = latestRunPerCheck(rollup);
  assertEquals(latest.length, 2, "the encoded event-less key never aliases an eventful gate");
  assertEquals(
    failingCheckNames(rollup),
    ["5:buildpush"],
    "the red event-less `5:buildpush` survives — encoding every entry closes the cross-bucket hole",
  );
});

// ── PR #957 review round 3: a prototype-free dictionary for arbitrary check names ────────────────
//
// A check can legitimately be named `constructor`, `toString`, or `__proto__`; on a plain `{}` those
// resolve to an INHERITED property, so `out[name] ?? []` returns a function/object and `.push`
// throws — aborting `fetchPrState` / readiness parsing for that PR. The dictionary is
// prototype-free (`Object.create(null)`), so every check name is a safe own-key.

test("#957: checkGateConclusions survives a check named `constructor` / `toString` / `__proto__`", () => {
  const rollup = [
    { name: "constructor", conclusion: "FAILURE", status: "COMPLETED", completedAt: "2026-11-12T00:41:34Z" },
    { name: "toString", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-11-12T00:41:35Z" },
    { name: "__proto__", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-11-12T00:41:36Z" },
  ];
  const gates = checkGateConclusions(rollup);
  assertEquals(gates.constructor, ["FAILURE"], "an inherited-property name is a safe own-key");
  assertEquals(gates.toString, ["SUCCESS"]);
  assertEquals(gates.__proto__, ["SUCCESS"]);
  assertEquals(failingCheckNames(rollup), ["constructor"], "and the failure is still reported, not crashed");
});
