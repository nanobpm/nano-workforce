# Configure an agent to drive/debug this workforce over MCP

> Adoption of the Urban runtime-served MCP surface ([ADR 0067](https://github.com/nanobpm/nano-ide/blob/main/docs/adr/0067-runtime-served-mcp-surface.md),
> nano-ide#488) — first consumer, nano-workforce#567. Written against the
> [Copilot CLI](https://github.com/github/copilot-cli) (the harness nwf's fleet
> uses). Claude/Cursor equivalents use the same server entries.

The Urban runtime serves a Streamable-HTTP MCP endpoint at **`/app/mcp`** for every
hosted app and projects this app's `openapi.yaml` into tools — **zero MCP server code
in nwf**. An MCP-capable agent gets nwf's operations (submit work, answer escalations,
read status, and the operator **guide** itself — `GET /app/api/agent`, projected as the
`getAgentInstructions` read tool), the framework-owned engine-debug tool family (process
instances, wait states, variables, incidents), the `urban_*` projection reads, and the
runtime's derived **system brief** as an MCP resource plus an orientation prompt — all
namespaced per server entry.

This replaces the SKILL.md instance-probing dance for MCP clients: naming the
instance (`"drive workforce-merlin"`) makes the wrong-instance mistake structurally
impossible. The named-instance registry (`NANO_WORKFORCE_INSTANCES` /
`~/.config/nano-workforce/instances.json`) remains the source for the fallback path
and a handy list of the entries to register here.

MCP is a **third door**, not a replacement: `GET /app/api/agent` (the live guide) and
`GET /app/api/agent/skill` are unchanged for agents without MCP — see
[§5 Fallback](#5-fallback).

## 1. One MCP server entry per instance

In `~/.copilot/mcp-config.json` (user-wide) or `.mcp.json` (repo-scoped):

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
    },
    "workforce-remote": {
      "type": "http",
      "url": "https://<subdomain>.ngrok.app/app/mcp",
      "headers": { "x-hook-secret": "$NANO_PR_WEBHOOK_SECRET" },
      "tools": ["*"]
    }
  }
}
```

Or from the terminal:

```bash
copilot mcp add --transport http workforce-local http://localhost:3000/app/mcp
# add --header for a guarded instance:
copilot mcp add --transport http workforce-merlin http://merlin.local:3000/app/mcp \
  --header "x-hook-secret: $NANO_PR_WEBHOOK_SECRET"
```

Tool calls are namespaced per server entry, so the instance you name is the instance
you drive.

### Instance behind Basic Auth? You need *both* headers

Two different layers. `x-hook-secret` is the **app's own** guard (checked by nwf in
the operation handler, only when `NANO_PR_WEBHOOK_SECRET` is set). **Basic Auth** is
enforced by whatever **fronts** the instance (ngrok edge, console proxy) and 401s
*before* the request ever reaches nwf:

```json
"headers": {
  "Authorization": "Basic <base64(user:pass)>",
  "x-hook-secret": "..."
}
```

Generate the blob with `printf '%s' 'user:pass' | base64` — `echo | base64` appends a
newline and yields the wrong value. The proxy must forward custom headers for
`x-hook-secret` to survive (most do by default). Base64 is encoding, not encryption:
only use Basic Auth over HTTPS. The fallback curl path needs both too:
`curl -u user:pass -H "x-hook-secret: …"`.

## 2. Verify discovery

New agent session → the `workforce-*` tools appear (app operations + the engine-debug
family). Ask:

> *"Using workforce-local, show what's in flight and any open escalations."*

The agent should call the status operation tool, not curl.

## 3. Debug a wedged instance

> *"workforce-local: PR nanobpm/nano-workforce#123 looks wedged — find its process
> instance, compare engine truth against the app's projections, and tell me where
> it's stuck."*

The agent has: instance search, wait states, variables, incidents (engine truth) +
the `urban_*` projection reads (app belief) + the operator guide (the
`getAgentInstructions` tool) for the convergence-loop-specific meaning of each wedge
shape. A wedge is frequently exactly a disagreement between the two planes.

## 4. Guard posture

Reads (status, instances, incidents, projections, the operator guide) work from
loopback with no
credential. Mutations (cancel/retry/resolve, `start/*` operations, answering
escalations) require the instance's secret as a header **when `NANO_PR_WEBHOOK_SECRET`
is set** — put it in the server entry's `headers`, never in chat. For a remote fleet,
`NANO_WORKFORCE_BASE_URL` reachability rules apply unchanged, and LAN exposure of
`/app/mcp` follows the same `network.bind` manifest setting as the rest of the app's
HTTP surface.

**Operator-only doors stay operator-only.** The staged delivery-graph lifecycle —
`stageDeliveryGraph`, `dispatchDeliveryGraph`, `dismissProposal` — is `x-mcp`-excluded
from the projected tool surface (ADR 0067 §2): the human clicking **Dispatch** in the
cockpit *is* the approval (ADR 0005 Decision 7), so an agent cannot dispatch a delivery
graph through MCP. Agents author graphs through the pure `compileDeliveryGraph` /
`previewDeliveryGraph` doors, which stay exposed.

## 5. Fallback

Agents without MCP are unchanged — resolve the instance, then
`curl -sS $BASE/agent | jq -r .instructions`, or load the
[`nano-workforce` skill](../skills/nano-workforce/SKILL.md), which fetches the same
live guide. `GET /app/api/agent` and `GET /app/api/agent/skill` keep working exactly as
before.
