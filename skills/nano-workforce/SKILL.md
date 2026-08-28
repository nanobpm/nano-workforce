---
name: nano-workforce
description: Drive and debug a running Nano Workforce instance — submit PRs for review convergence, submit issues/epics for plan→implement→converge, submit agent-authored delivery graphs (ADR 0005), answer escalations, and unstick stuck instances. Prefer the instance's MCP server (add it → its tools appear); fall back to the live operator guide. Use when the user asks to operate, drive, submit work to, or debug their Nano Workforce.
---

# Nano Workforce operator skill

Nano Workforce (nwf) is a durable orchestration app that drives pull requests to
**review convergence** and merges them, takes whole issues and **plans →
implements → converges** them across a fleet of coding agents, and runs
**agent-authored delivery graphs** (heterogeneous cross-repo, human-in-the-loop
DAGs — ADR 0005).

**This skill is a thin bootstrap by design.** It does not describe the endpoints.
Every running nwf instance is self-describing — over **MCP** where your client
supports it, and over its **live operator guide** everywhere else. Your job is to
reach that live surface and follow it, never to work from a cached copy that drifts
across versions and instances.

There are two paths. **Prefer MCP (§A).** If your client has no MCP support, use the
fetch-the-live-guide fallback (§B). Both talk to the same app; MCP is a projection of
the same OpenAPI contract, not a different system (ADR 0067).

## A. Preferred — drive over MCP

The Urban runtime serves a Streamable-HTTP MCP endpoint at **`/app/mcp`** for every
instance, with **zero app-side MCP code**: the app's operations are projected into
tools from its OpenAPI spec, alongside a framework-owned engine-debug tool family
(process instances, wait states, variables, incidents) and the app's projection
reads. The operator **playbook** (the same guide as §B) is served as an MCP
**resource**, so the workflow knowledge — orient first, preview before dispatch,
escalations are for humans — is discoverable over the same channel as the tools.

**Register one MCP server entry per instance.** Naming the instance
(`"drive workforce-merlin"`) makes the wrong-instance mistake structurally
impossible — tool calls are namespaced per server entry. For the Copilot CLI, in
`~/.copilot/mcp-config.json` (user-wide) or `.mcp.json` (repo-scoped):

```json
{
  "mcpServers": {
    "workforce-local": {
      "type": "http",
      "url": "http://localhost:3000/app/mcp",
      "tools": ["*"]
    },
    "workforce-merlin": {
      "type": "http",
      "url": "http://merlin.local:3000/app/mcp",
      "headers": { "x-hook-secret": "$NANO_PR_WEBHOOK_SECRET" },
      "tools": ["*"]
    }
  }
}
```

Or from the terminal:
`copilot mcp add --transport http workforce-local http://localhost:3000/app/mcp`
(add `--header` for a guarded instance). Claude/Cursor use the same server entries.

Then: start a session, confirm the `workforce-*` tools appear, and ask the agent to
use a **named** instance (`"Using workforce-local, show what's in flight and any open
escalations"`). It should call the status operation tool, not curl.

**Guard posture.** Reads (status, instances, incidents, projections, the playbook
resource) work from loopback with no credential. Mutations (submit work, answer
escalations, cancel/retry/resolve) require the instance's shared secret as a header
**when `NANO_PR_WEBHOOK_SECRET` is set** — put it in the server entry's `headers`,
never in chat. **Operator-only doors stay operator-only:** the delivery-graph
dispatch/dismiss lifecycle (the human clicking Dispatch *is* the approval, ADR 0005)
is `x-mcp`-excluded and is **not** a tool — dispatch stays a human action in the
cockpit.

The full server-entry recipes (multiple instances, Basic-Auth-fronted instances,
LAN exposure) live in the **agent-configuration runbook** — see the repo README
("Configure an agent over MCP") and [`docs/mcp-runbook.md`](../../docs/mcp-runbook.md).

## B. Fallback — no MCP client? Fetch the live guide

Agents without MCP are unchanged: resolve the instance, then fetch and follow its
live guide.

### B.1 Confirm which instance you are driving — always

