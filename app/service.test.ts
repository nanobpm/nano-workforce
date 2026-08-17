// Red/green regression for re-submit clearing stale open escalations (Magikcraft/nano-bpm
// #597/#599). When a cancelled/converged PR is re-submitted, `submitPr` re-opens it for a fresh
// convergence run. Any escalation left `open` by the prior run — plus the denormalised
// `open_escalation_*` pointer on the PR row — must be cleared, or the answer form resurfaces a
// dead "(no question provided)" question on the re-opened PR (the same stale-row class the plan
// loop already guards in `startPlan`). Drives `submitPr` against an in-memory data layer with the
// GitHub transport forced off so it is hermetic.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { parsePr, pollIncidentsImpl, pollWaveGatesImpl, repoEnvelopeVars, startMerge, submitPr } from "./service.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
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
  const vars = repoEnvelopeVars("owner/repo", "feat/issue-12");
  const env = (vars as any)["io.nanobpm.agentTask"];
  assertEquals(env.repository.url, "https://github.com/owner/repo.git");
  assertEquals(env.repository.ref, "feat/issue-12");
  assertEquals(env.repository.provider, "github");
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

test("pollWaveGates is level-triggered: PRs merged before the token arrives never lose the wave-merged signal (#262)", async () => {
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

test("pollWaveGates never releases the barrier on an unverifiable subscription item (missing/null/mismatched fields)", async () => {
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
