// nano-workforce — the WORLD half of durable agent-session resume (issue #324, ADR 0062 Slice 4/5).
// Barrel over the world-restore surface: the effect ledger + fence, the durable store, the git
// inversion seam, and the checkpoint JOIN + RESTORE orchestration.

export {
  type CheckpointSink,
  type RestoreOptions,
  recordWorldCheckpoint,
  restoreWorld,
  type SessionCheckpoint,
  type WorldCheckpointInput,
  type WorldCheckpointResult,
  type WorldRestoreResult,
} from "./checkpoint.ts";
export {
  type Effect,
  type EffectKind,
  type Fence,
  type FenceOutcome,
  fenceReplay,
} from "./effect-ledger.ts";
export { execGitRunner, type GitRunner } from "./git.ts";
export { type LastCheckpoint, type RecordCheckpointInput, WorldStore } from "./store.ts";
