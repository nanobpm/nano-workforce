// Shared hermetic GitHub stub for the ADR-0003 base-branch admission (`admitPlan` +
// the `pr.ensure-base-branch` head task). The e2e suites that drive `startPlanFanout` now
// pass through admission, which reads the default branch, checks the base ref, and creates a
// missing `epic/*` base off default HEAD. There is no network in e2e, so we pin the `token`
// transport (`useGh()` is always false in `token` mode → every call routes through `fetch`,
// never the `gh` subprocess) and intercept `globalThis.fetch` for the three admission
// endpoints. This mirrors `workers/ensure-base-branch/head-task.integration.test.ts`.
//
// The live nightly exercises the real `gh` transport against GitHub; this stub deliberately
// only covers the hermetic `token` path.
import { resetDefaultBranchCache } from "../../app/github.ts";

export interface AdmitGithubState {
  repo: string;
  defaultBranch: string;
  branches: Map<string, string>; // branch → head sha
  creates: { ref: string; sha: string }[];
  resets: string[]; // any PATCH/force-update on an existing ref (must stay empty)
}

/** Build a fresh admit-github state with the default branch pre-seeded with a HEAD sha so an
 *  `epic/*` base can be created off it. */
export function admitGithubState(
  repo = "owner/repo",
  defaultBranch = "main",
): AdmitGithubState {
  return {
    repo,
    defaultBranch,
    branches: new Map([[defaultBranch, "0".repeat(40)]]),
    creates: [],
    resets: [],
  };
}

function admitFetch(state: AdmitGithubState) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

    // GET /repos/{repo} → default branch (fetchDefaultBranch).
    if (method === "GET" && path === `/repos/${state.repo}`) {
      return Promise.resolve(json({ default_branch: state.defaultBranch }));
    }
    // GET /repos/{repo}/git/ref/heads/{branch} → head sha or 404 (branchHeadSha).
    const refPrefix = `/repos/${state.repo}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      const sha = state.branches.get(branch);
      if (sha === undefined) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(json({ ref: `refs/heads/${branch}`, object: { sha } }));
    }
    // POST /repos/{repo}/git/refs → create a ref (createBranchRef); 422 if it already exists.
    if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
      // biome-ignore lint/plugin: runtime contract boundary for parsed JSON
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const ref = String(body.ref ?? "");
      const sha = String(body.sha ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (state.branches.has(branch)) {
        return Promise.resolve(json({ message: "Reference already exists" }, 422));
      }
      state.creates.push({ ref, sha });
      state.branches.set(branch, sha);
      return Promise.resolve(json({ ref }, 201));
    }
    // A ref force-update (reset) would be a PATCH; the idempotent head task must NEVER issue one.
    if (method === "PATCH" && path.startsWith(`/repos/${state.repo}/git/refs/heads/`)) {
      state.resets.push(decodeURIComponent(path.split("/git/refs/heads/")[1] ?? ""));
      return Promise.resolve(json({ ok: true }));
    }
    // Any other endpoint is a best-effort read the sealed transport used to skip → 404 (null).
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

/** Install the hermetic admit-github stub: pin the `token` transport with a dummy token and swap
 *  `globalThis.fetch`. Returns a restore function that reverts env + fetch and clears the
 *  default-branch cache so no state leaks between suites. */
export function installAdmitGithub(state: AdmitGithubState): () => void {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "e2e-admit-token";
  resetDefaultBranchCache();
  globalThis.fetch = admitFetch(state) as typeof fetch;
  return () => {
    globalThis.fetch = prevFetch;
    resetDefaultBranchCache();
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  };
}
