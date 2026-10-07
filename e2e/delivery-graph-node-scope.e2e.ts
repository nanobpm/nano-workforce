// End-to-end proof (WASM engine) of the delivery-graph node-scope hardening, driven by the failure on
// live instance 171774: three escalations whose prompts carried no usable information.
//
//   • NODE-LOCAL REPORT: parallel agent nodes keep their result (`status`/`summary`/`pr`/…) in their own
//     subProcess scope. A blocked node's contract escalation shows ITS OWN report (summary, question,
//     transcript) — not whichever sibling finished last — and the shared root holds no `pr`/`status`
//     a sibling's `<el>_pr` output could bind (171774: a timed-out node would have bound a sibling's PR).
//   • RETRY-NODE: completing a service-node escalation with `decision: "retry"` re-runs the node's job,
//     passing the operator's `note` to the agent as guidance; the previous attempt's stale `blocked`
//     status is cleared, so a rerun that succeeds without reporting a status passes the contract gate.
//   • PREFLIGHT: a node whose runner-seeded `nodeInputs` config is missing (lost root variables) raises
//     an incident naming the cause instead of running blind; restoring the variables and resolving the
//     incident lets the node proceed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { runDeliveryGraph } from "../app/deliveryRunner.ts";
import { deliveryGraphRuns } from "../app/deliveryGraphRun.ts";
import { pollUserTasks } from "../app/service.ts";
import { userTasks } from "../app/userTasks.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

const PR_A = "https://github.com/acme/repo/pull/1";
const PR_B = "https://github.com/acme/repo/pull/2";

/** Two independent producer→consumer chains (`a → ca`, `b → cb`): each agent's `pr` is a REQUIRED data
 * dependency of its connector, so each agent node carries a producer-contract gate. */
const TWO_CHAINS: DeliveryGraph = {
  name: "node-scope e2e",
  nodes: [
    { id: "a", kind: "agent", agent: { jobType: "senior:a" }, emits: [{ name: "pr", type: "pr" }] },
    { id: "b", kind: "agent", agent: { jobType: "senior:b" }, emits: [{ name: "pr", type: "pr" }] },
    { id: "ca", kind: "connector", connector: { target: "slack", dedupeKey: "ca-1", payload: { pr: "a.pr" } } },
    { id: "cb", kind: "connector", connector: { target: "slack", dedupeKey: "cb-1", payload: { pr: "b.pr" } } },
  ],
  edges: [
    { from: "a.pr", to: "ca" },
    { from: "b.pr", to: "cb" },
  ],
} as DeliveryGraph;

