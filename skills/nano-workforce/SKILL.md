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

**This skill is a thin bootstrap.** Every running instance describes itself, over **MCP**
(§A, preferred) or through its **live operator guide** (§B). Reach that live surface and
follow it rather than a cached copy that drifts between versions.

## A. Preferred — drive over MCP

Every instance serves a Streamable-HTTP MCP endpoint at **`/app/mcp`**. Its tools are the
app's operations (projected from its OpenAPI spec) plus framework engine-debug tools. The
operator guide itself is the `getAgentInstructions` tool.

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

**Guard posture.** If `NANO_PR_WEBHOOK_SECRET` is set, every read and mutation needs it as an
`x-hook-secret` header (otherwise `401`). Put it in the server entry's `headers`, never in
chat. Delivery-graph dispatch is deliberately **not** a tool: it stays a human action in the
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
instance. Read it and follow it: orientation, submitting work, answering escalations,
debugging. **Re-fetch it every session.** For one section, use
`GET $BASE/agent/guide?section=<id>` (no `section` = table of contents).

## Principles

- **The live surface wins.** If this skill and the instance disagree, follow the instance.
- **Confirm the target instance** before any side-effecting call (name the MCP server entry,
  or ask when the base URL is ambiguous).
- **Preview before dispatch.** Show the user the plan before any bulk or side-effecting start.
  Dispatching a delivery graph is the operator's call.
- **Submissions are idempotent.** Re-submitting the same work must not double-dispatch.
- **Escalations are for humans.** Surface them with options; don't silently answer design or
  product decisions.
- **Merge intent is a read, not a write.** Every `/status` PR row carries a `merge` block —
  `requested` (the run's `autoMerge`), `enabled` (the deployment's `NANO_PR_AUTO_MERGE`),
  `effective`, and `blockedBy` (`"env"` | `"human-approval"` | `null`). Read it there; never
  write variables onto a running loop to change it. Such writes are unsupported and
  timing-dependent, not reliable no-ops — one landing while the loop awaits merge approval
  reaches `pr.finalize` unrestored and can change whether merging starts. Cancel and re-submit
  instead.
