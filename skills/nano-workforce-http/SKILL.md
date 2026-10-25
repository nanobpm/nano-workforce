---
name: nano-workforce-http
description: Operate a running Nano Workforce instance over plain HTTP with curl, with no MCP needed. Covers submitting PRs, features and epics, checking status, answering escalations, changing or cancelling running jobs, and debugging stuck instances. Use it when the user asks to drive, submit work to, or debug their Nano Workforce and the agent has no MCP client (nano-coder) or the MCP gateway is unreliable.
---

# Nano Workforce over HTTP

Nano Workforce (nwf) runs PRs to review convergence and merges them. It can also take an
issue and plan, implement and converge it across a fleet of coding agents. Every running
instance describes itself. **Its live operator guide is the playbook. This skill only gets
you there safely and covers the traps the guide leaves out.** If this skill and the live
guide disagree, the guide wins.

Everything here is `curl` against the app's HTTP API. No MCP.

## 1. Choose the instance, and always name it

Every action has side effects, so never default silently to a URL. Look for candidates in
this order:

1. Whatever the user names ("drive merlin").
2. `$NANO_WORKFORCE_INSTANCES` or `~/.config/nano-workforce/instances.json`. Each is a JSON
   map of `name → app API base`, for example
   `{"merlin": "https://merlin.example.ts.net/console/app-view/Workforce/app/api"}`.
3. `$NANO_WORKFORCE_URL`. Append `/app/api` if it is a bare origin.
4. `http://localhost:3000/app/api`.

Probe each candidate with `GET $BASE/version`. If exactly one answers, say which one you
are about to drive. If several answer, ask the user which to use.

## 2. Authenticate

Use one `curl` prefix for every request. Call it `$C`:

```bash
C="curl -sS --max-time 30"
# Instance behind HTTP Basic Auth (e.g. a Tailscale/Caddy front door): use a netrc file.
[ -n "$NANO_WORKFORCE_NETRC" ] && C="$C --netrc-file $NANO_WORKFORCE_NETRC"
# Instance guarded by a shared secret: send it on reads AND mutations.
[ -n "$NANO_PR_WEBHOOK_SECRET" ] && C="$C -H x-hook-secret:$NANO_PR_WEBHOOK_SECRET"
```

Never print, echo or save credentials or the netrc file. A `401` means the auth is missing
or wrong. Ask the user; don't guess.

## 3. Fetch the live guide, then orient

Fetch the guide at the start of every session and read all of it:

```bash
$C "$BASE/agent" | jq -r .instructions > /tmp/nwf-guide.md
$C "$BASE/version" | jq '{version, uptimeSeconds}'
$C "$BASE/status"  | jq        # everything in flight + open escalations
$C "$BASE/escalations" | jq    # every open escalation with full context
```

Check `/status` before you submit anything or try to unstick anything.

## 4. Quick reference (confirm the details in the live guide)

| Do | Request |
|---|---|
| Converge (and merge) a PR | `POST $BASE/actions/start/convergence-loop` `{"pr":"owner/repo#N","autoMerge":true}` |
| One issue → one PR | `POST $BASE/actions/start/feature` `{"issue":"owner/repo#N","baseBranch":"main","confirmDefaultBase":true,"converge":true,"autoMerge":true}` |
| Epic → plan → fleet of PRs | `POST $BASE/actions/start/plan-fanout` `{"issue":"owner/repo#N","baseBranch":"epic/<name>"}` |
| Answer an escalation | `POST $BASE/actions/complete-user-task` `{"userTaskKey":"<key>","variables":{"answer":"..."}}` |
| Cancel a job (last resort) | `POST ${BASE%/api}/actions/cancel` `{"processInstanceKey":"<processKey>"}` |

Optional flags when you start work: `autoMerge` (merge after convergence) and
`autoResolveEscalations` (let the escalation steward answer escalations; the setting passes
down to child jobs).

## 5. Traps the guide doesn't cover

- **The engine base.** The guide's `engineBase` is often `http://localhost:8080`, which only
  works on the instance's own host. Off-host, the engine REST API is usually `<origin>/v2`
  behind the same front door and auth. Check it with
  `$C -X POST "$ENGINE/v2/variables/search" -H content-type:application/json -d '{"filter":{"processInstanceKey":"<key>"}}'`.
- **The cancel door is outside `/app/api`.** It is `.../app/actions/cancel`, not
  `.../app/api/actions/cancel`. Always cancel through the app, never through a raw engine
  cancel, so the app's records stay consistent.
- **Change a running job's settings in place. Do not cancel and resubmit.** Settings like
  `autoMerge`, `autoResolveEscalations`, `converge` and `maxRounds` are engine variables on
  the job's process instance:

  ```bash
  $C -X PUT "$ENGINE/v2/element-instances/<processKey>/variables" \
    -H content-type:application/json \
    -d '{"variables":{"autoMerge":true,"autoResolveEscalations":true},"local":false}'   # 204
  ```

  Check the result with the variable search above. `/status` may not show the change (for
  example `autoMerge: null`), so trust the engine variables.
- **Submitting is idempotent** on the PR, feature or plan key. Re-POSTing refreshes the
  existing job instead of starting a duplicate, and an `alreadyRunning: true` response is not
  an error. To change a running job's settings, use the variables, not a re-POST.

## Principles

- **Name the instance** before any side-effecting call.
- **Preview before bulk actions.** Show the user the plan first. Dispatching a delivery
  graph is the operator's decision in the cockpit, not something you do.
- **Escalations are for humans.** Bring design and product questions to the user with
  options. Don't answer them silently unless the user opted that work into
  `autoResolveEscalations`.
- **Discover, don't declare.** Re-read the live guide each session rather than relying on a
  copy you remember.