describe("delivery-graph node scope — node-local agent reports, retry-node, preflight", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  async function boot(): Promise<TestApp> {
    const dir = mkdtempSync(join(tmpdir(), "nwf-node-scope-e2e-"));
    dirs.push(dir);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
    apps.push(app);
    return app;
  }
  /** Observe each connector's late-bound facts, keyed by its dedupe key. */
  async function observeConnectors(app: TestApp): Promise<Map<string, unknown>> {
    const seen = new Map<string, unknown>();
    await app.engine.registerWorker(
      "pr.delivery-connector",
      async (job) => {
        const vars = job.variables as Record<string, unknown>;
        seen.set(String(vars.dedupeKey), vars.boundFacts);
        return {};
      },
      { fetchVariables: ["boundFacts", "dedupeKey"] },
    );
    return seen;
  }
  async function rootVars(app: TestApp, pik: string): Promise<Map<string, unknown>> {
    const vars = await app.engine.searchVariables({ processInstanceKey: pik } as never);
    return new Map(vars.filter((v) => String(v.scopeKey) === pik).map((v) => [v.name, JSON.parse(v.value) as unknown]));
  }
  async function openTask(app: TestApp, suffix: string) {
    const open = await app.engine.searchUserTasks({ state: "CREATED" });
    return open.find((t) => t.elementId?.endsWith(suffix));
  }

  test("a blocked agent's contract escalation carries ITS OWN report; siblings and the root never mix results", async () => {
    const app = await boot();
    const connectors = await observeConnectors(app);
    await app.engine.registerWorker("senior:a", async () => ({ status: "done", pr: PR_A, summary: "opened PR 1" }));
    await app.engine.registerWorker("senior:b", async () => ({
      status: "blocked",
      summary: "workspace clone not provisioned: repository unset",
      question: "Which repository should I clone?",
      transcriptUrl: "http://localhost:3000/app/api/agentic/transcripts/w/42",
    }));

    const run = await runDeliveryGraph(app.engine, TWO_CHAINS, { repoless: true });
    assert.ok(run.ok, JSON.stringify(run));
    const pik = run.handle.processInstanceKey;
    await app.settle();

    // `a` met its contract and handed ITS pr to `ca`; `b` parked on its own contract escalation.
    assert.deepEqual(connectors.get("ca-1"), [{ from: "a", name: "pr", value: PR_A }]);
    assert.equal(connectors.has("cb-1"), false, "the blocked producer's consumer did not fire");
    const esc = await openTask(app, "__contract");
    assert.ok(esc, "b parked on its producer-contract escalation");
    // What the OPERATOR sees: the Tasks inbox "Decision context" (`user_tasks.question`) projected by
    // the poller for a running delivery run — previously the static "A scheduled delivery-graph step is
    // waiting to be completed." for every agent escalation twin.
    const ts = new Date().toISOString();
    await deliveryGraphRuns(app.db).insert({ run_key: "r-node-scope", digest: "d", status: "running", process_key: pik, created_at: ts, updated_at: ts } as never);
    await pollUserTasks(app.db, app.engine);
    const row = await userTasks(app.db).get(String(esc.userTaskKey));
    const prompt = String(row?.question ?? "");
    assert.match(prompt, /Reported status=blocked/);
    assert.match(prompt, /Agent report: workspace clone not provisioned: repository unset/);
    assert.match(prompt, /Agent question: Which repository should I clone\?/);
    assert.match(prompt, /Transcript: http:\/\/localhost:3000\/app\/api\/agentic\/transcripts\/w\/42/);
    assert.match(prompt, /Retry this step/, "the prompt names how to resolve it");
    assert.doesNotMatch(prompt, /opened PR 1/, "a sibling's report never leaks into this node's escalation");

    // The shared root holds no agent result a sibling could read back.
    const root = await rootVars(app, pik);
    for (const name of ["status", "summary", "question", "pr", "value", "decision"]) {
      assert.equal(root.has(name), false, `root must not carry the node-local '${name}'`);
    }
    assert.equal(root.get("n0_pr") ?? root.get(`${"n0"}_pr`), PR_A, "a's emit still publishes onward as <el>_pr");
  });

  test("retry-node: decision=retry re-runs the job with the operator's note; a status-less success then passes the gate", async () => {
    const app = await boot();
    const connectors = await observeConnectors(app);
    await app.engine.registerWorker("senior:a", async () => ({ status: "done", pr: PR_A }));
    const bPrompts: unknown[] = [];
    await app.engine.registerWorker(
      "senior:b",
      async (job) => {
        bPrompts.push((job.variables as Record<string, unknown>).appendPrompt);
        // 1st attempt: blocked. 2nd attempt: succeeds WITHOUT reporting a status (a `completed` ACP
        // outcome derives no flat status) — the stale `blocked` must not fail the gate again.
        return bPrompts.length === 1 ? { status: "blocked", summary: "no repo" } : { pr: PR_B };
      },
      { fetchVariables: ["appendPrompt"] },
    );

    const run = await runDeliveryGraph(app.engine, TWO_CHAINS, { repoless: true });
    assert.ok(run.ok, JSON.stringify(run));
    await app.settle();
    const esc = await openTask(app, "__contract");
    assert.ok(esc, "b parked on its contract escalation");

    await app.engine.completeUserTask(esc.userTaskKey, { decision: "retry", escalationNote: "clone acme/repo" });
    await app.settle();

    assert.equal(bPrompts.length, 2, "the retry re-ran b's job");
    assert.match(String(bPrompts[1]), /Operator guidance for this retry: clone acme\/repo/);
    assert.equal(await openTask(app, "__contract"), undefined, "the status-less rerun passed the contract gate");
    assert.deepEqual(connectors.get("cb-1"), [{ from: "b", name: "pr", value: PR_B }], "b's retried PR threads onward");
    const flows = (app.snapshot().takenSequenceFlows ?? []) as { to: string }[];
    assert.ok(flows.some((f) => f.to === "End"), "the graph completed");
  });

  test("retry-node: consecutive retries never accumulate stale operator notes in the prompt", async () => {
    // Regression (PR #863 adversarial review): the retry reset must re-derive `appendPrompt` from the
    // runner-seeded `nodeInputs` baseline — building on the live var carried retry 1's note into retry
    // 2's prompt, growing one stale "Operator guidance…" paragraph per consecutive retry.
    const app = await boot();
    await observeConnectors(app);
    await app.engine.registerWorker("senior:a", async () => ({ status: "done", pr: PR_A }));
    const bPrompts: unknown[] = [];
    await app.engine.registerWorker(
      "senior:b",
      async (job) => {
        bPrompts.push((job.variables as Record<string, unknown>).appendPrompt);
        // Every attempt reports blocked until the THIRD, which succeeds — forcing TWO retries.
        return bPrompts.length < 3 ? { status: "blocked", summary: "no repo" } : { pr: PR_B };
      },
      { fetchVariables: ["appendPrompt"] },
    );

    const run = await runDeliveryGraph(app.engine, TWO_CHAINS, { repoless: true });
    assert.ok(run.ok, JSON.stringify(run));
    await app.settle();

    const first = await openTask(app, "__contract");
    assert.ok(first, "b parked on its contract escalation");
    await app.engine.completeUserTask(first.userTaskKey, { decision: "retry", escalationNote: "first note" });
    await app.settle();
    assert.equal(bPrompts.length, 2, "retry 1 re-ran b's job");

    const second = await openTask(app, "__contract");
    assert.ok(second, "b parked again after retry 1 reported blocked");
    await app.engine.completeUserTask(second.userTaskKey, { decision: "retry", escalationNote: "second note" });
    await app.settle();
    assert.equal(bPrompts.length, 3, "retry 2 re-ran b's job");

    assert.match(String(bPrompts[1]), /Operator guidance for this retry: first note/);
    assert.match(String(bPrompts[2]), /Operator guidance for this retry: second note/, "retry 2 carries its own note");
    assert.doesNotMatch(String(bPrompts[2]), /first note/, "retry 2's prompt does NOT accumulate retry 1's note");
    assert.equal((String(bPrompts[2]).match(/Operator guidance for this retry:/g) ?? []).length, 1, "exactly one guidance paragraph");
    assert.equal(await openTask(app, "__contract"), undefined, "the third attempt passed the contract gate");
  });

  test("retry-node: a retry with an omitted operator note never reuses the previous attempt's worker `note` result", async () => {
    // Regression (PR #863 Copilot "Previously missed", deliveryGraphCompiler.ts:2156): the escalation
    // note control shared the plain name `note` with a WORKER RESULT field the built-in plan prompt
    // returns (resources/prompts/plan.md). Declared node-local via ESCALATION_LOCAL_VARS, a worker's
    // `note` landed in the same subProcess scope the retry reset reads for "Operator guidance…" — so
    // completing the escalation with `{ decision: "retry" }` and NO note (the form contract permits
    // it) fed the worker's own stale note back to the agent as if the operator had written it. The
    // control is renamed `escalationNote` (a name no worker result contract may use), so an omitted
    // operator note appends NOTHING.
    const app = await boot();
    await observeConnectors(app);
    await app.engine.registerWorker("senior:a", async () => ({ status: "done", pr: PR_A }));
    const bPrompts: unknown[] = [];
    await app.engine.registerWorker(
      "senior:b",
      async (job) => {
        bPrompts.push((job.variables as Record<string, unknown>).appendPrompt);
        // 1st attempt: blocked AND returns a worker `note` (the plan.md contract). 2nd: succeeds.
        return bPrompts.length === 1
          ? { status: "blocked", summary: "no repo", note: "worker-produced note" }
          : { pr: PR_B };
      },
      { fetchVariables: ["appendPrompt"] },
    );

    const run = await runDeliveryGraph(app.engine, TWO_CHAINS, { repoless: true });
    assert.ok(run.ok, JSON.stringify(run));
    await app.settle();
    const esc = await openTask(app, "__contract");
    assert.ok(esc, "b parked on its contract escalation");

    // Retry WITHOUT an operator note — the escalation form permits omitting it.
    await app.engine.completeUserTask(esc.userTaskKey, { decision: "retry" });
    await app.settle();

    assert.equal(bPrompts.length, 2, "the retry re-ran b's job");
    assert.doesNotMatch(
      String(bPrompts[1]),
      /Operator guidance for this retry:/,
      "an omitted operator note appends NO guidance paragraph",
    );
    assert.doesNotMatch(
      String(bPrompts[1]),
      /worker-produced note/,
      "the previous attempt's worker `note` result is never fed back as operator guidance",
    );
    assert.equal(await openTask(app, "__contract"), undefined, "the retried run passed the contract gate");
  });

  test("a continue resolution (no decision) supplies the missing emit and does not loop", async () => {
    const app = await boot();
    const connectors = await observeConnectors(app);
    await app.engine.registerWorker("senior:a", async () => ({ status: "done", pr: PR_A }));
    let bRuns = 0;
    await app.engine.registerWorker("senior:b", async () => {
      bRuns++;
      return { status: "blocked", summary: "no repo" };
    });
    const run = await runDeliveryGraph(app.engine, TWO_CHAINS, { repoless: true });
    assert.ok(run.ok, JSON.stringify(run));
    await app.settle();
    const esc = await openTask(app, "__contract");
    assert.ok(esc);
    await app.engine.completeUserTask(esc.userTaskKey, { value: PR_B });
    await app.settle();
    assert.equal(bRuns, 1, "no retry without decision=retry");
    assert.deepEqual(connectors.get("cb-1"), [{ from: "b", name: "pr", value: PR_B }], "the supplied PR resumes b");
  });

  test("a boolean single-emit Continue coerces the textfield string to a real boolean (typed-resume regression)", async () => {
    // Regression guard (PR #863 Copilot High, thread r4182488193): the escalation form captures `value`
    // as textfield TEXT, but a `boolean` emit's downstream guard compares against a typed `= true`. The
    // single-emit resume must coerce the string to a real boolean — a raw `"true"` string would skip the
    // guard. Verified end-to-end against the WASM engine (the FEEL `matches` has no inline `(?i:)` flag,
    // so the coercion lower-cases the input).
    const app = await boot();
    const connectors = await observeConnectors(app);
    const graph = {
      name: "bool-coerce",
      nodes: [
        { id: "b", kind: "agent", agent: { jobType: "senior:b" }, emits: [{ name: "ok", type: "boolean" }] },
        { id: "cb", kind: "connector", connector: { target: "slack", dedupeKey: "cb-1", payload: { ok: "b.ok" } } },
      ],
      edges: [{ from: "b.ok", to: "cb" }],
    } as never;
    await app.engine.registerWorker("senior:b", async () => ({ status: "blocked", summary: "no repo" }));
    const run = await runDeliveryGraph(app.engine, graph, { repoless: true });
    assert.ok(run.ok, JSON.stringify(run));
    await app.settle();
    const esc = await openTask(app, "__contract");
    assert.ok(esc);
    await app.engine.completeUserTask(esc.userTaskKey, { value: "true" });
    await app.settle();
    assert.deepEqual(connectors.get("cb-1"), [{ from: "b", name: "ok", value: true }], "the textfield \"true\" resumes b as a real boolean");
  });

  test("preflight: a node whose nodeInputs were lost raises an incident naming the cause, and proceeds once restored", async () => {
    const app = await boot();
    await observeConnectors(app);
    // `a` simulates the root-variable loss (nano-bpm#1331) while it runs: it completes with
    // `nodeInputs: null`, which propagates to the root `nodeInputs` the runner seeded.
    let seed: unknown;
    await app.engine.registerWorker("senior:a", async () => ({ status: "done", pr: PR_A, nodeInputs: null }));
    let bRuns = 0;
    const bJobTypes: unknown[] = [];
    await app.engine.registerWorker(
      "senior:b",
      async (job) => {
        bRuns++;
        bJobTypes.push((job.variables as Record<string, unknown>).jobType);
        return { status: "done", pr: PR_B };
      },
      { fetchVariables: ["jobType"] },
    );
    const graph = {
      name: "preflight e2e",
      nodes: [
        { id: "a", kind: "agent", agent: { jobType: "senior:a" }, emits: [{ name: "pr", type: "pr" }] },
        { id: "b", kind: "agent", agent: { jobType: "senior:b" }, emits: [{ name: "pr", type: "pr" }] },
      ],
      edges: [{ from: "a.pr", to: "b" }],
    } as DeliveryGraph;
    const run = await runDeliveryGraph(app.engine, graph, { repoless: true });
    assert.ok(run.ok, JSON.stringify(run));
    seed = run.handle.nodeInputs;
    const pik = run.handle.processInstanceKey;
    await app.settle();

    assert.equal(bRuns, 0, "b never ran blind");
    const incidents = await app.engine.searchIncidents({ processInstanceKey: pik } as never);
    const inc = incidents.find((i) => /nodeInputs\.n1 is missing/.test(String(i.errorMessage ?? "")));
    assert.ok(inc, `an incident names the missing node inputs, got ${JSON.stringify(incidents)}`);

    // Repair: restore the root variables, resolve the incident → b runs and the graph completes.
    await app.engine.setVariables({ scopeKey: pik, variables: { nodeInputs: seed } });
    await app.engine.resolveIncident({ incidentKey: String(inc.incidentKey) });
    await app.settle();
    assert.equal(bRuns, 1, "b ran once its inputs were restored");
    // Do NOT bless leaf-only resolution as a CONFIGURED recovery (PR #863 Copilot Medium, thread
    // r4181322055). The KNOWN LIMITATION (nano-workforce#866) is that resolving the leaf incident
    // re-evaluates ONLY the leaf's inputs — the subProcess-level config mappings ran once at subProcess
    // entry and are NOT re-mapped on resolve — so this leaf-only path runs b BLIND (`jobType` is null).
    // Assert that honestly: this scenario proves the preflight incident PREVENTS the blind run up front
    // (bRuns stayed 0 while the config was missing) and that resolution unblocks the node — NOT that
    // leaf-resolution restores the config. The correct recovery (re-entering the sub-process so its
    // input mappings re-evaluate) is a separate operator action the testkit cannot drive via
    // resolveIncident; SPEC documents it as the required workaround.
    assert.equal(
      bJobTypes[0] ?? null,
      null,
      "leaf-only resolution re-runs b BLIND (the #866 known limitation) — the preflight's value is blocking the blind run BEFORE a job exists, not restoring config on resolve",
    );
    const flows = (app.snapshot().takenSequenceFlows ?? []) as { to: string }[];
    assert.ok(flows.some((f) => f.to === "End"), "the graph completed");
  });
});
