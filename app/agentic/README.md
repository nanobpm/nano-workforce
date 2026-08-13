# `app/agentic/` — the app-tier agentic channel (ADR 0056)

This directory hosts the **agentic visibility plane** for nano-workforce (epic #142). H0 (#143)
owns the keystone wiring; siblings H1/H3/H4 extend it **without touching the boot script**.

## What H0 lands

- **`channel.ts`** — `mountAgenticChannel(...)`. Stands up the `@nanobpm/agentic` WebSocket channel
  + `AgenticHub` on the app's **own** HTTP server (`app.httpServer`, same port as the pages and
  `/app/api/hooks/*` — no sidecar port), authenticates upgrades on `/agentic` (ADR 0028 identity
  token + a required capability credential, mirroring the blackboard hook's `?token=…` pattern), and
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

- `NANO_AGENTIC_SECRET` (falls back to `NANO_PR_WEBHOOK_SECRET`) — the shared identity secret peers
  present as `?token=…`. When neither is set, the channel is **not mounted** (logged), so the app
  never exposes an unauthenticated upgrade.

## Invariants (ADR 0056)

- **App-tier only** — never the engine. The Camunda-8 job protocol (worker⇄engine) is untouched;
  the agentic channel is the only new conversation.
- **Advisory** — a family never hard-locks or gates a BPMN sequence flow.
