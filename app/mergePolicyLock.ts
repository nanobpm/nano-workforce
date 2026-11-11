/** In-process keyed serializer for the merge-policy projection (issue #947, PR #950 review).
 *
 *  Two writers touch one convergence loop's `humanApproval` policy as an engine-write +
 *  projection-stamp PAIR: gated adoption (`submitPr`: `setVariables(humanApproval: true)` then stamp
 *  `merge_human_approval = 1`) and a `merge-approval` approve (`completeUserTask` then stamp `0`).
 *  Interleaved, the adopter's stale `1` can land after the approval's `0`, so `/status` reports a
 *  phantom `human-approval` block. Every such pair runs under this lock keyed by the loop's process
 *  instance key, so the pairs are applied in a single total order and the projection always matches
 *  the last engine write. The app is a single node process, so an in-memory promise chain suffices. */
const tails = new Map<string, Promise<unknown>>();

export async function withMergePolicyLock<T>(processKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(processKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(processKey, tail);
  try {
    return await run;
  } finally {
    if (tails.get(processKey) === tail) tails.delete(processKey);
  }
}
