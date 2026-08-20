---
name: nano-workforce
description: Drive and debug a running Nano Workforce instance — submit PRs for review convergence, submit issues/epics for plan→implement→converge, submit agent-authored delivery graphs (ADR 0005), answer escalations, and unstick stuck instances. Use when the user asks to operate, drive, submit work to, or debug their Nano Workforce.
---

# Nano Workforce operator skill

Nano Workforce (nwf) is a durable orchestration app that drives pull requests to
**review convergence** and merges them, takes whole issues and **plans →
implements → converges** them across a fleet of coding agents, and runs
**agent-authored delivery graphs** (heterogeneous cross-repo, human-in-the-loop
DAGs — ADR 0005).

**This skill is a thin bootstrap by design.** It does not describe the endpoints.
Every running nwf instance serves its own operator guide, *live*, keyed to that
instance's URLs and matched to its deployed version. Your job is to fetch that
guide and follow it — never to work from a cached copy, which drifts across
versions and instances.

## 1. Confirm which instance you are driving — always

A user typically runs **several** Nano Workforce instances — e.g. a local dev copy,
one on the LAN (`http://merlin.local:3000/app/api`), and a public tunnel
(an ngrok URL) when off the LAN. Every action here is **side-effecting** —
submitting work, answering escalations, merging PRs — so targeting the wrong
instance is a real mistake, not a harmless one. **Never silently default to a
base URL.**

### Sources of candidate instances

Gather candidates from, in order:

1. **A named-instance registry** the user maintains — first of these that exists:
   `$NANO_WORKFORCE_INSTANCES` (JSON object of `name → base URL`), or
   `~/.config/nano-workforce/instances.json` (same shape). Example:

   ```json
   { "local": "http://localhost:3000/app/api",
     "merlin": "http://merlin.local:3000/app/api",
     "remote": "https://<subdomain>.ngrok.app/app/api" }
   ```

2. `$NANO_WORKFORCE_URL`, if set (a single default; accept as-is, append `/app/api`
   only if it is a bare origin).
3. Any URL the user names in the conversation.
4. Local fallback: `http://localhost:3000/app/api` (port `PR_REVIEW_PORT`, default `3000`).

### Choosing

- If the user **named an instance** (by name from the registry, or by URL), use it.
- Otherwise, **probe the candidates for reachability** and ask the user which to
  use, offering the candidates as choices and marking which are live. Reachability
  disambiguates the common case — off the LAN, `merlin.local` won't resolve, so the
  tunnel instance is the live one:

  ```bash
  # For each candidate base, a fast liveness + identity check:
  curl -sS --max-time 3 \
    ${NANO_PR_WEBHOOK_SECRET:+-H "x-hook-secret: $NANO_PR_WEBHOOK_SECRET"} \
    "$BASE/version" | jq '{appVersion, gitSha, uptimeSeconds}'
  ```

- Only skip the question when exactly **one** candidate exists and is reachable —
  and even then, **name the instance you're about to drive** before acting.

Some instances guard the agent endpoints with a shared secret. If the user has
`$NANO_PR_WEBHOOK_SECRET` set, send it as `x-hook-secret` on every request below.

## 2. Fetch the live guide — this is your real playbook

```bash
curl -sS ${NANO_PR_WEBHOOK_SECRET:+-H "x-hook-secret: $NANO_PR_WEBHOOK_SECRET"} \
  "$BASE/agent" | jq -r '.instructions'
```

`GET /app/api/agent` (`getAgentInstructions`) returns
`{ format, appVersion, generatedAt, baseUrl, engineBase, instructions }`. The
`instructions` markdown is the authoritative, version-matched operator guide, with
every example already keyed to this instance's `baseUrl`/`engineBase`. Read it in
full and follow it for everything that follows — orientation, submitting work,
answering escalations, and debugging.

**Always re-fetch the guide at the start of a session.** It is the source of truth;
this skill only tells you how to find it.

## 3. Orient before acting

The guide's first steps confirm what is live and what is in flight:

```bash
curl -sS "$BASE/version" | jq   # app/urban version, git sha, uptime
curl -sS "$BASE/status"  | jq   # every PR/instance in flight + open escalations
```

`/status` is the primary situational-awareness endpoint — check it before you
submit or unstick anything.

## 4. What you can drive (all detailed in the live guide)

- **Submit a PR** for review convergence — `POST $BASE/actions/start/convergence-loop`.
- **Submit an issue/epic** for plan → implement → converge across the fleet —
  `POST $BASE/actions/start/plan-fanout`.
- **Submit a delivery graph** (ADR 0005) — propose → preview → approve → dispatch.
  Compile/preview is a pure, side-effect-free tool; only the start door dispatches.
  The live guide documents the exact operations once the instance exposes them.
- **Answer an escalation** (a durable user task the workforce parked on) —
  `POST $BASE/actions/complete-user-task`, or the agent hook
  `POST $BASE/hooks/agent-complete` (`agentCompleteEscalation`).
- **Debug**: relate an in-flight PR to its engine process instance via `processKey`
  from `/status`, then use the engine REST base (`engineBase` from the guide) to
  inspect and unstick it.

## Principles

- **Discover, don't declare.** Prefer the live guide and live `/status` over any
  assumption baked into this file. If this skill and the guide disagree, the guide
  wins.
- **Confirm the target instance.** Never run a side-effecting call against an
  assumed base URL. Know — and when ambiguous, ask — which instance you're driving.
- **Preview before dispatch.** For delivery graphs and any bulk action, use the
  pure preview/validate path first and show the user the plan before the
  side-effecting start call.
- **Idempotency.** Submissions carry dedupe keys; re-submitting the same work must
  not double-dispatch. The guide documents the keys — honour them.
- **Escalations are for humans.** When the workforce parks on a human node, surface
  it to the user with options; don't silently auto-answer design/product decisions.
