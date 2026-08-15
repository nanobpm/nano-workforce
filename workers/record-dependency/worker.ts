// pr.record-dependency — a merge-stage agent discovered that this PR cannot land until ANOTHER
// PR merges first (e.g. a stacked base PR must land, or a sibling PR closes an issue this one
// requires). That is a WAIT, not a human escalation: record the discovered edge(s) in the
// `pr_dependencies` DAG and park the PR back in `waiting_deps` so the merge poller's dependency
// pass (`pollMerges` block 1) advances it — publishing `deps-cleared` — once every named PR has
// merged. The process re-enters its existing `wait-deps` catch, so no human has to babysit an
// ordering constraint the machinery already knows how to satisfy.
//
// `dependsOn` is whatever the agent returned (see resources/prompts/fix-ci.md, resources/prompts/rebase.md): a
// string of one or more `owner/repo#N` refs (or PR URLs) separated by commas/whitespace/newlines,
// or an array of such tokens. We parse each robustly (reusing `parsePr`), drop self-references and
// duplicates, and insert missing edges idempotently — a worker retry never double-inserts, and an
// already-recorded edge is a no-op.
import type { AppJobHandler } from "@nanobpm/urban";
import { ensurePr, parsePr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordDepIn` in merge-loop.bpmn) — ADR 0040. The
// scalar `dependsOn` carries the agent's `owner/repo#N` refs as one string; `parseDependsOn` below
// still tolerates the legacy array shape defensively.
type In = WorkerInputs["pr.record-dependency"];

interface DependencyRow {
  pr_key: string;
  depends_on_key: string;
  created_at: string;
}

/** Normalize the agent's `dependsOn` into a de-duplicated list of `owner/repo#N` keys.
 * Accepts a string (split on commas/whitespace/newlines) or an array of such tokens; unparseable
 * tokens are ignored, mirroring `parseDependsOn`'s tolerance for the `Depends-on:` PR-body line. */
function parseDependsOn(raw: unknown): string[] {
  const tokens: string[] = [];
  if (typeof raw === "string") {
    tokens.push(...raw.split(/[,\s]+/));
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") tokens.push(...item.split(/[,\s]+/));
    }
  }
  const out = new Set<string>();
  for (const tok of tokens) {
    const parsed = parsePr(tok);
    if (parsed) out.add(parsed.prKey);
  }
  return [...out];
}

const handler: AppJobHandler<In> = async (job, app) => {
  const prKey = job.variables.prKey;
  const depKeys = parseDependsOn(job.variables.dependsOn);
  const ts = new Date().toISOString();

  const depTable = app.data.table<DependencyRow>("pr_dependencies", "pr_key");

  // Append the discovered edges to whatever the plan DAG already declared — never wipe the set
  // (a `registerDependencies`-style replace would drop still-relevant sibling ordering). Dedupe
  // against existing rows so this is safe to retry.
  const existing = await depTable.find({ pr_key: prKey });
  const have = new Set(existing.map((d) => d.depends_on_key));
  let recorded = 0;
  for (const depKey of depKeys) {
    if (depKey === prKey || have.has(depKey)) continue; // never wait on self; skip known edges
    await depTable.insert({ pr_key: prKey, depends_on_key: depKey, created_at: ts });
    have.add(depKey);
    recorded += 1;
  }

  if (depKeys.length === 0) {
    // The agent signalled "waiting-on-pr" but named no parseable PR. Whether this actually strands
    // the PR depends on the existing DAG: with no other edges the poller clears it immediately (an
    // empty dep set trivially "all merged"); if prior edges already exist it will keep waiting on
    // those. Either way the miswiring — a "waiting-on-pr" signal with no parseable ref — is a
    // defect worth logging loudly.
    const clause =
      have.size === 0
        ? "it will clear immediately (no other dependencies recorded)"
        : `it still has ${have.size} previously-recorded dependency edge(s) to wait on`;
    app.log(
      "error",
      `record-dependency: ${prKey} reported waiting-on-pr but no parseable dependsOn ref; ` +
        `${clause}. Raw: ${JSON.stringify(job.variables.dependsOn)}`,
    );
  }

  // Heal a missing FK parent (engine/app.db desync) before updating `pull_requests`; otherwise the
  // update silently no-ops and the instance re-enters `wait-deps` with no row for the merge poller
  // to watch — wedging the merge loop. Mirrors persist-round's heal; repo/number are derived from
  // the canonical `owner/repo#N` prKey since the RecordDepIn envelope carries only prKey/dependsOn.
  const parsed = parsePr(prKey);
  if (parsed) {
    await ensurePr(app.data, { prKey, repo: parsed.repo, number: parsed.number, url: parsed.url });
  }

  // Park the PR back in the merge-stage dependency wait so `pollMerges` block 1 watches it.
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "waiting_deps",
    updated_at: ts,
  });

  app.log("info", `record-dependency: ${prKey} waiting on ${depKeys.length} PR(s)`, {
    prKey,
    dependsOn: depKeys,
    recorded,
  });

  return {};
};

export default handler;
