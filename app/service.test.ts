// Red/green regression for re-submit clearing stale open escalations (Magikcraft/nano-bpm
// #597/#599). When a cancelled/converged PR is re-submitted, `submitPr` re-opens it for a fresh
// convergence run. Any escalation left `open` by the prior run — plus the denormalised
// `open_escalation_*` pointer on the PR row — must be cleared, or the answer form resurfaces a
// dead "(no question provided)" question on the re-opened PR (the same stale-row class the plan
// loop already guards in `startPlan`). Drives `submitPr` against an in-memory data layer with the
// GitHub transport forced off so it is hermetic.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { memDataFor } from "../test/worldDb.ts";
import { DurableResumeRegistry } from "./durableResume.ts";
import { WorldStore } from "./world/index.ts";
import { abandonClosedPr, parsePr, pollCapabilityGatesImpl, pollIncidentsImpl, pollWaveGatesImpl, repoEnvelopeVars, startMerge, submitPr, worldRestoreSha } from "./service.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
}

function withGithubOff(run: () => Promise<void>): Promise<void> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token"; // no token below -> fetchPrMeta returns null
  delete process.env["GITHUB_TOKEN"];
  return run().finally(() => {
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
  });
}

test("re-submit of a cancelled PR marks stale open escalations", async () => {
  await withGithubOff(async () => {
    const PR_KEY = "owner/repo#42";
    const stores: Record<string, { rows: unknown[]; key: string }> = {
      pull_requests: {
        rows: [{
          pr_key: PR_KEY,
          repo: "owner/repo",
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          title: "old title",
          status: "abandoned", // terminal -> re-open path
          current_round: 3,
        }],
        key: "pr_key",
      },
      escalations: {
        rows: [{ id: 5, pr_key: PR_KEY, round_no: 3, kind: "question", question: "(no question provided)", status: "open" }],
        key: "id",
      },
      pr_dependencies: { rows: [], key: "pr_key" },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    } as any;
    const engine = {
      createInstance: () => Promise.resolve({ processInstanceKey: "PI-9" }),
    } as any;

    await submitPr(data, engine, {
      repo: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      prKey: PR_KEY,
    });

    // The prior run's open escalation is retired (not left "open" to resurface a dead form on the
    // re-opened PR). The review-loop escalation is now a native userTask (open state derived from
    // the canonical `escalations` row status), so there is no denormalised PR-row pointer to clear.
    const esc = stores.escalations.rows[0] as Record<string, unknown>;
    assertEquals(esc.status, "stale");
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.status, "converging");
    assertEquals(pr.current_round, 1);
    assertEquals(pr.open_escalation_id, undefined);
    assertEquals(pr.open_escalation_question, undefined);
    assertEquals(pr.process_key, "PI-9");
  });
});

