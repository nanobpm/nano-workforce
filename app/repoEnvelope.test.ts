// Contract test for the agent-task repository envelope (issue #882): the producer
// (`app/repoEnvelope.ts`) and the consumer (the c8ctl nano worker harness's
// `normalizeTaskEnvelope`, c8ctl-plugin.js) must agree on WHERE the deterministic
// `branch.create` lives. The harness reads it from the TOP LEVEL of the envelope
// (`raw.branch`), NOT nested under `repository`. The producer once nested it under
// `repository.branch` — a shape the consumer never reads — so `branch.create`
// silently never took effect (retries couldn't resume their WIP checkpoint, pushes
// were refused off the work branch; nanobpm/nano-bpm#1344). This is the
// two-sides-of-one-contract drift #227 guards against, so this test round-trips the
// emitted envelope through a faithful mirror of the harness's normalizer shape and
// asserts the consumer actually recovers `branch.create` — pinning producer and
// consumer together so they cannot drift again.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { agentNodeRepoEnvelope, flattenAgentTaskEnvelope, recoverBranchCreate, repoEnvelopeVars } from "./repoEnvelope.ts";

// ─── The consumer mirror ─────────────────────────────────────────────────────────────
// `recoverBranchCreate` (app/repoEnvelope.ts) is the ONE canonical mirror of the c8ctl harness's
// consumer shape (`collectEnvelopeFrom` + `normalizeTaskEnvelope`): it reassembles the reserved
// `io.nanobpm.agentTask` namespace out of BOTH a whole-object/JSON value AND flattened dotpath keys,
// `deepMerge`s the two sources (variables over headers), and reads `branch` from the TOP LEVEL of the
// merged envelope (`isPlainObject(raw.branch)`), NOT from `raw.repository.branch`. Keeping that mirror
// in lock-step with the harness is the point of this test: if the producer emits a shape the consumer
// doesn't read, the round-trip below drops `branch.create` and fails. Aliased here under the
// harness-centric name the assertions read naturally with.
const harnessReadsBranchCreate = recoverBranchCreate;

// ─── The round-trip contract ──────────────────────────────────────────────────────────

test("contract: repoEnvelopeVars emits branch.create where the harness reads it (envelope TOP LEVEL, not repository.branch) (#882)", () => {
  // The pre-PR implementation path: a deterministic feat/<task.id> branch the harness must cut.
  const vars = repoEnvelopeVars("owner/repo", "main", null, null, "feat/issue-7");
  // Round-trip the emitted PROCESS-VARIABLE envelope through the harness normalizer shape.
  const recovered = harnessReadsBranchCreate({}, vars);
  assertEquals(
    recovered,
    "feat/issue-7",
    "the harness reads branch.create from the envelope top level — nesting it under repository.branch drops it",
  );
});

test("contract: repoEnvelopeVars PR path (ref == create == head) round-trips branch.create to the harness (#882/#231)", () => {
  const vars = repoEnvelopeVars("owner/repo", "feat/issue-12", "main", null, "feat/issue-12");
  assertEquals(harnessReadsBranchCreate({}, vars), "feat/issue-12");
});

test("contract: agentNodeRepoEnvelope round-trips the deterministic per-node branch through the harness (#882/#776)", () => {
  const vars = agentNodeRepoEnvelope("acme/one", "main", "feat/n1");
  assertEquals(harnessReadsBranchCreate({}, vars), "feat/n1");
});

test("contract: the FLATTENED per-cell task headers round-trip branch.create to the harness (#882/#739)", () => {
  // The delivery-graph path delivers the envelope as FLAT dotted task headers, which the harness
  // reassembles via collectEnvelopeFrom's dotpath branch. Round-trip the flattened headers through
  // the same normalizer shape so the header channel can't drift from the consumer either.
  const envelope = agentNodeRepoEnvelope("acme/one", "main", "feat/open-b");
  const flat = flattenAgentTaskEnvelope(envelope);
  // The flattened key must be the TOP-LEVEL `branch.create`, NOT `repository.branch.create`.
  assert(
    "io.nanobpm.agentTask.branch.create" in flat,
    `expected a top-level io.nanobpm.agentTask.branch.create header, got ${JSON.stringify(Object.keys(flat))}`,
  );
  assert(
    !("io.nanobpm.agentTask.repository.branch.create" in flat),
    "branch.create must NOT be nested under repository — the harness never reads it there",
  );
  const recovered = harnessReadsBranchCreate(flat, {});
  assertEquals(recovered, "feat/open-b", "the harness reassembles the flattened header into branch.create");
});

test("contract: an envelope with NO branch round-trips to undefined (the consumer's default), never a bogus value (#882)", () => {
  // A blank branchCreate omits the key entirely; the harness must then see no branch.create.
  const vars = repoEnvelopeVars("owner/repo", "main", null, null, null);
  assertEquals(harnessReadsBranchCreate({}, vars), undefined);
});
