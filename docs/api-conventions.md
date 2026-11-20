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

## 3. Search and query parameters

- **POST search** endpoints take a Camunda-style body: `{ "filter": {…}, "sort": [{ "field", "order" }], "page": { "from", "limit" } }`.
- **GET** query parameters use the Camunda field names from section 1 (`?processInstanceKey=…`).

## Ratchet

`app/apiConventions.baseline.json` lists the violations that existed when the guard was added.
The test fails when:

- a **new** violation appears (fix it; don't add it to the baseline), or
- a baselined violation **disappears** (shrink the baseline in the same PR).

Fields marked `deprecated: true` still count until they are removed. To regenerate the baseline
after a deliberate fix:

```sh
NWF_API_BASELINE_WRITE=1 node --experimental-strip-types --test app/apiConventions.test.ts
```