// Red/green regression for technical-incident surfacing (issue #94). A convergence/merge instance
// can hit an engine incident that parks the token; until `pollIncidents` nothing on the PR row
// reflected it, so the grid kept showing "converging" while the run was dead in the water. This
// drives the pass's reconciliation core against a stubbed `/v2/incidents/search`:
//   1. an ACTIVE incident is mirrored onto `incident_key` + `incident_message` (status untouched),
//   2. once the engine reports no active incident, the columns are cleared idempotently,
//   3. a PR with no live instance (no process_key / terminal status) is never queried and any
//      stale incident on it is cleared.
function incidentFetch(byInstance: Record<string, unknown[]>) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (!u.endsWith("/incidents/search")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      filter?: { processInstanceKey?: string };
    };
    const items = byInstance[body.filter?.processInstanceKey ?? ""] ?? [];
    return Promise.resolve(
      new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

test("pollIncidents mirrors an ACTIVE incident onto the PR row, then clears it, leaving status untouched", async () => {
  const row = {
    pr_key: "owner/repo#7",
    repo: "owner/repo",
    number: 7,
    status: "converging",
    process_key: "PI-7",
    incident_key: null as string | null,
    incident_message: null as string | null,
    updated_at: "t0",
  };
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  const headers = { "content-type": "application/json" };

  const prevFetch = globalThis.fetch;

  // Red-ish: with an ACTIVE incident on the instance, the pass must surface it (before this
  // feature the columns stayed null and the incident was invisible).
  globalThis.fetch = incidentFetch({
    "PI-7": [{ incidentKey: "INC-1", errorMessage: "boom: unhandled error", state: "ACTIVE", creationTime: "2024-01-01T00:00:00Z" }],
  }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(row.incident_key, "INC-1");
  assertEquals(row.incident_message, "boom: unhandled error");
  assertEquals(row.status, "converging"); // orthogonal: status is never touched

  // Green: once the engine reports no active incident, the columns clear idempotently.
  globalThis.fetch = incidentFetch({ "PI-7": [] }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(row.incident_key, null);
  assertEquals(row.incident_message, null);
  assertEquals(row.status, "converging");
});

test("pollIncidents never queries a PR with no live instance and clears any stale incident", async () => {
  const noKey = {
    pr_key: "owner/repo#8",
    status: "converging",
    process_key: null as string | null,
    incident_key: "STALE-A",
    incident_message: "left over",
    updated_at: "t0",
  };
  const terminal = {
    pr_key: "owner/repo#9",
    status: "merged",
    process_key: "PI-9",
    incident_key: "STALE-B",
    incident_message: "left over",
    updated_at: "t0",
  };
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [noKey, terminal], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  const headers = { "content-type": "application/json" };

  const prevFetch = globalThis.fetch;
  // Any fetch here is a bug — neither PR has a live instance to inspect.
  globalThis.fetch = (() => {
    throw new Error("pollIncidents must not query a PR with no live instance");
  }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(noKey.incident_key, null);
  assertEquals(noKey.incident_message, null);
  assertEquals(terminal.incident_key, null);
  assertEquals(terminal.incident_message, null);
});

test("pollIncidents picks the oldest incident by creationTime, sorting a missing timestamp last", async () => {
  const row = {
    pr_key: "owner/repo#11",
    status: "converging",
    process_key: "PI-11",
    incident_key: null as string | null,
    incident_message: null as string | null,
    updated_at: "t0",
  };
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  const headers = { "content-type": "application/json" };

  const prevFetch = globalThis.fetch;
  // A no-`creationTime` incident must not masquerade as the oldest (empty-string sort bug): the
  // real earliest ISO timestamp wins even when a timestamp-less incident is returned first.
  globalThis.fetch = incidentFetch({
    "PI-11": [
      { incidentKey: "INC-NOTS", errorMessage: "no timestamp", state: "ACTIVE" },
      { incidentKey: "INC-OLD", errorMessage: "the first fault", state: "ACTIVE", creationTime: "2024-01-01T00:00:00Z" },
      { incidentKey: "INC-NEW", errorMessage: "a later fault", state: "ACTIVE", creationTime: "2024-06-01T00:00:00Z" },
    ],
  }) as typeof fetch;
  try {
    await pollIncidentsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(row.incident_key, "INC-OLD");
  assertEquals(row.incident_message, "the first fault");
});


// Red/green regression (nano-workforce#102 review): the engine can hand back a numeric
// `processInstanceKey`, but the OpenAPI `SubmitResult.processKey` contract is `string | null`, so
// under api `validateResponses:"dev"` a raw number fails response validation. Stringifying at the
// source also keeps the returned key aligned with the DB-persisted `String(...)` value and dodges
// JS 53-bit precision limits for large 64-bit keys (which is why keys travel as strings in
// practice). `submitPr` must stringify it both in the returned body and the persisted row.
test("submitPr stringifies a numeric processInstanceKey (contract: string | null)", async () => {
  await withGithubOff(async () => {
    const PR_KEY = "owner/repo#7";
    const stores: Record<string, { rows: unknown[]; key: string }> = {
      pull_requests: { rows: [], key: "pr_key" },
      escalations: { rows: [], key: "id" },
      pr_dependencies: { rows: [], key: "pr_key" },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    } as any;
    const engine = {
      // A large key delivered as a JS number — the exact case that breaks dev response validation
      // (number vs the `string | null` contract). Kept within MAX_SAFE_INTEGER so the fixture
      // itself is exact; true 64-bit keys travel as strings for the same precision reason.
      createInstance: () => Promise.resolve({ processInstanceKey: 2251799813685249 }),
    } as any;

    const res = await submitPr(data, engine, {
      repo: "owner/repo",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      prKey: PR_KEY,
    });

    const processKey = (res as any).processKey;
    assertEquals(typeof processKey, "string");
    assertEquals(processKey, "2251799813685249");
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.process_key, "2251799813685249");
  });
});

// Per-request review-only override: `submitPr` carries `convergeOnly` onto the convergence
// instance so `pr.finalize` can stop at `converged` without handing off to the merge-loop. Default
// false (so the global auto-merge default governs); true when the caller pins review-only.
function captureConvergeOnly() {
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [], key: "pr_key" },
    escalations: { rows: [], key: "id" },
    pr_dependencies: { rows: [], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  let captured: unknown;
  const engine = {
    createInstance: (req: { variables?: Record<string, unknown> }) => {
      captured = req.variables?.convergeOnly;
      return Promise.resolve({ processInstanceKey: "PI-1" });
    },
  } as any;
  return { data, engine, get: () => captured };
}

test("submitPr threads convergeOnly=true onto the instance as a process variable", async () => {
  await withGithubOff(async () => {
    const { data, engine, get } = captureConvergeOnly();
    await submitPr(
      data,
      engine,
      { repo: "owner/repo", number: 8, url: "https://github.com/owner/repo/pull/8", prKey: "owner/repo#8" },
      [],
      20,
      true,
    );
    assertEquals(get(), true);
  });
});

test("submitPr defaults convergeOnly to false so the global auto-merge default governs", async () => {
  await withGithubOff(async () => {
    const { data, engine, get } = captureConvergeOnly();
    await submitPr(data, engine, {
      repo: "owner/repo",
      number: 9,
      url: "https://github.com/owner/repo/pull/9",
      prKey: "owner/repo#9",
    });
    assertEquals(get(), false);
  });
});

// Lineage threading (issue #245): `submitPr` persists the origin `root_request_key` on the PR row
// and carries it onto the convergence instance; `startMerge` reads it back off the row onto the
// merge instance. A human/webhook submit that supplies no root self-roots on the `pr_key` (its own
// root), and a resubmit that omits the root must not clobber a root already learned.
function captureRoot() {
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [], key: "pr_key" },
    escalations: { rows: [], key: "id" },
    pr_dependencies: { rows: [], key: "pr_key" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  let captured: unknown;
  const engine = {
    createInstance: (req: { variables?: Record<string, unknown> }) => {
      captured = req.variables?.rootRequestKey;
      return Promise.resolve({ processInstanceKey: "PI-1" });
    },
  } as any;
  return { data, engine, stores, get: () => captured };
}

test("submitPr persists root_request_key and threads it onto the convergence instance", async () => {
  await withGithubOff(async () => {
    const { data, engine, stores, get } = captureRoot();
    await submitPr(
      data,
      engine,
      { repo: "owner/repo", number: 8, url: "https://github.com/owner/repo/pull/8", prKey: "owner/repo#8" },
      [],
      20,
      false,
      "owner/repo#1",
    );
    assertEquals(get(), "owner/repo#1");
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.root_request_key, "owner/repo#1");
  });
});

test("submitPr self-roots root_request_key on the pr_key for a human/webhook submit (its own root)", async () => {
  await withGithubOff(async () => {
    const { data, engine, stores, get } = captureRoot();
    await submitPr(data, engine, {
      repo: "owner/repo",
      number: 9,
      url: "https://github.com/owner/repo/pull/9",
      prKey: "owner/repo#9",
    });
    assertEquals(get(), "owner/repo#9");
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.root_request_key, "owner/repo#9");
  });
});

test("submitPr resubmit does not clobber an already-learned root when omitted", async () => {
  await withGithubOff(async () => {
    const { data, engine, stores, get } = captureRoot();
    (stores.pull_requests.rows as unknown[]).push({
      pr_key: "owner/repo#8",
      repo: "owner/repo",
      number: 8,
      url: "https://github.com/owner/repo/pull/8",
      status: "abandoned", // terminal -> re-open path
      current_round: 3,
      root_request_key: "owner/repo#1",
    });
    await submitPr(data, engine, {
      repo: "owner/repo",
      number: 8,
      url: "https://github.com/owner/repo/pull/8",
      prKey: "owner/repo#8",
    });
    assertEquals(get(), "owner/repo#1", "resubmit re-threads the learned root");
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.root_request_key, "owner/repo#1");
  });
});

test("startMerge reads root_request_key off the PR row onto the merge instance", async () => {
  await withGithubOff(async () => {
    const { data, engine, get } = captureRoot();
    await submitPr(
      data,
      engine,
      { repo: "owner/repo", number: 8, url: "https://github.com/owner/repo/pull/8", prKey: "owner/repo#8" },
      [],
      20,
      false,
      "owner/repo#1",
    );
    await startMerge(data, engine, {
      repo: "owner/repo",
      number: 8,
      url: "https://github.com/owner/repo/pull/8",
      prKey: "owner/repo#8",
      round: 2,
    });
    assertEquals(get(), "owner/repo#1");
  });
});

// The repository envelope drives the c8ctl harness's isolated workspace provisioning: it is
// emitted under the reserved `io.nanobpm.agentTask` namespace with the PR head branch as the
// checkout ref, and omitted entirely when the head branch couldn't be resolved (so the harness
// falls back to the legacy launch-dir behavior instead of cloning the wrong default branch).
test("repoEnvelopeVars emits the repository envelope keyed on the PR head branch", () => {
  const vars = repoEnvelopeVars("owner/repo", "feat/issue-12", "main");
  const env = (vars as any)["io.nanobpm.agentTask"];
  assertEquals(env.repository.url, "https://github.com/owner/repo.git");
  assertEquals(env.repository.ref, "feat/issue-12");
  assertEquals(env.repository.provider, "github");
  // Branch-scoped, blobless partial clone (issue #287): large monorepos provision within the clone
  // timeout while the full commit graph is kept so `git diff origin/<base>...HEAD` has a merge-base.
  assertEquals(env.repository.singleBranch, true);
  assertEquals(env.repository.filter, "blob:none");
  // The base branch is emitted so the harness fetches its tip, keeping `origin/<base>` reachable.
  assertEquals(env.repository.baseRef, "main");
});

test("repoEnvelopeVars omits baseRef when the base branch is unresolved", () => {
  const env = (repoEnvelopeVars("owner/repo", "feat/issue-12") as any)["io.nanobpm.agentTask"];
  // The single-branch/blobless partial-clone request still stands without a base ref…
  assertEquals(env.repository.singleBranch, true);
  assertEquals(env.repository.filter, "blob:none");
  // …but `baseRef` is omitted entirely rather than emitted as null (no key at all).
  assertEquals("baseRef" in env.repository, false);
});

test("repoEnvelopeVars emits nothing when the head branch is unresolved", () => {
  assertEquals(Object.keys(repoEnvelopeVars("owner/repo", null)).length, 0);
});

test("repoEnvelopeVars emits nothing for a malformed repo (not owner/repo)", () => {
  // Defence in depth: a repo that isn't exactly `owner/repo` would build a bogus clone URL, so the
  // helper emits no envelope (harness falls back to the launch dir) rather than a malformed URL.
  for (const bad of [
    "",
    "noslash",
    "a/b/c",
    "owner /repo",
    "owner/re po",
    "/repo",
    "owner/",
    // A trailing `.git` would build a double-suffixed clone URL (…/owner/repo.git.git).
    "owner/repo.git",
    "owner/repo.GIT",
    // Query/fragment/host-injection characters must never reach the clone URL.
    "owner/repo?x",
    "owner/repo#frag",
    "owner/repo:x",
    "owner/re~po",
    // Owner is a GitHub login: no dots or underscores allowed there.
    "own.er/repo",
    "own_er/repo",
  ]) {
    assertEquals(Object.keys(repoEnvelopeVars(bad, "feat/x")).length, 0, `expected no envelope for "${bad}"`);
  }
  // Well-formed repos still emit (guard is not over-eager): hyphens, dots and underscores
  // are legal in the repo-name segment, mixed case is preserved.
  for (const good of ["owner/repo", "my-org/my.repo", "Owner123/Repo_2", "a-b/c-d"]) {
    assertEquals(
      ((repoEnvelopeVars(good, "feat/x") as any)["io.nanobpm.agentTask"].repository.url),
      `https://github.com/${good}.git`,
      `expected envelope for "${good}"`,
    );
  }
});

test("repoEnvelopeVars emits commitSha only for a well-formed 40-hex SHA (world-restore, #324)", () => {
  const sha = "77ee0993cc6ad4493da0f7551212ef16722135db";
  const env = (repoEnvelopeVars("owner/repo", "feat/x", "main", sha) as any)["io.nanobpm.agentTask"];
  assertEquals(env.repository.commitSha, sha, "a valid 40-hex SHA is threaded through as the exact checkout target");
  // A non-SHA ref, an abbreviated SHA, or a whitespace-tainted value is dropped (no `commitSha` key):
  // it is forwarded to the harness as an EXACT checkout target, so a bad value could reconstruct to a
  // moved branch tip or fail provisioning. Omission degrades to the pre-#324 head-branch-tip clone.
  for (const bad of ["main", "feat/x", "77ee099", `${sha} `, ` ${sha}`, `${sha}\n`, "z".repeat(40), `${sha}0`, ""]) {
    const r = (repoEnvelopeVars("owner/repo", "feat/x", "main", bad) as any)["io.nanobpm.agentTask"].repository;
    assertEquals("commitSha" in r, false, `expected no commitSha for "${JSON.stringify(bad)}"`);
  }
  // Omitted entirely when there is no checkpoint SHA at all (the common first-activation case).
  const none = (repoEnvelopeVars("owner/repo", "feat/x", "main") as any)["io.nanobpm.agentTask"].repository;
  assertEquals("commitSha" in none, false);
});

// Durable-resume enrolment gate (issue #325, ADR 0062 Slice 5/5): `worldRestoreSha` — the seam
// `submitPr`/`startMerge` thread into `repoEnvelopeVars` — hands the harness the last push-checkpoint
// ONLY when the enrolled fleet advertises `durable-resume`. With no participant it degrades to null,
// so the round redrives from scratch (exactly as today). Proven against a REAL in-memory SQLite db
// with the world (049) + enrolment (052) schemas applied.
test("worldRestoreSha is gated on the durable-resume enrolment: participant → SHA, none → null", async () => {
  const { data } = memDataFor(["049_world_checkpoint.sql", "052_worker_durable_resume.sql"]);
  const PR = "owner/repo#7";
  const sha = "77ee0993cc6ad4493da0f7551212ef16722135db";
  await new WorldStore(data).recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: sha });

  // No participant enrolled yet — graceful degradation: no resume marker even though a checkpoint exists.
  assertEquals(await worldRestoreSha(data, PR), null, "no participant → redrive from scratch");

  // A non-participant enrolment still does not open the gate (a fleet of only non-participants).
  await new DurableResumeRegistry(data).recordEnrolment("legacy-1", false);
  assertEquals(await worldRestoreSha(data, PR), null, "only non-participants → still scratch");

  // One participant makes the mixed fleet resume-capable: the checkpoint SHA is now emitted.
  await new DurableResumeRegistry(data).recordEnrolment("modern-1", true);
  assertEquals(await worldRestoreSha(data, PR), sha, "a participant → resume at the checkpoint SHA");
});

