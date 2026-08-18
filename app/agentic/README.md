# `app/agentic/` — the app-tier agentic channel (ADR 0056)

This directory hosts the **agentic visibility plane** for nano-workforce (epic #142). H0 (#143)
owns the keystone wiring; siblings H1/H3/H4 extend it **without touching the boot script**.

## What H0 lands

- **`channel.ts`** — `mountAgenticChannel(...)`. Stands up the `@nanobpm/agentic` WebSocket channel
  + `AgenticHub` on the app's **own** HTTP server (`app.httpServer`, same port as the pages and
  `/app/api/hooks/*` — no sidecar port), authenticates upgrades on `/agentic` (ADR 0028 identity
  token; the capability credential was removed because it was accept-any friction), and
  mounts every discovered family. Returns a handle whose `teardown()` reverses everything.
- **`registry.ts`** — the `AgenticFamilyRegistry` seam + the `AgenticFamily` / `AgenticContext`
  contracts. Mounts families on boot, tears them down in **reverse** order on shutdown.
- **`loader.ts`** — auto-discovers `*.family.ts` modules under `families/`. There is **no central
  registration list** to append to, so siblings never collide on a shared file.
- **`families/`** — the discovery directory. Drop a family module here; `families/example.family.ts`
  is the copyable no-op template.

`main.ts` calls `mountAgenticChannel(...)` once after `runFromEnv`, and its `teardown()` once inside
the existing `drainAndExit`. **That is the only edit to `main.ts` / `drainAndExit` for the whole
epic.**

## How a sibling slice extends the channel (H1 / H3 / H4)

1. Copy `families/example.family.ts` to `families/<slice>.family.ts` and implement `mount(ctx)`
   (and optionally `teardown()`). `ctx` carries the reusable handles: `hub`, `registry`,
   `transport`, `data` (the app SQLite `DataLayer`), and `log`.
2. Own a message family via `ctx.hub.registerFamilyHandler("<family>", handler)` — the router
   refuses a duplicate, so two slices can't both claim one family.
3. **Do not** edit `main.ts`, `drainAndExit`, `channel.ts`, `registry.ts`, or `loader.ts`. You add
   exactly one new file.

## Reserved migration prefixes

Forward-only, additive (expand-only). The highest committed prefix when the epic began is `022`, so
H0 pre-allocates distinct prefixes to stop two siblings independently grabbing "the next" number:

| Slice            | Reserved migration file                     |
| ---------------- | ------------------------------------------- |
| H1 presence #144 | `db/migrations/023_agentic_presence.sql`    |
| H3 transcript #146 | `db/migrations/024_agentic_transcript.sql` |
| H4 blackboard #147 | `db/migrations/025_agentic_blackboard.sql` (only if a schema change is needed) |

H0 itself needs no migration.

## Configuration

The channel has three modes, selected by environment (see `main.ts`):

- **LOCAL mode (default)** — when neither `NANO_AGENTIC_SECRET` nor its fallback
  `NANO_PR_WEBHOOK_SECRET` is set, the channel **is** mounted with a well-known token: no credential
  is required, so peers on the trusted LAN can connect off-box. Exposure depends on network
  reachability (the server bind plus any reverse proxy/port forwarding); the startup `WARN` only
  fires when the hub can prove the HTTP server is bound non-loopback, so it won't flag exposure
  created by a same-host proxy forwarding `/agentic`.
- **SECURE mode** — set `NANO_AGENTIC_SECRET` (falls back to `NANO_PR_WEBHOOK_SECRET`) to require a
  shared identity secret (the same value on the hub and every peer), presented as `?token=…`.
- **Disabled** — set `NANO_AGENTIC=off` (or `0`/`false`/`no`) to not mount the channel at all.

## Event-sourced transcripts (#251)

The H3 transcript store (`db/migrations/024_agentic_transcript.sql`) is already **append-only and
offset-keyed** — the log half of dsh's event-sourced-session pattern. `transcript-events.ts` adds the
derivation half:

- **Typed, merge-extensible event vocabulary** — `parseTranscriptEvent` is the **one** parser that
  classifies each stored chunk into a typed `TranscriptEvent` (`message` / `tool-call` / `tool-result`
  / `turn` / `step` / `lifecycle`, plus `stream-chunk` for raw terminal bytes retained **verbatim** for
  byte-replay fidelity). A structured producer tags a chunk with the `nwfTranscriptEvent` marker;
  anything else stays a raw `stream-chunk`. Authors extend the vocabulary additively with
  `mergeTranscriptVocab` — never a second parser.
- **One `deriveView()` fold** — every higher-level view (the cockpit's structured message/tool/turn
  view in `cockpit/transcript-derive.ts`, and any future search / token-accounting / export consumer)
  is a **derivation** of the single log: "the log IS the state". `transcript-events.drift.test.ts`
  asserts exactly one parser (no consumer re-parses raw bytes).
- **Replay-by-reseed / fork** — `transcript-fork.ts` seeds a **new** stream from an existing log up to
  a chosen offset, so an exited session can be branched and replayed independently, offset-parity
  preserved. Byte-replay and resume-from-offset (`transcript-read.ts`) are untouched.

## Invariants (ADR 0056)

- **App-tier only** — never the engine. The Camunda-8 job protocol (worker⇄engine) is untouched;
  the agentic channel is the only new conversation.
- **Advisory** — a family never hard-locks or gates a BPMN sequence flow.
