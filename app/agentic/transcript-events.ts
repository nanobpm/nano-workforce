// nano-workforce — the transcript EVENT grammar, DERIVED from its one canonical owner (issue #676).
//
// The transcript event-sourced session layer (ADR 0056, #251) — the marker/version, the ONE parser,
// the merge-extensible vocabulary, the typed event union, and the single {@link deriveView} fold — is
// now DEFINED once, in `@nanobpm/agentic/transcript` (published in agentic 0.10.0 via nano-ide#534).
// nano-workforce used to carry a byte-for-byte hand-rolled duplicate of that grammar here; two copies
// of one envelope grammar is exactly the DRIFT SURFACE our "Derivation Over Duplication" doctrine
// forbids — the day agentic's grammar evolved (a new event kind, a marker/version bump, a decoder fix)
// this fork would silently keep decoding by the old rules and the cockpit transcript view would
// diverge.
//
// So this module is now a THIN RE-EXPORT BARREL over the single source of truth: every consumer
// (cockpit render, transcript-read, permission-bridge, token accounting, export) keeps importing the
// grammar from here, but the grammar itself lives in exactly one place — agentic. There is NO local
// definition of the marker, NO local re-parse of a stored chunk, and NO forked vocabulary; the
// canonical `mergeTranscriptVocab` / `CORE_TRANSCRIPT_VOCAB` are re-exported so a future nwf-specific
// event kind stays an additive merge, never a fork of the parser. `transcript-events.drift.test.ts`
// pins this structurally — it fails if a local envelope grammar or a chunk re-parser ever reappears.
export * from "@nanobpm/agentic/transcript";