test("worldRestoreSha is null when a participant is enrolled but the PR has no checkpoint yet", async () => {
  const { data } = memDataFor(["049_world_checkpoint.sql", "052_worker_durable_resume.sql"]);
  await new DurableResumeRegistry(data).recordEnrolment("modern-1", true);
  assertEquals(await worldRestoreSha(data, "owner/repo#8"), null, "nothing to reconstruct on a first activation");
});

// `parsePr` is total on any input: it is called unguarded from several workers (progress-check,
// persist-round, persist-escalation, record-dependency) with a process variable that a regression
// — or an older in-flight instance — could carry as a non-string. `.trim()` on a non-string throws,
// which would turn a should-fail-open caller into a retrying job. A non-string must resolve to
// `null` (fail closed) so every caller's fail-open path runs instead of the handler crashing.
test("parsePr fails closed to null on a non-string input (no throw)", () => {
  for (const bad of [undefined, null, 123, {}, [], true] as unknown[]) {
    assertEquals(parsePr(bad as any), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("parsePr still resolves a well-formed prKey and PR URL", () => {
  assertEquals(parsePr("owner/repo#42")?.prKey, "owner/repo#42");
  assertEquals(parsePr("  owner/repo#42  ")?.number, 42);
  assertEquals(parsePr("https://github.com/owner/repo/pull/7")?.repo, "owner/repo");
});

// Red/green regression for the level-triggered wave-merge barrier (issue #262). The barrier is
// armed (`plans.gate_wave = W`) at wave handoff, long BEFORE the token traverses the slow
// `trial-merge` agent job and finally opens the `wait-wave-merged` subscription. The old
// `pollWaveGates` was edge-triggered: the first pass that saw wave W's PRs merged cleared
// `gate_wave` and published `wave-merged` EXACTLY ONCE. If that happened while the token was still
// upstream (no open subscription), the message was dropped and — with `gate_wave` now null — never
// republished, so the epic wedged forever once the token arrived. The fix reconciles the merged
// state against the engine's OPEN-subscription state every pass, publishing only into an open
// subscription and never clearing `gate_wave` optimistically.
//
// Stubs `/message-subscriptions/search` (keyed by processInstanceKey) so the subscription can be
// toggled open between passes, and forces the GitHub transport off — the wave's PRs are tracked
// `merged` rows, so `isDepMerged` resolves them from the DB with no network.
function subscriptionFetch(open: Set<string>) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (!u.endsWith("/message-subscriptions/search")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      filter?: { processInstanceKey?: string };
    };
    const pik = body.filter?.processInstanceKey ?? "";
    const items = open.has(pik)
      ? [{ messageName: "wave-merged", correlationKey: "owner/repo#67", messageSubscriptionState: "CREATED" }]
      : [];
    return Promise.resolve(
      new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

test("pollWaveGatesImpl is level-triggered: PRs merged before the token arrives never lose the wave-merged signal (#262)", async () => {
  await withGithubOff(async () => {
    const PLAN_KEY = "owner/repo#67";
    const PI = "PI-13794";
    // Wave 1 opened two PRs; both are already MERGED (tracked rows → isDepMerged resolves from DB).
    const plan = {
      plan_key: PLAN_KEY,
      process_key: PI,
      gate_wave: 1 as number | null,
      updated_at: "t0",
    };
    const stores: Record<string, { rows: unknown[]; key: string }> = {
      plans: { rows: [plan], key: "plan_key" },
      plan_tasks: {
        rows: [
          { id: "owner/repo#67:a", plan_key: PLAN_KEY, wave: 1, status: "opened", pr_key: "owner/repo#68" },
          { id: "owner/repo#67:b", plan_key: PLAN_KEY, wave: 1, status: "opened", pr_key: "owner/repo#69" },
        ],
        key: "id",
      },
      pull_requests: {
        rows: [
          { pr_key: "owner/repo#68", status: "merged" },
          { pr_key: "owner/repo#69", status: "merged" },
        ],
        key: "pr_key",
      },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    } as any;

    const published: { name: string; correlationKey?: string }[] = [];
    const engine = {
      publishMessage: (input: { name: string; correlationKey?: string }) => {
        published.push(input);
        return Promise.resolve();
      },
    } as any;
    const headers = { "content-type": "application/json" };

    const openSubs = new Set<string>(); // token still upstream of wait-wave-merged → NO open subscription
    const prevFetch = globalThis.fetch;

    // Pass 1 — the losing ordering: wave 1's PRs are all merged, but the token is parked upstream on
    // the slow `trial-merge` job, so there is no open `wait-wave-merged` subscription yet. The old
    // single-shot barrier would publish-into-the-void and CLEAR `gate_wave`, stranding the epic.
    globalThis.fetch = subscriptionFetch(openSubs) as typeof fetch;
    try {
      await pollWaveGatesImpl(data, engine, "", "http://engine/v2", headers);
    } finally {
      globalThis.fetch = prevFetch;
    }
    // The signal must NOT have been fired into the void, and the gate must remain armed (not stranded).
    assertEquals(published.length, 0, "must not publish wave-merged with no open subscription");
    assertEquals(plan.gate_wave, 1, "gate_wave must stay armed until the barrier is actually released");

    // Pass 2 — the token has now advanced to `wait-wave-merged`, opening the subscription. The
    // level-triggered barrier re-publishes and correlates, releasing the token into wave 2.
    openSubs.add(PI);
    globalThis.fetch = subscriptionFetch(openSubs) as typeof fetch;
    try {
      await pollWaveGatesImpl(data, engine, "", "http://engine/v2", headers);
    } finally {
      globalThis.fetch = prevFetch;
    }
    assertEquals(published.length, 1, "must publish wave-merged once the subscription is open");
    assertEquals(published[0]?.name, "wave-merged");
    assertEquals(published[0]?.correlationKey, PLAN_KEY);
  });
});

// Guards the false-positive failure class flagged in review: `waveMergedSubscriptionOpen` must treat
// a search item with a missing/null/mismatched `messageName`, `correlationKey`, or
// `messageSubscriptionState` as NOT-open. Defaulting an unverifiable field to its expected value
// would publish `wave-merged` into a subscription we never confirmed open — buffering a message that
// trips a LATER wave's barrier, i.e. re-introducing the exact #262 wedge this change prevents. A
// false negative only costs a retry next pass; a false positive is a wedge, so unknown ⇒ don't match.
function ambiguousSubscriptionFetch(items: unknown[]) {
  return (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (!u.endsWith("/message-subscriptions/search")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    return Promise.resolve(
      new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

test("pollWaveGatesImpl never releases the barrier on an unverifiable subscription item (missing/null/mismatched fields)", async () => {
  await withGithubOff(async () => {
    const PLAN_KEY = "owner/repo#67";
    const PI = "PI-13794";
    const plan = {
      plan_key: PLAN_KEY,
      process_key: PI,
      gate_wave: 1 as number | null,
      updated_at: "t0",
    };
    const stores: Record<string, { rows: unknown[]; key: string }> = {
      plans: { rows: [plan], key: "plan_key" },
      plan_tasks: {
        rows: [
          { id: "owner/repo#67:a", plan_key: PLAN_KEY, wave: 1, status: "opened", pr_key: "owner/repo#68" },
          { id: "owner/repo#67:b", plan_key: PLAN_KEY, wave: 1, status: "opened", pr_key: "owner/repo#69" },
        ],
        key: "id",
      },
      pull_requests: {
        rows: [
          { pr_key: "owner/repo#68", status: "merged" },
          { pr_key: "owner/repo#69", status: "merged" },
        ],
        key: "pr_key",
      },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    } as any;

    const published: { name: string; correlationKey?: string }[] = [];
    const engine = {
      publishMessage: (input: { name: string; correlationKey?: string }) => {
        published.push(input);
        return Promise.resolve();
      },
    } as any;
    const headers = { "content-type": "application/json" };
    const prevFetch = globalThis.fetch;

    // Each of these items is ambiguous — it omits or mismatches a field the barrier requires. None
    // may be treated as an OPEN subscription for THIS plan, so none may release wave 1's gate.
    const ambiguousItems: unknown[][] = [
      [{}], // empty item — no fields at all
      [{ messageName: "wave-merged", correlationKey: PLAN_KEY }], // missing state
      [{ messageName: "wave-merged", correlationKey: PLAN_KEY, messageSubscriptionState: null }], // null state
      [{ correlationKey: PLAN_KEY, messageSubscriptionState: "CREATED" }], // missing messageName
      [{ messageName: "some-other-message", correlationKey: PLAN_KEY, messageSubscriptionState: "CREATED" }],
      [{ messageName: "wave-merged", messageSubscriptionState: "CREATED" }], // missing correlationKey
      [{ messageName: "wave-merged", correlationKey: "owner/repo#999", messageSubscriptionState: "CREATED" }],
    ];
    for (const items of ambiguousItems) {
      globalThis.fetch = ambiguousSubscriptionFetch(items) as typeof fetch;
      try {
        await pollWaveGatesImpl(data, engine, "", "http://engine/v2", headers);
      } finally {
        globalThis.fetch = prevFetch;
      }
    }
    assertEquals(published.length, 0, "must not publish wave-merged on an unverifiable subscription item");
    assertEquals(plan.gate_wave, 1, "gate_wave must stay armed while no OPEN subscription is confirmed");
  });
});

// #352: a wave WEDGES forever at `wait-wave-merged` when one member PR is closed on GitHub WITHOUT
// merging (abandoned / superseded / perpetually conflicting). The old gate released only when EVERY
// wave-target PR reached `merged`, so a closed-unmerged member kept `allMerged = false` forever and
// the epic could never advance. The fix classifies each target against live GitHub state and, for a
// closed-unmerged one, (a) treats it as NON-blocking so the wave completes on its surviving merged
// members and (b) reconciles it terminal — flipping BOTH the `pull_requests` row and its
// `plan_tasks` row to `abandoned` so it drops out of `waveMergeTargets` and the epic read model.
//
// Forces token transport WITH a token and stubs `fetch` to answer both the single-PR GET (the closed
// member reports state="closed", merged:false) and `/message-subscriptions/search` (barrier open).
function closedMemberFetch(open: Set<string>, closedNumbers: Set<number>) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const pullMatch = u.match(/\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
    if (pullMatch) {
      const n = Number(pullMatch[1]);
      const body = closedNumbers.has(n)
        ? { merged: false, state: "closed", mergeable_state: "dirty" }
        : { merged: true, state: "closed", mergeable_state: "clean" };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    if (u.endsWith("/message-subscriptions/search")) {
      const pik = (JSON.parse(String(init?.body ?? "{}")) as { filter?: { processInstanceKey?: string } })
        .filter?.processInstanceKey ?? "";
      const items = open.has(pik)
        ? [{ messageName: "wave-merged", correlationKey: "owner/repo#67", messageSubscriptionState: "CREATED" }]
        : [];
      return Promise.resolve(
        new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

test("pollWaveGatesImpl releases the wave when a member PR is closed-unmerged and reconciles it terminal (#352)", async () => {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "test-token"; // token present → fetchPrState hits the stubbed REST GET
  try {
    const PLAN_KEY = "owner/repo#67";
    const PI = "PI-13794";
    const plan = { plan_key: PLAN_KEY, process_key: PI, gate_wave: 2 as number | null, updated_at: "t0" };
    const stores: Record<string, { rows: any[]; key: string }> = {
      plans: { rows: [plan], key: "plan_key" },
      plan_tasks: {
        rows: [
          // A surviving MERGED member (tracked row → no network) and a member whose PR was CLOSED
          // on GitHub without merging while its task was still `opened` (never reached merge stage).
          { id: "owner/repo#67:a", plan_key: PLAN_KEY, wave: 2, status: "opened", pr_key: "owner/repo#68" },
          { id: "owner/repo#67:b", plan_key: PLAN_KEY, wave: 2, status: "opened", pr_key: "owner/repo#70" },
        ],
        key: "id",
      },
      pull_requests: {
        rows: [
          { pr_key: "owner/repo#68", status: "merged" },
          { pr_key: "owner/repo#70", status: "converging" }, // not merged in the DB → falls to live GitHub read
        ],
        key: "pr_key",
      },
      merges: { rows: [], key: "id" },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    } as any;

    const published: { name: string; correlationKey?: string }[] = [];
    const engine = {
      publishMessage: (input: { name: string; correlationKey?: string }) => {
        published.push(input);
        return Promise.resolve();
      },
    } as any;
    const headers = { "content-type": "application/json" };
    const prevFetch = globalThis.fetch;

    globalThis.fetch = closedMemberFetch(new Set([PI]), new Set([70])) as typeof fetch;
    try {
      await pollWaveGatesImpl(data, engine, "test-token", "http://engine/v2", headers);
    } finally {
      globalThis.fetch = prevFetch;
    }

    // The barrier RELEASES — the closed-unmerged member no longer wedges the wave.
    assertEquals(published.length, 1, "must publish wave-merged once the closed member is treated non-blocking");
    assertEquals(published[0]?.name, "wave-merged");
    assertEquals(published[0]?.correlationKey, PLAN_KEY);

    // The closed member is reconciled terminal: PR row + its plan_tasks row flip to `abandoned`,
    // and a terminal `merges` audit row is recorded (the canonical abandon writer).
    const prRow = stores.pull_requests.rows.find((r) => r.pr_key === "owner/repo#70");
    assertEquals(prRow?.status, "abandoned");
    const taskRow = stores.plan_tasks.rows.find((r) => r.id === "owner/repo#67:b");
    assertEquals(taskRow?.status, "abandoned");
    assertEquals(stores.merges.rows.length, 1);
    assertEquals((stores.merges.rows[0] as any).outcome, "abandoned");
    assertEquals((stores.merges.rows[0] as any).method, "pr-closed");
    // The surviving merged member is untouched.
    assertEquals(stores.plan_tasks.rows.find((r) => r.id === "owner/repo#67:a")?.status, "opened");
  } finally {
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
    else delete process.env["GITHUB_TOKEN"];
  }
});

// #352 review: `abandonClosedPr` must be genuinely idempotent. It is reached from BOTH observers of a
// closed-unmerged member (merge worker + wave gate) and can be retried by the poller, so an
// unconditional `merges` insert would spam the audit with duplicate `outcome:"abandoned"/method:
// "pr-closed"` rows and skew reporting. Re-running it re-stamps the terminal status but writes the
// audit row only once.
test("abandonClosedPr is idempotent — the terminal merges audit row is written at most once (#352)", async () => {
  const stores: Record<string, { rows: any[]; key: string }> = {
    pull_requests: { rows: [{ pr_key: "owner/repo#70", status: "converging" }], key: "pr_key" },
    plan_tasks: { rows: [{ id: "owner/repo#67:b", plan_key: "owner/repo#67", wave: 2, status: "opened", pr_key: "owner/repo#70" }], key: "id" },
    merges: { rows: [], key: "id" },
  };
  const data = {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;

  await abandonClosedPr(data, "owner/repo#70", "closed without merging");
  await abandonClosedPr(data, "owner/repo#70", "closed without merging"); // retry / second observer

  // Terminal status re-stamped, but exactly one audit row despite two calls.
  assertEquals(stores.pull_requests.rows.find((r) => r.pr_key === "owner/repo#70")?.status, "abandoned");
  assertEquals(stores.plan_tasks.rows.find((r) => r.id === "owner/repo#67:b")?.status, "abandoned");
  assertEquals(stores.merges.rows.length, 1, "no duplicate abandoned/pr-closed audit rows on retry");
  assertEquals((stores.merges.rows[0] as any).method, "pr-closed");
});


//
// plan-fanout parks a task with capability `needs` at the `wait-caps-resolved` message barrier. This
// reconciler, on every pass, (a) starts the durable `readiness-gate` once per need, (b) does a single
// DETERMINISTIC provenance lookup (`probeOnce`, reused verbatim), and (c) publishes `caps-resolved`
// (correlated on the per-task barrier key `<planKey>:<taskId>`) with the late-bound resolved-deps brief
// ONLY when EVERY need has shipped as a published `pkg@version` AND the barrier subscription is open.
//
// Stubs: `/message-subscriptions/search` (toggle the barrier open per barrier key), a capture engine
// (`createInstance`/`publishMessage`), and a `ProbeExec` returning a canned `gh api .../releases`
// payload so `matchCapability` resolves the lowest capability-bearing version — all hermetic.

function capsSubscriptionFetch(openKeys: Set<string>) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (!u.endsWith("/message-subscriptions/search")) throw new Error(`unexpected fetch: ${u}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      filter?: { messageName?: string; processInstanceKey?: string };
    };
    const key = body.filter?.processInstanceKey ?? "";
    // The reconciler filters by processInstanceKey + messageName; we toggle by barrier correlationKey,
    // which the search response carries back on each item. Return an open item for every requested key
    // registered in `openKeys` (keyed by the barrier correlationKey the caller expects).
    const items = [...openKeys]
      .filter((k) => k.startsWith(`${key}|`))
      .map((k) => ({
        messageName: "caps-resolved",
        correlationKey: k.slice(k.indexOf("|") + 1),
        messageSubscriptionState: "CREATED",
      }));
    return Promise.resolve(
      new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

// A `ProbeExec` whose `gh api .../releases` output resolves `capabilityRef` #274 to `@nanobpm/urban@0.54.0`
// (the LOWEST version whose body references #274) — or resolves nothing when `ready` is false.
function capsProbeExec(ready: boolean) {
  const releases = ready
    ? [
        { tag_name: "@nanobpm/urban@0.55.0", body: "## Provenance\n- nanobpm/nano-ide#274" },
        { tag_name: "@nanobpm/urban@0.54.0", body: "## Provenance\n- nanobpm/nano-ide#274" },
        { tag_name: "@nanobpm/urban@0.53.0", body: "unrelated" },
      ]
    : [{ tag_name: "@nanobpm/urban@0.53.0", body: "unrelated" }];
  const calls: string[] = [];
  return {
    calls,
    exec: {
      httpGet: () => Promise.reject(new Error("no http probe expected")),
      run: (command: string) => {
        calls.push(command);
        return Promise.resolve({ code: 0, stdout: JSON.stringify(releases), stderr: "" });
      },
    },
  };
}

function capsDataLayer(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
}

function capsEngine() {
  const created: { processDefinitionId?: string; variables?: Record<string, unknown> }[] = [];
  const published: { name: string; correlationKey?: string; variables?: Record<string, unknown> }[] = [];
  let seq = 0;
  return {
    created,
    published,
    engine: {
      createInstance: (req: { processDefinitionId?: string; variables?: Record<string, unknown> }) => {
        created.push(req);
        return Promise.resolve({ processInstanceKey: `RG-${++seq}` });
      },
      publishMessage: (input: { name: string; correlationKey?: string; variables?: Record<string, unknown> }) => {
        published.push(input);
        return Promise.resolve();
      },
    } as any,
  };
}

test("pollCapabilityGatesImpl: releases a task once every need ships, starting the gate + publishing the resolved brief (#289)", async () => {
  const PLAN_KEY = "owner/repo#7";
  const PI = "PI-289";
  const TASK = "gap-a";
  const barrierKey = `${PLAN_KEY}:${TASK}`;
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, process_key: PI }], key: "plan_key" },
    plan_task_needs: {
      rows: [
        {
          plan_key: PLAN_KEY,
          task_id: TASK,
          capability_ref: "nanobpm/nano-ide#274",
          package: "@nanobpm/urban",
          verify_command: null,
        },
      ],
      key: "plan_key",
    },
    capability_gates: { rows: [], key: "gate_key" },
  };
  const data = capsDataLayer(stores);
  const { engine, created, published } = capsEngine();
  const { exec, calls } = capsProbeExec(true);
  const headers = { "content-type": "application/json" };
  const open = new Set<string>([`${PI}|${barrierKey}`]);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = capsSubscriptionFetch(open) as typeof fetch;
  try {
    await pollCapabilityGatesImpl(data, engine, "http://engine/v2", headers, exec, {});
  } finally {
    globalThis.fetch = prevFetch;
  }

  // The durable readiness-gate was started exactly once, its instance key persisted.
  assertEquals(created.length, 1, "readiness-gate started exactly once");
  assertEquals(created[0]?.processDefinitionId, "readiness-gate");
  assertEquals(stores.capability_gates.rows.length, 1);
  assertEquals(stores.capability_gates.rows[0]?.process_key, "RG-1");
  assertEquals(stores.capability_gates.rows[0]?.status, "resolved");
  assertEquals(stores.capability_gates.rows[0]?.resolved_artifact, "@nanobpm/urban@0.54.0");

  // The barrier was released once with the late-bound brief pinning the LOWEST capability-bearing version.
  assertEquals(published.length, 1, "caps-resolved published once");
  assertEquals(published[0]?.name, "caps-resolved");
  assertEquals(published[0]?.correlationKey, barrierKey);
  const brief = String(published[0]?.variables?.["resolvedDepsBrief"] ?? "");
  assertEquals(brief.includes("@nanobpm/urban@0.54.0"), true, "brief pins the resolved artifact");
  assertEquals(brief.includes("nanobpm/nano-ide#274"), true, "brief names the capability ref");
  assertEquals(calls.length, 1, "one deterministic provenance lookup");
});

test("pollCapabilityGatesImpl: an unresolved need starts the gate but never releases the barrier (#289)", async () => {
  const PLAN_KEY = "owner/repo#8";
  const PI = "PI-290";
  const TASK = "gap-b";
  const barrierKey = `${PLAN_KEY}:${TASK}`;
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, process_key: PI }], key: "plan_key" },
    plan_task_needs: {
      rows: [
        {
          plan_key: PLAN_KEY,
          task_id: TASK,
          capability_ref: "nanobpm/nano-ide#274",
          package: "@nanobpm/urban",
          verify_command: null,
        },
      ],
      key: "plan_key",
    },
    capability_gates: { rows: [], key: "gate_key" },
  };
  const data = capsDataLayer(stores);
  const { engine, created, published } = capsEngine();
  const { exec } = capsProbeExec(false); // capability not published yet
  const headers = { "content-type": "application/json" };
  const open = new Set<string>([`${PI}|${barrierKey}`]);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = capsSubscriptionFetch(open) as typeof fetch;
  try {
    await pollCapabilityGatesImpl(data, engine, "http://engine/v2", headers, exec, {});
  } finally {
    globalThis.fetch = prevFetch;
  }

  // The gate is still started (bounded/durable wait + operator escalation) but no release.
  assertEquals(created.length, 1, "gate started even while unresolved");
  assertEquals(stores.capability_gates.rows[0]?.status, "pending");
  assertEquals(stores.capability_gates.rows[0]?.resolved_artifact, null);
  assertEquals(published.length, 0, "barrier NOT released until the capability ships");
});

test("pollCapabilityGatesImpl: level-triggered — no publish and no re-probe when the barrier subscription is not open (#289)", async () => {
  const PLAN_KEY = "owner/repo#9";
  const PI = "PI-291";
  const TASK = "gap-c";
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, process_key: PI }], key: "plan_key" },
    plan_task_needs: {
      rows: [
        {
          plan_key: PLAN_KEY,
          task_id: TASK,
          capability_ref: "nanobpm/nano-ide#274",
          package: "@nanobpm/urban",
          verify_command: null,
        },
      ],
      key: "plan_key",
    },
    capability_gates: { rows: [], key: "gate_key" },
  };
  const data = capsDataLayer(stores);
  const { engine, created, published } = capsEngine();
  const { exec, calls } = capsProbeExec(true);
  const headers = { "content-type": "application/json" };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = capsSubscriptionFetch(new Set<string>()) as typeof fetch; // barrier not parked
  try {
    await pollCapabilityGatesImpl(data, engine, "http://engine/v2", headers, exec, {});
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(published.length, 0, "no publish into a subscription that is not open");
  assertEquals(created.length, 0, "no gate work until the task is parked at the barrier");
  assertEquals(calls.length, 0, "no provenance probe until the task is parked at the barrier");
});

test("pollCapabilityGatesImpl: idempotent — a resolved gate is reused without a re-probe or a second publish (#289)", async () => {
  const PLAN_KEY = "owner/repo#10";
  const PI = "PI-292";
  const TASK = "gap-d";
  const barrierKey = `${PLAN_KEY}:${TASK}`;
  const gateKey = `${PLAN_KEY}:${TASK}:nanobpm/nano-ide#274:@nanobpm/urban`;
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, process_key: PI }], key: "plan_key" },
    plan_task_needs: {
      rows: [
        {
          plan_key: PLAN_KEY,
          task_id: TASK,
          capability_ref: "nanobpm/nano-ide#274",
          package: "@nanobpm/urban",
          verify_command: null,
        },
      ],
      key: "plan_key",
    },
    capability_gates: {
      rows: [
        {
          gate_key: gateKey,
          plan_key: PLAN_KEY,
          task_id: TASK,
          capability_ref: "nanobpm/nano-ide#274",
          package: "@nanobpm/urban",
          status: "resolved",
          resolved_artifact: "@nanobpm/urban@0.54.0",
          process_key: "RG-EXISTING",
          created_at: "t0",
          updated_at: "t0",
        },
      ],
      key: "gate_key",
    },
  };
  const data = capsDataLayer(stores);
  const { engine, created, published } = capsEngine();
  const { exec, calls } = capsProbeExec(true);
  const headers = { "content-type": "application/json" };
  const open = new Set<string>([`${PI}|${barrierKey}`]);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = capsSubscriptionFetch(open) as typeof fetch;
  try {
    await pollCapabilityGatesImpl(data, engine, "http://engine/v2", headers, exec, {});
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(created.length, 0, "already-started gate is never re-started");
  assertEquals(calls.length, 0, "already-resolved need is never re-probed");
  assertEquals(published.length, 1, "the still-parked barrier is released from the pinned artifact");
  assertEquals(published[0]?.correlationKey, barrierKey);
});

test("pollCapabilityGatesImpl: two needs sharing a capabilityRef across packages get distinct gate rows (#290)", async () => {
  // Regression for the gate_key collision: `capabilityGateKey` folds `package` into the key, so a task
  // that declares the SAME `capabilityRef` for two different packages tracks each `(capabilityRef,
  // package)` edge on its OWN gate row and starts its OWN readiness-gate. With the old package-blind key
  // the second need would alias the first row, only one gate would ever start, and the second package
  // could never resolve — wedging the barrier forever.
  const PLAN_KEY = "owner/repo#12";
  const PI = "PI-294";
  const TASK = "gap-f";
  const barrierKey = `${PLAN_KEY}:${TASK}`;
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, process_key: PI }], key: "plan_key" },
    plan_task_needs: {
      rows: [
        { plan_key: PLAN_KEY, task_id: TASK, capability_ref: "nanobpm/nano-ide#274", package: "@nanobpm/urban", verify_command: null },
        { plan_key: PLAN_KEY, task_id: TASK, capability_ref: "nanobpm/nano-ide#274", package: "@nanobpm/urban-testkit", verify_command: null },
      ],
      key: "plan_key",
    },
    capability_gates: { rows: [], key: "gate_key" },
  };
  const data = capsDataLayer(stores);
  const { engine, created, published } = capsEngine();
  const { exec } = capsProbeExec(false); // neither capability published yet — both stay pending
  const headers = { "content-type": "application/json" };
  const open = new Set<string>([`${PI}|${barrierKey}`]);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = capsSubscriptionFetch(open) as typeof fetch;
  try {
    await pollCapabilityGatesImpl(data, engine, "http://engine/v2", headers, exec, {});
  } finally {
    globalThis.fetch = prevFetch;
  }

  // Two distinct gate rows (one per package) — no collision, no aliasing.
  assertEquals(stores.capability_gates.rows.length, 2, "one gate row per (capabilityRef, package) need");
  const gateKeys = stores.capability_gates.rows.map((r) => r.gate_key).sort();
  assertEquals(gateKeys, [
    `${PLAN_KEY}:${TASK}:nanobpm/nano-ide#274:@nanobpm/urban`,
    `${PLAN_KEY}:${TASK}:nanobpm/nano-ide#274:@nanobpm/urban-testkit`,
  ]);
  assertEquals(created.length, 2, "each need starts its own readiness-gate");
  assertEquals(published.length, 0, "barrier NOT released while either need is unresolved");
});

test("pollCapabilityGatesImpl: scopes the barrier subscription search server-side by correlationKey (#290)", async () => {
  // Regression for the page-limit false negative: the capability barrier opens ONE subscription per
  // task, so a plan with many parked siblings can overflow a process+message-only search page and omit
  // THIS task's subscription — wedging its gate forever. The reconciler must therefore scope the search
  // by `correlationKey`. This stub emulates an engine that HONOURS the server-side `correlationKey`
  // filter: it returns the open item only when the request carries the matching key (as the real engine
  // does), so the old process+message-only filter would come back empty and never release the barrier.
  const PLAN_KEY = "owner/repo#11";
  const PI = "PI-293";
  const TASK = "gap-e";
  const barrierKey = `${PLAN_KEY}:${TASK}`;
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, process_key: PI }], key: "plan_key" },
    plan_task_needs: {
      rows: [
        {
          plan_key: PLAN_KEY,
          task_id: TASK,
          capability_ref: "nanobpm/nano-ide#274",
          package: "@nanobpm/urban",
          verify_command: null,
        },
      ],
      key: "plan_key",
    },
    capability_gates: { rows: [], key: "gate_key" },
  };
  const data = capsDataLayer(stores);
  const { engine, published } = capsEngine();
  const { exec } = capsProbeExec(true);
  const headers = { "content-type": "application/json" };
  const seenFilters: Array<Record<string, unknown>> = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (!u.endsWith("/message-subscriptions/search")) throw new Error(`unexpected fetch: ${u}`);
    const filter = (JSON.parse(String(init?.body ?? "{}")) as { filter?: Record<string, unknown> }).filter ?? {};
    seenFilters.push(filter);
    // Engine honours the server-side correlationKey filter: only the exactly-scoped query sees the item.
    const items =
      filter.correlationKey === barrierKey
        ? [{ messageName: "caps-resolved", correlationKey: barrierKey, messageSubscriptionState: "CREATED" }]
        : [];
    return Promise.resolve(
      new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  try {
    await pollCapabilityGatesImpl(data, engine, "http://engine/v2", headers, exec, {});
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(seenFilters[0]?.correlationKey, barrierKey, "search is scoped server-side by the barrier key");
  assertEquals(published.length, 1, "the scoped search still finds THIS task's subscription and releases it");
  assertEquals(published[0]?.correlationKey, barrierKey);
});
