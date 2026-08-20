# Agent skills

Portable agent skills that ship with Nano Workforce. A skill is a `SKILL.md` with
YAML frontmatter (`name`, `description`) that an agent runtime (Copilot CLI, Claude)
loads on demand when its `description` matches the task.

## `nano-workforce`

A **thin bootstrap** that teaches any agent to operate a running Nano Workforce
instance: it resolves the instance base URL and fetches the instance's *live*
operator guide (`GET /app/api/agent`), then follows it. It deliberately holds no
endpoint detail of its own — the live, version-matched guide is the source of truth.

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
