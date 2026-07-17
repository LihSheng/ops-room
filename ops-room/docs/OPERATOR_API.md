# Ops Room Operator API

The operator API is disabled by default. It provides authenticated control-plane mutations separately from webhook ingress.

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

- Do not reuse `OPENAB_WEBHOOK_SECRET` as the operator token.
- Keep the API disabled until the deployment and rollback drill has been completed.
- Audit and idempotency directories must remain outside `/opt/ops-room/releases`.
- Do not record the bearer token in logs, audit records, screenshots, or documentation.

## Cancel a review or fix task

```http
POST /api/operator/tasks/:taskId/cancel
Authorization: Bearer <operator-token>
Content-Type: application/json
```

```json
{
  "reason": "Duplicate task superseded by a newer review",
  "idempotency_key": "cancel-review-20260717-001"
}
```

A valid request returns `202`:

```json
{
  "operation": "task.cancel",
  "task": {
    "id": "review-example",
    "state": "CANCEL_REQUESTED"
  },
  "audit_event_id": "uuid",
  "idempotent_replay": false
}
```

Repeating the same actor, key, target, and payload returns the original response with `idempotent_replay: true`. Reusing the key for a different target or reason returns `409` and creates a rejected audit event.

## Read audit events

```http
GET /api/audit-events?limit=50&operation=task.cancel&actor=lihsheng&outcome=accepted
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
| `202` | Cancellation accepted or replayed |
| `400` | Invalid task ID, reason, or idempotency key |
| `401` | Operator credential missing or invalid |
| `404` | Operator API disabled, task missing, or audit event missing |
| `409` | Invalid task transition, idempotency conflict, or identical request still in progress |
| `503` | Authenticated credential is valid but operator identity is not configured |

## Rollback

Disabling `OPS_ROOM_OPERATOR_API_ENABLED` immediately hides the operator endpoints without deleting audit or idempotency records. Existing records must remain available for operational traceability.
