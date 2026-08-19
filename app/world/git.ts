// nano-workforce — the git seam for world-restore (issue #324, ADR 0062 Slice 4/5, the WORLD half).
//
// World-restore INVERTS the round's forward `git push`: on a replacement activation the outbound push
// of a SHA becomes an INBOUND `git fetch && git checkout <sha>` that reconstructs the exact working
// tree on a fresh worktree. This module is the thin, INJECTABLE git port that inversion runs over —
// `restoreWorld` (./checkpoint.ts) depends on the `GitRunner` interface, never on `child_process`
// directly, so the restore orchestration is unit-testable against a fake runner (no real repo).
//
// The production runner shells out to the host `git` with an argument VECTOR (no shell), mirroring
// `app/github.ts` `runGh` — a `pr_key`/SHA from the datastore is passed as an argv element and can
// never inject a command.

/** The minimal git surface world-restore needs — the inbound half of the push→pull inversion. */
export interface GitRunner {
  /** Fetch refs (and their objects) from `remote` so a subsequently-named SHA is reachable locally.
   * The forward op pushed to this remote; fetching is its inverse. */
  fetch(remote?: string): Promise<void>;
  /** Check the working tree out to an exact commit SHA — the reconstruction step. Detaches HEAD at
   * `<sha>`, which is precisely the durable resume boundary the round pushed. */
  checkout(ref: string): Promise<void>;
  /** Resolve a ref to its commit SHA (e.g. to confirm HEAD landed on the expected checkpoint). */
  revParse(ref: string): Promise<string>;
}

/** Run the host `git` with the given args in `cwd` (no shell — args are an argv vector, so a
 * datastore-sourced SHA cannot inject a command). Resolves stdout, rejects on non-zero exit with
 * stderr as the message. Mirrors `app/github.ts` `runGh`. */
async function runGit(args: string[], cwd?: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || "").trim() || err.message));
      else resolve(String(stdout));
    });
  });
}

/** The production `GitRunner` over the host `git`, operating in `cwd` (the provisioned worktree).
 * `fetch` requests the objects for a subsequent `checkout <sha>`; a bare SHA (not on a branch tip)
 * is fetchable when the remote allows it, which is the reconstruct-to-exact-SHA case. */
export function execGitRunner(cwd?: string): GitRunner {
  return {
    async fetch(remote = "origin") {
      await runGit(["fetch", remote], cwd);
    },
    async checkout(ref) {
      await runGit(["checkout", "--detach", ref], cwd);
    },
    async revParse(ref) {
      return (await runGit(["rev-parse", ref], cwd)).trim();
    },
  };
}