A user typically runs **several** instances — a local dev copy, one on the LAN
(`http://merlin.local:3000/app/api`), and a public tunnel (ngrok) when off the LAN.
Every action is **side-effecting**, so targeting the wrong instance is a real
mistake. **Never silently default to a base URL.** Gather candidates, in order:

1. A named-instance registry the user maintains — first that exists:
   `$NANO_WORKFORCE_INSTANCES` (JSON `name → base URL`) or
   `~/.config/nano-workforce/instances.json` (same shape). This is also the source
   for the per-instance MCP server names in §A. Example:

   ```json
   { "local": "http://localhost:3000/app/api",
     "merlin": "http://merlin.local:3000/app/api",
     "remote": "https://<subdomain>.ngrok.app/app/api" }
   ```

2. `$NANO_WORKFORCE_URL`, if set (a single default; append `/app/api` only if it is
   a bare origin).
3. Any URL the user names in the conversation.
4. Local fallback: `http://localhost:3000/app/api` (port `PR_REVIEW_PORT`, default `3000`).

If the user named an instance, use it. Otherwise probe candidates for reachability
and ask which to use, marking which are live:

```bash
curl -sS --max-time 3 \
  ${NANO_PR_WEBHOOK_SECRET:+-H "x-hook-secret: $NANO_PR_WEBHOOK_SECRET"} \
  "$BASE/version" | jq '{appVersion, gitSha, uptimeSeconds}'
```

Only skip the question when exactly **one** candidate exists and is reachable — and
even then, name the instance you're about to drive before acting. If the user has
`$NANO_PR_WEBHOOK_SECRET` set, send it as `x-hook-secret` on every request.

### B.2 Fetch the live guide — your real playbook

```bash
curl -sS ${NANO_PR_WEBHOOK_SECRET:+-H "x-hook-secret: $NANO_PR_WEBHOOK_SECRET"} \
  "$BASE/agent" | jq -r '.instructions'
```

`GET /app/api/agent` (`getAgentInstructions`) returns
`{ format, appVersion, generatedAt, baseUrl, engineBase, instructions }` — the
authoritative, version-matched operator guide, every example keyed to this
instance. Read it in full and follow it for orientation, submitting work, answering
escalations, and debugging. **Re-fetch it at the start of every session.** (This is
the same prose the MCP playbook resource serves in §A.)

### B.3 Orient before acting

```bash
curl -sS "$BASE/version" | jq   # app/urban version, git sha, uptime
curl -sS "$BASE/status"  | jq   # every PR/instance in flight + open escalations
```

`/status` is the primary situational-awareness endpoint — check it before you submit
or unstick anything.

### B.4 What you can drive (all detailed in the live guide)

- **Submit a PR** for review convergence — `POST $BASE/actions/start/convergence-loop`.
- **Submit an issue/epic** for plan → implement → converge — `POST $BASE/actions/start/plan-fanout`.
- **Submit a delivery graph** (ADR 0005) — propose → preview → approve → **dispatch**.
  Compile/preview is a pure, side-effect-free path; **dispatch is an operator action
  in the cockpit**, not an agent door.
- **Answer an escalation** — `POST $BASE/actions/complete-user-task`, or the agent
  hook `POST $BASE/hooks/agent-complete` (`agentCompleteEscalation`).
- **Debug** — relate an in-flight PR to its engine process instance via `processKey`
  from `/status`, then inspect and unstick it against the engine REST base
  (`engineBase` from the guide).

## Principles

- **Discover, don't declare.** Prefer the live surface (MCP tools + playbook
  resource, or the live guide and `/status`) over any assumption baked into this
  file. If this skill and the live surface disagree, the live surface wins.
- **Confirm the target instance.** Never run a side-effecting call against an assumed
  base URL. With MCP, name the server entry; with the fallback, know — and when
  ambiguous, ask — which instance you're driving.
- **Preview before dispatch.** For delivery graphs and any bulk action, use the pure
  preview/validate path first and show the user the plan before the side-effecting
  start. Dispatch itself is the operator's call.
- **Idempotency.** Submissions carry dedupe keys; re-submitting the same work must not
  double-dispatch. Honour the keys the guide documents.
- **Escalations are for humans.** When the workforce parks on a human node, surface it
  with options; don't silently auto-answer design/product decisions.
