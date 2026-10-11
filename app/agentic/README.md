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
  `NANO_PR_WEBHOOK_SECRET` is set, the channel **is** mounted with a well-known token: no *shared
  secret* (and no capability credential) is required — the well-known token is still presented, so
  peers on the trusted LAN can connect off-box. Exposure depends on network
  reachability (the server bind plus any reverse proxy/port forwarding); the startup `WARN` fires
  when the hub sees a non-loopback bind **or** cannot verify the bind at all (`server.address()` is
  `null`), so it won't flag exposure created by a same-host proxy forwarding `/agentic`.
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

## Job-ownership claims & authoritative reconnect resync (#713, #893)

The `claim` / `release` family (`families/claim.family.ts`) backs the {@link ClaimRegistry}
(`claim-registry.ts`) — the authoritative "which jobs a worker instance is running" visibility source
the supply snapshot reads. Each `claim` (wire code 8) / `release` (wire code 9) frame names its OWNING
`instance` explicitly, so one per-host supervisor connection can carry many workers' ownership frames.

**Authoritative resync (the supervisor's view wins).** On a WS reconnect a supervisor re-`register`s
every worker and re-`claim`s every active jobKey. Re-claims alone are *additive* — a claim that is not
re-asserted is never dropped, so a `release` lost during a hub outage would leave the job shown as
"working" until the worker exits entirely. To close that gap a supervisor may end its resync with an
**authoritative snapshot**: a `claim` frame enriched with the full `jobKeys` set it currently owns
(`{ instance, jobKeys: [...] }` — possibly empty, the meaningful "owns nothing now" resync). The hub
then calls `ClaimRegistry.replaceInstance(instance, jobKeys)`, which **drops every claim that instance
held but did not re-assert** and (re-)claims the snapshot's set. The snapshot rides the existing
`claim` wire family as a forward-compatible enrichment (the protocol's structural validators tolerate
the extra field), so **no new wire code** is needed.

The `claim` family thus carries **two payload variants** — the classic per-job claim
`{ instance, jobKey }` and the resync snapshot `{ instance, jobKeys }` (the `claim.snapshot` wire
contract in `app/contracts.ts`). The pinned `@nanobpm/agentic` validator predates the snapshot variant
and requires a non-empty `jobKey`, so the hub validates the **union** itself: a frame is well-formed
iff it is a valid snapshot (non-empty `instance` + a `jobKeys` string array) XOR a valid per-job
claim — and a frame carrying *both* fields must satisfy *both*, so the snapshot branch never bypasses
validation. Versioning the snapshot into the canonical `@nanobpm/agentic` protocol payloads is the
nano-ide follow-up issue #893 scopes ("coordinate with the `@nanobpm/agentic` package owners"); the
producer half (one snapshot per instance, including empty sets) is nano-supervisor#63.

Guarantees `replaceInstance` keeps:

- A claim re-asserted in the snapshot is unchanged.
- A jobKey that has **moved to another instance** is never blanked by the old instance's resync (the
  old instance no longer holds it, so the drop pass cannot touch it).
- Repeated resyncs are safe (idempotent).
- **Compatibility:** a supervisor that never sends a snapshot keeps the pre-#893 additive behaviour —
  claims are then cleared only by an explicit `release` or the presence-driven `reconcile`.

Authoritative replacement is safe because ownership is advisory, short-lived visibility the supervisor
can always restate; the registry never gates a BPMN flow (ADR 0056). This is what lets a downstream hub
client (nano-supervisor#63) **bound** its RELEASE buffer during an outage instead of buffering every
RELEASE without limit.

## Invariants (ADR 0056)

- **App-tier only** — never the engine. The Camunda-8 job protocol (worker⇄engine) is untouched;
  the agentic channel is the only new conversation.
- **Advisory** — a family never hard-locks or gates a BPMN sequence flow.
