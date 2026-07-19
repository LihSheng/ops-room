# Ops Room Operator API

The operator API is disabled by default. It provides authenticated control-plane mutations separately from webhook ingress and read-only dashboard access.

## Configuration

Configure these values in the protected production environment file outside the immutable release directory:

```text
OPS_ROOM_OPERATOR_API_ENABLED=false
OPS_ROOM_OPERATOR_TOKEN=<separate operator bearer credential>
OPS_ROOM_OPERATOR_ID=lihsheng
OPS_ROOM_OPERATOR_DISPLAY_NAME=Lih Sheng
OPS_ROOM_AUDIT_DIR=/absolute/path/to/data/ops-room/audit
OPS_ROOM_IDEMPOTENCY_DIR=/absolute/path/to/data/ops-room/idempotency
```

Requirements:

- Do not reuse `OPENAB_WEBHOOK_SECRET` or `OPS_ROOM_DASHBOARD_TOKEN` as the operator token.
- Keep the mutation API disabled until the intended release is deployed and verified.
- Audit and idempotency directories must remain outside `/opt/ops-room/releases`.
- Do not record the bearer token in logs, audit records, screenshots, or documentation.
- Browser mutation controls remain out of scope until browser authentication, RBAC, and confirmation policy are approved.

## Task action request

All task actions use the same body:

```json
{
  "reason": "Operator-approved reason for this action",
  "idempotency_key": "task-action-20260719-001"
}
```

`reason` is required and limited to 500 characters. `idempotency_key` must contain 8–128 letters, numbers, dots, colons, underscores, or dashes.

Canonical endpoints:

```http
POST /api/operator/tasks/:taskId/cancel
POST /api/operator/tasks/:taskId/retry
POST /api/operator/tasks/:taskId/pause
POST /api/operator/tasks/:taskId/resume
Authorization: Bearer <operator-token>
Content-Type: application/json
```

The previous `/api/review-tasks/:taskId/<action>` paths remain compatibility aliases, but they now enforce the same authentication, reason, audit, and idempotency contract. New integrations should use `/api/operator/tasks/...`.

## Action state rules

| Action | Accepted source states | Result |
|---|---|---|
| `cancel` | Queued or active cancellable task states | `CANCELLED` for queued tasks, otherwise `CANCEL_REQUESTED` |
| `pause` | `QUEUED`, `FIX_QUEUED` | `PAUSED` |
| `resume` | `PAUSED` | `QUEUED` for review tasks or `FIX_QUEUED` for fix tasks |
| `retry` | `ERROR`, `NEEDS_HUMAN`, `SUPERSEDED`, `CANCELLED` | `QUEUED` for review tasks or `FIX_QUEUED` for fix tasks |

Retry increments `attempt`, clears stale completion/error/cancellation/lease metadata, and rejects the request when a finite `policy.retry_budget` would be exceeded.

Pause does not interrupt an already-running worker. Only queued review and fix tasks can be paused. Running work should use cancellation and wait for worker acknowledgement.

Retry and resume request dispatch only after the state transition and accepted audit event are durable. An idempotent replay does not request another dispatch. The normal dispatcher and effect ledger remain responsible for preventing duplicate external effects.

## Accepted response

A valid request returns `202`:

```json
{
  "operation": "task.retry",
  "task": {
    "id": "review-example",
    "kind": "review",
    "state": "QUEUED",
    "attempt": 1
  },
  "audit_event_id": "uuid",
  "idempotent_replay": false
}
```

Repeating the same actor, operation, key, target, and payload returns the original response with `idempotent_replay: true`. Reusing the key for a different target or reason returns `409` and creates a rejected audit event.

Concurrent requests using different keys are serialized per task in the running process. After the first valid transition, a conflicting action is rejected and audited rather than creating a duplicate transition or dispatch.

## Audit operations

Accepted and rejected attempts use these stable operation names:

- `task.cancel`
- `task.retry`
- `task.pause`
- `task.resume`

Accepted events include the actor, target, human reason, previous and resulting states, idempotency key, task kind, attempt, and whether dispatch was requested. Secret values and authorization material are never included.

## Read audit events

```http
GET /api/audit-events?limit=50&operation=task.retry&actor=lihsheng&outcome=accepted
Authorization: Bearer <operator-token>
```

Supported filters:

- `limit`, capped at 100
- `actor`
- `operation`
- `target_id`
- `outcome`
- `from`
- `to`

Read one event:

```http
GET /api/audit-events/:eventId
Authorization: Bearer <operator-token>
```

## Status codes

| Status | Meaning |
|---|---|
| `202` | Action accepted or an identical completed request replayed |
| `400` | Invalid task ID, missing/invalid reason, or invalid idempotency key |
| `401` | Operator credential missing or invalid |
| `404` | Operator API disabled, task missing, or audit event missing |
| `409` | Invalid transition, retry budget exhausted, idempotency conflict, or identical request still in progress |
| `503` | Authenticated credential is valid but operator identity is not configured |

Rejected requests include a stable `error_code` and `audit_event_id`. Expected codes include `invalid_request`, `invalid_task_id`, `task_not_found`, `invalid_transition`, `retry_budget_exhausted`, `IDEMPOTENCY_CONFLICT`, and `IDEMPOTENCY_IN_PROGRESS`.

## Rollback

Disabling `OPS_ROOM_OPERATOR_API_ENABLED` immediately hides all operator endpoints without deleting audit or idempotency records. Existing records must remain available for operational traceability.
