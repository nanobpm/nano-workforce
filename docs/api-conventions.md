# nwf API conventions (Camunda Orchestration Cluster API alignment)

Part of #972. The nwf HTTP API (`openapi.yaml`) follows the naming and shape conventions of the
Camunda Orchestration Cluster API so clients can use one vocabulary across both.
`app/apiConventions.test.ts` enforces these rules (run by `npm test`).

## 1. Entity keys

**Engine entities use the Camunda name**, everywhere: request bodies, query/path parameters,
and response bodies.

| Entity | Field |
| --- | --- |
| Process instance | `processInstanceKey` |
| Process definition | `processDefinitionKey` (key) / `processDefinitionId` (BPMN id) |
| Element instance | `elementInstanceKey` |
| Job | `jobKey` |
| User task | `userTaskKey` |
| Incident | `incidentKey` |
| Tenant | `tenantId` |

Do not use synonyms such as `processKey`, `process_key`, `instanceKey`, `bpmnProcessId`, or
`taskKey`, or snake_case spellings of a canonical key (`process_instance_key`, `job_key`).

**nwf entities** use camelCase `<entity>Key`: `prKey`, `featureKey`, `planKey`, `runKey`,
`agentInstanceKey`. Their snake_case forms (`pr_key`, `run_key` …) are violations on the API
surface. DB column names (for example `process_key`) are internal and not covered.

## 2. List responses

Every list response has this shape:

```json
{ "items": [ ... ], "page": { "totalItems": 42 } }
```

Top-level fields that are not per-item may sit next to it (`generatedAt`, `version`,
`pendingCount`, the blackboard's incremental-read `cursor`). Legacy per-list arrays (`prs`,
`entries`, …) and `count` do not meet the convention.

The guard treats an operation as a list if it is one of the operations named in #972, or if its
`operationId` starts with `list` or `search`.

### Migration (completed)

The additive phase (#972 delivery steps 2–3) shipped in **v0.212.0**: that release returned
`items` + `page.totalItems` next to the legacy arrays and `count`, `processInstanceKey` next to
`processKey`, `processDefinitionId` next to `bpmnProcessId`, and accepted both request names.
The following breaking release (#972 step 4) **removed** every legacy name: list responses are
only `{ items, page: { totalItems } }` (plus non-per-item top-level fields), engine keys use only
their Camunda names, and requests accept only the canonical names (`getPrHistory?processInstanceKey=`;
`acknowledge*` bodies `prKey`/`featureKey`/`planKey`/`runKey`). Clients pin a release, so a client
still on the legacy names should stay on v0.212.0 until it migrates.

### Decision: `listActivePrs` is one list with a `kind` discriminator

`GET /status` (`listActivePrs`) used to return two arrays, `prs` and `deliveries`. We keep it as
**one operation** whose `items` holds both, PR rows first then delivery-run rows, each tagged
`kind: "pr"` or `kind: "delivery"` (`page.totalItems` counts both).

Why not split into two operations: `/status` is the single "what is in flight?" poll that
operators, the MCP `listActivePrs` tool and the guide all rely on, and the top-level `version`
object answers "is the fix live?" in that same call. Splitting would double the polls and the
MCP tool surface for no gain. A `kind` field is how Camunda's own mixed lists stay
self-describing, and clients that want one kind filter on it
(`jq '.items[] | select(.kind == "pr")'`).

## 3. Search and query parameters

- **POST search** endpoints take a Camunda-style body: `{ "filter": {…}, "sort": [{ "field", "order" }], "page": { "from", "limit" } }`.
- **GET** query parameters use the Camunda field names from section 1 (`?processInstanceKey=…`).

## Ratchet

`app/apiConventions.baseline.json` is **empty**: the guard fully enforces. The test fails when a
violation appears (fix it — don't baseline it), and a dedicated test keeps the baseline empty.
Any field marked `deprecated: true` that breaks a convention counts as a violation.
