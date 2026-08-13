// pr.ensure-base-branch — the durable, retriable head arm of ADR 0003 rule 2.
//
// `admitPlan` already ran `ensureBaseBranch` synchronously at admission (fail fast, so a missing
// non-`epic/*` base is a clean edge 400 and a missing `epic/*` base is created before fan-out).
// This head service task RE-RUNS the same idempotent primitive on the durable path — so a re-plan
// or a crash between admission and fan-out still guarantees the base exists. Because
// `ensureBaseBranch` never resets an existing ref, this is a clean no-op when the branch is already
// there; a missing `epic/*` base is created off default HEAD, and a missing non-`epic/*` base
// throws `BaseBranchMustExistError` (which fails the durable task rather than fanning out onto a
// wrong-rooted branch).
import type { AppJobHandler } from "@nanobpm/urban";
import { type EnsureBaseBranchResult, ensureBaseBranch } from "../../app/github.ts";

interface In extends Record<string, unknown> {
  repo: string;
  baseBranch: string;
}
interface Out extends Record<string, unknown> {
  baseBranchResult: EnsureBaseBranchResult;
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const repo = job.variables.repo;
  const branch = job.variables.baseBranch;
  const token = process.env.GITHUB_TOKEN ?? "";
  const result = await ensureBaseBranch(repo, branch, token);
  app.log.info("ensure-base-branch", { repo, branch, result });
  return { baseBranchResult: result };
};

export default handler;
