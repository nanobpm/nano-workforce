# Agent skills

Portable agent skills that ship with Nano Workforce. A skill is a `SKILL.md` with
YAML frontmatter (`name`, `description`) that an agent runtime (Copilot CLI, Claude)
loads on demand when its `description` matches the task.

## `nano-workforce`

A **thin bootstrap** that teaches any agent to operate a running Nano Workforce
instance. Where the client supports **MCP**, it registers the instance's `/app/mcp`
server (its tools appear automatically, including the operator guide as the
`getAgentInstructions` tool — ADR 0067); where
it does not, it resolves the instance base URL and fetches the instance's *live*
operator guide (`GET /app/api/agent`), then follows it. Either way it deliberately holds
no endpoint detail of its own — the live, version-matched surface is the source of truth.
See [`docs/mcp-runbook.md`](../docs/mcp-runbook.md) for the MCP server-entry recipes.

### Install

Copy or symlink the skill into your agent's skills directory. For Copilot CLI:

```bash
# symlink so it tracks this repo
ln -s "$(pwd)/skills/nano-workforce" ~/.copilot/skills/nano-workforce
# …or copy it
cp -r skills/nano-workforce ~/.copilot/skills/nano-workforce
```

Then, from an agent session against your instance:

```
Load the nano-workforce skill and drive my workforce.
```

Set `NANO_WORKFORCE_URL` (and `NANO_PR_WEBHOOK_SECRET`, if your instance guards the
agent endpoints) so the bootstrap can reach your instance without prompting.

### Multiple instances

If you run more than one instance (a local copy, one on the LAN, a tunnel when
you're off-LAN), register them by name so the skill can offer a choice and probe
which is live. Set `NANO_WORKFORCE_INSTANCES`, or write
`~/.config/nano-workforce/instances.json`:

```json
{
  "local":  "http://localhost:3000/app/api",
  "merlin": "http://merlin.local:3000/app/api",
  "remote": "https://<subdomain>.ngrok.app/app/api"
}
```

Then just say *"drive merlin"* — or let the skill probe reachability and ask which
to use (off the LAN, `merlin.local` won't resolve, so it steers you to `remote`).

## `nano-workforce-http`

An **HTTP-only** operator skill for agents with no MCP client (for example nano-coder), or
for when the MCP gateway is unreliable. It does the same bootstrap with `curl`:

1. Resolve and name the instance, using the same `NANO_WORKFORCE_INSTANCES` /
   `instances.json` / `NANO_WORKFORCE_URL` lookup as above.
2. Authenticate. A Basic-Auth front door (for example over Tailscale) uses
   `NANO_WORKFORCE_NETRC`, a netrc file; a shared secret uses `NANO_PR_WEBHOOK_SECRET`.
3. Fetch the live guide (`GET /app/api/agent`).

It also has a short quick reference and the traps the guide doesn't cover:
- off-host, the engine base is `<origin>/v2`;
- the cancel door is outside `/app/api`;
- to change a running job's settings (`autoMerge`, `autoResolveEscalations`, …), set its
  engine variables instead of cancelling and resubmitting (#904).

### Install (nano-coder)

nano-coder loads user skills from `~/.agents/skills`. Copy the skill there. A symlink
won't work, because nano-coder skips skill folders whose real path is outside the skills
directory. Re-copy after you pull:

```bash
mkdir -p ~/.agents/skills && cp -R skills/nano-workforce-http ~/.agents/skills/
```

For Copilot CLI or Claude, use `~/.copilot/skills` or `~/.claude/skills` instead.
