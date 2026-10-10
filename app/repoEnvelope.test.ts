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
import { agentNodeRepoEnvelope, flattenAgentTaskEnvelope, repoEnvelopeVars } from "./repoEnvelope.ts";

// ─── A faithful mirror of the harness's consumer shape ───────────────────────────────
// These mirror the EXACT semantics of c8ctl-plugin-nano `normalizeTaskEnvelope`
// (c8ctl-plugin.js): `collectEnvelopeFrom` reassembles the reserved
// `io.nanobpm.agentTask` namespace out of BOTH a whole-object/JSON value AND flattened
// dotpath keys, `deepMerge`s the two sources, and `normalizeTaskEnvelope` then reads
// `branch` from the TOP LEVEL of the merged envelope (`isPlainObject(raw.branch)`),
// NOT from `raw.repository.branch`. Keeping this mirror in lock-step with the harness
// is the point of the test: if the producer emits a shape the consumer doesn't read,
// the round-trip below drops `branch.create` and fails.
const AGENT_TASK_NS = "io.nanobpm.agentTask";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base)) return isPlainObject(over) ? deepMerge({}, over) : over;
  const out: Record<string, unknown> = { ...base };
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Mirror of the harness's `collectEnvelopeFrom`: reassemble the reserved namespace from a
 * whole-object/JSON value AND flattened dotpath keys (element templates / task headers emit the
 * latter). */
function collectEnvelopeFrom(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(source)) return out;
  const whole = source[AGENT_TASK_NS];
  if (whole != null) {
    let val: unknown = whole;
    if (typeof whole === "string") {
      try {
        val = JSON.parse(whole);
      } catch {
        val = undefined;
      }
    }
    if (isPlainObject(val)) Object.assign(out, deepMerge(out, val));
  }
  const prefix = `${AGENT_TASK_NS}.`;
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!rest) continue;
    setPath(out, rest.split("."), value);
  }
  return out;
}

/** Mirror of the harness's `normalizeTaskEnvelope` branch slice: it reads `branch` from the TOP
 * LEVEL of the merged envelope — `isPlainObject(raw.branch) ? raw.branch : {}` — never from
 * `raw.repository.branch`. Returns the consumer's recovered `branch.create` (undefined when the
 * producer put it somewhere the consumer doesn't look). */
function harnessReadsBranchCreate(customHeaders: Record<string, unknown>, variables: Record<string, unknown>): string | undefined {
  const raw = deepMerge(collectEnvelopeFrom(customHeaders), collectEnvelopeFrom(variables)) as Record<string, unknown>;
  const branch = isPlainObject(raw.branch) ? raw.branch : {};
  const create = branch.create;
  return create == null ? undefined : String(create);
}

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
