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

> **Served summary:** a running instance also exposes a nav-linked **"Connect over
> MCP"** console page (`pages/mcp.page.json`) with copyable config recipes rendered
> for that instance's own address. It is the short, always-reachable digest; this
> runbook is the deeper source of truth. Keep the two in sync.

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

### Import a curated subset, not `["*"]` (tractable surface — issue #715)

The full projected surface is **~56 tools / ~79 KB** of `tools/list` (app operations + the
framework `urban_debug_*` engine family). That is large enough that a coding-agent harness
**defers the whole set behind a tool-search gate**, and `"tools": ["*"]` imports every one of
them eagerly — so an agent may not see nwf's tools until it searches. Until the runtime shrinks
the framework tool family behind a mode (tracked upstream, nano-ide#488), the workforce-side lever
is to import a **curated allowlist** of the tools you actually drive/read with, instead of `["*"]`:

```json
"workforce-local": {
  "type": "http",
  "url": "http://localhost:3000/app/mcp",
  "tools": <curated list below>
}
```

The curated list is the single source of truth in **`app/mcpToolSurface.ts`**
(`CURATED_MCP_TOOLS`) — `e2e/mcp-tractability.e2e.ts` asserts every entry projects onto the live
surface, and `npm run sync:mcp-curated:check` (also asserted by a drift test under `npm test`, which
CI runs) fails if the block below drifts from the source. Never hand-edit it; edit
`app/mcpToolSurface.ts` and run `npm run sync:mcp-curated`.

<!-- BEGIN GENERATED: curated-tools (npm run sync:mcp-curated) -->
```json
[
  "startConvergenceLoop",
  "startPlanFanout",
  "startEpicSet",
  "startFeature",
  "compileDeliveryGraph",
  "previewDeliveryGraph",
  "sequenceIssues",
  "agentCompleteEscalation",
  "completeUserTask",
  "cancelInstance",
  "appendBlackboard",
  "readBlackboard",
  "getVersion",
  "getAgentInstructions",
  "getAgentGuide",
  "listActivePrs",
  "listStagedProposals",
  "listEscalations",
  "getLineage",
  "getPrHistory",
  "urban_debug_search_process_instances",
  "urban_debug_search_element_instance_wait_states",
  "urban_debug_search_incidents",
  "urban_debug_search_variables",
  "urban_debug_search_jobs",
  "urban_debug_instance_state",
  "urban_debug_open_user_tasks"
]
```
<!-- END GENERATED: curated-tools -->

Keeping `["*"]` still works and is fine on a client that does not defer — the curated import is the
recommended default for a harness that gates on tool count. The full surface (including any
`urban_debug_*` tool not in the curated set) stays reachable; drop back to `["*"]`, or add the
specific extra tool name to the entry, whenever you need one outside the curated set.

### Recover a lost session — re-`initialize` on `-32000` (issue #715, gap 1)

The `/app/mcp` transport is **stateful streamable-HTTP**: every `tools/call` carries an
`mcp-session-id`, and a call with a missing / stale / idle-dropped / proxy-reset / LRU-evicted
session id is refused with `-32000 "Bad Request: no valid session id, and not an initialize
request."` A client that does not re-handshake then sees the **whole surface** report "tool does not
exist" until it re-`initialize`s — a single hiccup (notably a heavy-tool timeout, gap 4 below) can
brick every tool. The **self-heal** is a fresh `initialize` handshake, which mints a new session and
restores the entire catalogue in one round trip; a well-behaved MCP client does this automatically on
a `-32000`. The stateless/resumable transport that would remove the session dependency entirely is
tracked upstream (nano-ide#488); `e2e/mcp-session-selfheal.e2e.ts` pins the workforce-visible
requirement — a killed session (stale id **and** a server-side `DELETE`) bricks a call `-32000`, and
one re-`initialize` brings the full surface back.

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

The agent should call the status operation tool (`listActivePrs`), not curl. The operator
guide's **tool↔curl crosswalk** (agent-guide §10, via `getAgentGuide(section="tool-crosswalk")`)
maps every guide action to its projected tool name and the curl door underneath — so a
tool-aware agent leads with the tool (`listActivePrs`, `getVersion`, `completeUserTask`,
the `urban_debug_*` engine reads — plus `listEscalations` and `cancelInstance` *where the
deployment projects them*; those two are sibling tasks #666/#667 and are not on a
deployment that predates them, so fall back to the curl door there) and treats curl as
the no-MCP fallback only.

## 3. Debug a wedged instance

> *"workforce-local: PR nanobpm/nano-workforce#123 looks wedged — find its process
> instance, compare engine truth against the app's projections, and tell me where
> it's stuck."*

The agent has: instance search, wait states, incidents (engine truth) — plus
`variables` where the framework projects the `urban_debug_search_variables` read
(otherwise via the engine curl fallback) — plus
the `urban_*` projection reads (app belief) + the operator guide (the
`getAgentInstructions` tool) for the convergence-loop-specific meaning of each wedge
shape. A wedge is frequently exactly a disagreement between the two planes. The guide's
**tool↔curl crosswalk** (agent-guide §10) names each engine-truth tool
(`urban_debug_search_process_instances` / `urban_debug_search_element_instance_wait_states`
/ `urban_debug_search_incidents`, and where projected `urban_debug_search_jobs` /
`urban_debug_search_variables` / `urban_debug_get_process_definition_xml`) so the agent
reaches for the tool, not the raw `__ENGINE__` curl — and steers cancels to the app-owned
`cancelInstance` (projected by sibling #667; until it lands, the `/app/actions/cancel`
door the UI's Cancel uses), never the record-desyncing engine-level `urban_debug_cancel_instance`.

## 4. Guard posture

When `NANO_PR_WEBHOOK_SECRET` is **unset**, the app guard is off entirely: both reads
(status, instances, incidents, projections, the operator guide) and mutations
(cancel/retry/resolve, `start/*` operations, answering escalations) work with no
credential **from wherever this instance is reachable** — with `network.bind: "all"`
that is the LAN, not just loopback, so leave it unset only where that exposure is
acceptable. When it **is set**, the guard is not mutation-only: it also covers
reads, so read endpoints like `GET /app/api/agent` and `GET /app/api/version`
return `401` without the `x-hook-secret` header, just as guarded mutations do. It
is not blanket, though — a few doors stay intentionally unguarded even when the
secret is set (e.g. the declarative Save-to-library page action, which
structurally cannot attach the header). Put it in the server entry's
`headers`, never in chat. For a remote fleet,
`NANO_WORKFORCE_BASE_URL` reachability rules apply unchanged. The rest of the app's
HTTP surface follows the `network.bind` manifest setting, but the runtime-served
`/app/mcp` surface is an exception: it is **loopback-only by default** and refuses
non-loopback peers with a `403` even when `network.bind` is `"all"`, until you
*also* set `URBAN_MCP_ALLOW_REMOTE=true` (see `e2e/support/mcp-harness.ts`).
LAN/remote MCP clients therefore need that knob in addition to a wide bind.

### Framework mutation guard — `urban_debug_*` mutations need `x-hook-secret` too

The framework-owned **mutating** `urban_debug_*` tools (`set_variables`, `retry_job`,
`resolve_incident`, `cancel_instance`) are gated by the Urban runtime's *own* mutation
guard (`authorizeMutation`), which is separate from nwf's app-operation guard above. It
authorizes a mutation one of two ways:

1. **Loopback bypass** — `URBAN_MCP_ALLOW_MUTATIONS=true` **and** `mcp.allowRemote` off.
   This is the credential-free, local-only path; it is disabled the moment the surface is
   remote-exposed (`allowRemote` on), by design — the guard never drops for a non-loopback
   caller.
2. **Shared-secret scheme** — an apiKey *header* security scheme that declares an
   `x-nano-secret-env` extension naming the env var holding the secret. nwf declares this
   on **`hookSecret`** (`x-nano-secret-env: NANO_PR_WEBHOOK_SECRET`), so a mutating
   `urban_debug_*` call carrying `x-hook-secret: <NANO_PR_WEBHOOK_SECRET>` is authorized on
   a remote-exposed instance.

This is the **same secret and same header** as nwf's app-operation guard (both key on
`NANO_PR_WEBHOOK_SECRET` via `x-hook-secret`), so reads and mutations — app-operation and
framework — share one credential. The MCP server entry's `headers` already carries it (§1);
nothing extra is needed for `urban_debug_*` mutations once the secret is set.

**Fail-closed caveat.** When `NANO_PR_WEBHOOK_SECRET` is **unset** there is no credential to
present, so on a remote-exposed instance (`allowRemote` on) framework mutations remain
**closed** — this is correct fail-closed behavior, not a regression. Because the scheme is now
*declared* (it names the env var) but the secret is absent, the runtime surfaces the attempt as a
`500` *security-misconfigured* ("secret env `NANO_PR_WEBHOOK_SECRET` is not set") rather than a
plain refusal — either way no mutation occurs. An operator who needs remote mutation repair (e.g.
patching a wedged instance's variable + retrying a `JOB_NO_RETRIES` job) must set
`NANO_PR_WEBHOOK_SECRET`; then a `urban_debug_*` mutation carrying `x-hook-secret: <secret>`
succeeds, while a missing or wrong header `401`s. The loopback bypass
(`URBAN_MCP_ALLOW_MUTATIONS=true` with `allowRemote` off) remains the credential-free
local-only alternative. Only `hookSecret` may carry `x-nano-secret-env` — the runtime
throws on more than one shared-secret scheme.

**Operator-only doors stay operator-only.** The staged delivery-graph lifecycle —
`stageDeliveryGraph`, `dispatchDeliveryGraph`, `dismissProposal` — is `x-mcp`-excluded
from the projected tool surface (ADR 0067 §2): the human clicking **Dispatch** in the
cockpit *is* the approval (ADR 0005 Decision 7), so an agent cannot dispatch a delivery
graph through MCP. Agents author graphs through the pure `compileDeliveryGraph` /
`previewDeliveryGraph` doors, which stay exposed.

**Projected tool schemas are self-contained (epic #605, S0).** The projector copies each
operation's request-body schema *verbatim* into the tool's `inputSchema.properties.body`
and does **not** resolve `$ref`s, so every projected (non-`x-mcp`) request-body operation
in `openapi.yaml` presents an inline `type: object` body with no `$ref`; the two graph doors
additionally carry a worked `example` — an agent discovers the body shape (and calls the tool
with a real object, not a
stringified one) from the surface alone — and even if an agent's client emits a
stringified object body, the door itself now **faithfully parses** it rather than
rejecting it (nano-ide#503, a server-side input-compatibility behavior that needs no
client upgrade — see the faithful-transport note below). The two graph doors split by convention:
`compileDeliveryGraph` takes the **structured `DeliveryGraph` object** (and *stages*);
`previewDeliveryGraph` takes the **text shape `{ "graphJson": "<serialized DeliveryGraph>" }`**
(and is *pure*). Every validation failure returns `issues`/`errors` as `[{ path, message }]`.
The inline bodies are **derived** from `components.schemas` by
`scripts/inline-mcp-bodies.ts` (single source of truth; run `npm run gen:mcp-bodies` after
editing a component), and `npm run check:mcp-bodies` + `test/mcp-tool-schemas.test.ts` (which
runs the real projector) fail CI if a `$ref` ever re-leaks. The upstream projector fix that
would make the **schema** mitigation unnecessary is tracked in
[nano-ide#501](https://github.com/nanobpm/nano-ide/issues/501) (#502 self-contained schemas,
#504 real-spec conformance guard). **#503 faithful object-body transport has landed** —
`@nanobpm/urban` 0.87 ships ADR 0067's `normalizeBodyArg`, so the MCP door now **parses** a
stringified object body and forwards it faithfully instead of rejecting it with `expected object,
got string`. That retired the nwf-local stringified-body reject mitigation: the e2e guard in
`e2e/mcp-surface.e2e.ts` now asserts the door faithfully parses a stringified body (the
`assertObjectBodyAccepted` detector's teeth stay pinned synthetically).

**Heavy compile/stage tools stay under the client timeout (issue #716).** Compiling a large
delivery graph to laid-out BPMN (`layoutBpmn` / `bpmn-auto-layout`) is CPU-bound and superlinear —
minutes on a 256-node / 1024-edge graph — so running it inline once tripped a cold
`sequenceIssues` / `compileDeliveryGraph` call past the client's per-call MCP timeout (`-32001
Request timed out`, which then poisoned the stateful session, #715). The compile+STAGE hot path
(`compileAndStageDeliveryGraph`) therefore runs the **layout-free** `compileDeliveryGraphSemantic`:
staging needs only the content **digest**, the mermaid `diagram`, and the resolved model, so it
returns in milliseconds. The digest is taken over the deterministic **semantic** BPMN (the diagram
interchange is derived from it, so it is the canonical content of a graph) — one content address
shared across staging, `previewProposalBpmn`, `dispatchDeliveryGraph`, and the deploy id, so they
never drift. The expensive `layoutBpmn` is deferred to the **operator's** preview/dispatch
(`previewProposalBpmn` recompiles the laid-out BPMN with DI on demand) — a cockpit action, not a
timeout-bound MCP call. `app/deliveryGraphStage.test.ts` and `e2e/heavy-tool-progress.e2e.ts` pin
that a large/dense graph stages fast rather than timing out.

## 5. Fallback

Agents without MCP are unchanged — resolve the instance, then
`curl -sS $BASE/agent | jq -r .instructions`, or load the
[`nano-workforce` skill](../skills/nano-workforce/SKILL.md), which fetches the same
live guide. `GET /app/api/agent` and `GET /app/api/agent/skill` keep working exactly as
before.

### Addressable guide (MCP) — `getAgentGuide`

The full guide is ~43KB — a single `getAgentInstructions` call can overrun a tool-result
limit. Over MCP, prefer the **addressable** companion tool `getAgentGuide(section?)`
(`GET /app/api/agent/guide`):

- **No argument** → a compact **table of contents**: every stable section id
  (`orient`, `submit-pr`, `submit-epic`, `escalations`, `lifecycle`, `debug`,
  `debug-models`, `unstick`, `raise-issue`, `delivery-graphs`, `tool-crosswalk`) with a
  one-line summary.
- **`section=<id>`** → **only** that section's markdown, small enough to fit a typical
  limit. An unknown id is rejected with `issues[{path,message}]` listing the valid ids.

The section ids are the single source of truth in `app/agentGuide.ts` (`GUIDE_SECTIONS`),
derived-and-checked against the authored `docs/agent-guide.md`. The `getAgentInstructions`
/ `GET /agent` full-guide door is unchanged — the addressable tool is additive.

## 6. Regression harness — pin the MCP surface from nwf's side

The MCP projection layer (schema shape, argument encoding, session handshake) is
covered end-to-end by a reusable e2e harness (epic #605 slice S1, issue #607):
`e2e/support/mcp-harness.ts`. It boots a hermetic in-process instance and drives
the **real** `/app/mcp` endpoint over the full Streamable-HTTP client handshake —
`initialize` → capture `Mcp-Session-Id` → `notifications/initialized` →
`tools/list` → `tools/call` — asserting the client-visible contract every agent
depends on:

- every projected tool schema is `$ref`-free with an explicit `type` (a leaked
  `$ref` is unresolvable in the MCP context);
- an object argument arrives **as an object** — and a stringified one is faithfully
  **parsed** by the door (ADR 0067 / nano-ide#503, `@nanobpm/urban` ≥ 0.87), never
  rejected as `expected object, got string`;
- validation failures answer uniformly with `issues[{path,message}]`;
- side-effecting calls stage nothing, so the suite is safe to re-run.

It runs in CI under `npm run e2e` (hermetic — no socket, no GitHub), so a
reintroduced `$ref` fails the build, and a stringified object body is asserted to be
faithfully parsed by the door (ADR 0067 / nano-ide#503) instead of reaching an agent
mis-serialized.

**Extending it (new per-tool case).** Import `bootMcpHarness` from
`e2e/support/mcp-harness.ts` in your own `e2e/<slice>.e2e.ts` and drive
`harness.listTools()` / `harness.callTool(name, args)` — the handshake, session
management and teardown are owned by the harness, so you add a `test(...)`, never
a second transport. The module header documents the seam and the exported
assertion helpers (`assertSchemaSelfContained`, `assertObjectBodyAccepted`,
`assertValidationIssues`) in full; `e2e/mcp-surface.e2e.ts` is the worked example.
