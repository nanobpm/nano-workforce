// pr.friction-file — the friction sweep's filing step (issue #1073). Deterministic host code: takes
// the analyst's proposed `findings`, dedupes them by fingerprint against the open `friction` issues in
// `NANO_FRICTION_REPO` (a match gets a recurrence comment, never a duplicate issue), applies the
// occurrence/run thresholds to new findings, and opens the rest (app/friction.ts `fileFindings`). With
// no findings it makes no GitHub call at all. Issue links are
// persisted (recordFiled → friction_filings) for the Friction page the summary task links to.
import type { AppJobHandler } from "@nanobpm/urban";
import {
  fileFindings,
  frictionConfig,
  frictionGithub,
  frictionSweeps,
  markFailed,
  observedSignalCounts,
  parseFindings,
  recordFiled,
} from "../../app/friction.ts";

interface Out extends Record<string, unknown> {
  /** `filed` (the summary task follows) or `failed` (the sweep releases its lease and ends). */
  fileStatus: string;
  createdIssues: string[];
  updatedIssues: string[];
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
}

const handler: AppJobHandler<Record<string, unknown>, Out> = async (job, app) => {
  const sweepKey = job.processInstanceKey != null ? String(job.processInstanceKey) : "";
  const v = job.variables;
  const windowStart = typeof v.windowStart === "string" ? v.windowStart : "";
  const windowEnd = typeof v.windowEnd === "string" ? v.windowEnd : "";
  const { findings, malformed } = parseFindings(v.findings);
  let res: Awaited<ReturnType<typeof fileFindings>>;
  try {
    res = await fileFindings(
      { github: frictionGithub(process.env.GITHUB_TOKEN ?? ""), config: frictionConfig(), window: { start: windowStart, end: windowEnd },
        observed: (fps) => observedSignalCounts(app.data, sweepKey, fps),
      },
      findings,
      malformed,
    );
  } catch (err) {
    // The error path must still release the singleton lease (issue #1073): report `failed` so the
    // model routes to the release step instead of parking the sweep on an incident. A finding filed
    // before the error carries its fingerprint marker, so the next sweep comments rather than re-files.
    app.log.warn("friction file failed", { sweepKey, error: String(err) });
    if (sweepKey !== "") await markFailed(app.data, sweepKey, String(err), new Date());
    return { fileStatus: "failed", createdIssues: [], updatedIssues: [], createdCount: 0, updatedCount: 0, skippedCount: 0 };
  }
  const at = new Date().toISOString();
  if (sweepKey !== "" && (await frictionSweeps(app.data).get(sweepKey))) await recordFiled(app.data, sweepKey, res, at);
  app.log.info("friction file", { sweepKey, created: res.created.length, updated: res.updated.length, skipped: res.skipped });
  return {
    fileStatus: "filed",
    createdIssues: res.created,
    updatedIssues: res.updated,
    createdCount: res.created.length,
    updatedCount: res.updated.length,
    skippedCount: res.skipped,
  };
};

export default handler;
