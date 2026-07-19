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

OPS_ROOM_AGENT_LIFECYCLE_ENABLED=false
OPS_ROOM_AGENT_LIFECYCLE_ALLOWED_AGENTS=
OPS_ROOM_LIFECYCLE_DIR=/absolute/path/to/data/ops-room/lifecycle
OPS_ROOM_AGENT_LIFECYCLE_DRAIN_TIMEOUT_MS=20000
OPS_ROOM_AGENT_LIFECYCLE_DRAIN_POLL_MS=500
OPS_ROOM_AGENT_LIFECYCLE_STOP_TIMEOUT_SECONDS=20
```

Requirements:

- Do not reuse `OPENAB_WEBHOOK_SECRET` or `OPS_ROOM_DASHBOARD_TOKEN` as the operator token.
- Keep the operator API and agent lifecycle API disabled until the intended release is deployed and verified.
- Audit, idempotency, and lifecycle directories must remain outside `/opt/ops-room/releases`.
- Do not record the bearer token in logs, audit records, screenshots, or documentation.
- Browser mutation controls remain out of scope until browser authentication, RBAC, and confirmation policy are approved.
- The lifecycle allowlist is an additional restriction, not authority by itself. The canonical agent definition must also mark the agent as the approved guarded-stop test target.
- In the current first slice, only Gemini is eligible. Professor, Berlin, and Tokyo remain lifecycle-disabled.

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

## Task action state rules

| Action | Accepted source states | Result |
|---|---|---|
| `cancel` | Queued or active cancellable task states | `CANCELLED` for queued tasks, otherwise `CANCEL_REQUESTED` |
| `pause` | `QUEUED`, `FIX_QUEUED` | `PAUSED` |
| `resume` | `PAUSED` | `QUEUED` for review tasks or `FIX_QUEUED` for fix tasks |
| `retry` | `ERROR`, `NEEDS_HUMAN`, `SUPERSEDED`, `CANCELLED` | `QUEUED` for review tasks or `FIX_QUEUED` for fix tasks |

Retry increments `attempt`, clears stale completion/error/cancellation/lease metadata, and rejects the request when a finite `policy.retry_budget` would be exceeded.

Pause does not interrupt an already-running worker. Only queued review and fix tasks can be paused. Running work should use cancellation and wait for worker acknowledgement.

Retry and resume request dispatch only after the state transition and accepted audit event are durable. An idempotent replay does not request another dispatch. The normal dispatcher and effect ledger remain responsible for preventing duplicate external effects.

## Guarded graceful agent stop

OPS-008 begins with one deliberately narrow lifecycle operation:

```http
POST /api/operator/agents/:agentId/stop
Authorization: Bearer <operator-token>
Content-Type: application/json
```

Request body:

```json
{
  "reason": "Stop the approved non-critical test agent for verification",
  "idempotency_key": "agent-stop-gemini-20260719-001",
  "confirm_agent_id": "gemini"
}
```

`confirm_agent_id` must exactly match the path target. This prevents an operator from confirming one agent while targeting another.

A stop request is accepted only when all of these conditions hold:

1. `OPS_ROOM_OPERATOR_API_ENABLED=true`.
2. `OPS_ROOM_AGENT_LIFECYCLE_ENABLED=true`.
3. Operator authentication and stable identity succeed.
4. The agent is present in `OPS_ROOM_AGENT_LIFECYCLE_ALLOWED_AGENTS`.
5. The canonical agent definition marks the agent as `guarded-stop-test`.
6. The reason, confirmation, and idempotency key are valid.
7. The runtime target resolves through the OPS-007 runtime adapter boundary.
8. Durable task state contains no active task for the target agent before the drain deadline.

The first slice currently makes only Gemini eligible. The three GitHub workflow agents remain blocked even if their names are added to the environment allowlist.

### Stop sequence

```text
unmanaged
   ↓ request accepted for processing
 draining       new durable review/fix dispatch is blocked
   ↓ active task count reaches zero
 stopping       execute one bounded fixed-form docker stop command
   ↓
 stopped
```

On drain timeout, corrupt task state, an unavailable lifecycle target, or Docker stop failure, the operation is rejected or failed, the previous desired state is restored, and a bounded audit event is written. Startup recovery converts an interrupted `draining` or `stopping` record to `failed` rather than silently replaying the external command.

All lifecycle mutations are serialized globally in the running process. The Docker controller uses a fixed executable and argument array rather than a shell, validates the container name, ignores command output, runs asynchronously, and has a hard timeout. The default drain and stop bounds fit inside the standard Ops Room shutdown window.

The current endpoint does **not** provide:

- start;
- restart;
- kill or force stop;
- recreate;
- provider session execution;
- automatic desired-state reconciliation;
- dashboard lifecycle buttons;
- browser authorization or RBAC;
- lifecycle control for Professor, Berlin, or Tokyo.

A stopped Gemini instance must be recovered using the separately approved manual runtime procedure until a later reviewed start slice exists.

### Accepted lifecycle response

```json
{
  "operation": "agent.stop",
  "agent": {
    "id": "gemini",
    "desired_state": "stopped",
    "lifecycle_state": "stopped",
    "observed_state_before": "running"
  },
  "command_executed": true,
  "audit_event_id": "uuid",
  "idempotent_replay": false
}
```

If observation already reports `exited`, `dead`, `missing`, or `stopped`, the request may complete as an audited no-op with `command_executed: false`.

After a successful stop, a later request using a different valid idempotency key also completes as an audited no-op from durable `stopped` state. This prevents stale read-only runtime-cache data from causing a second Docker command.

## Task action accepted response

A valid task request returns `202`:

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

Repeating the same actor, operation, key, target, and payload returns the original response with `idempotent_replay: true`. Reusing the key for a different target, reason, or confirmation returns `409` and creates a rejected audit event.

Concurrent task requests using different keys are serialized per task. Lifecycle requests are serialized globally. Once durable lifecycle state is already `stopped`, a later valid request is accepted without a second external command.

## Audit operations

Accepted and rejected attempts use these stable operation names:

- `task.cancel`
- `task.retry`
- `task.pause`
- `task.resume`
- `agent.stop`

Accepted events include the actor, target, human reason, previous and resulting states, idempotency key, and bounded safe metadata. Agent-stop metadata may include adapter/controller identifiers, observed state before the action, drain duration, active task count, and whether the runtime command was executed. Secret values, command output, environment values, and authorization material are never included.

Read-only agent and instance APIs expose only desired state, lifecycle phase, bounded lifecycle error, and update time. Operator identity and human reason remain available only through authenticated audit records.

## Read audit events

```http
GET /api/audit-events?limit=50&operation=agent.stop&actor=lihsheng&outcome=accepted
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
| `400` | Invalid target, reason, confirmation, or idempotency key |
| `401` | Operator credential missing or invalid |
| `403` | Agent is not present in the lifecycle environment allowlist |
| `404` | Operator/lifecycle API disabled, target missing, or audit event missing |
| `409` | Invalid transition, retry budget exhausted, canonical target not approved, lifecycle state unavailable, drain not proven, unavailable runtime target, idempotency conflict, or identical request still in progress |
| `502` | Bounded runtime stop command failed |
| `503` | Authenticated credential is valid but operator identity is not configured |

Rejected requests include a stable `error_code` and `audit_event_id`. Lifecycle codes include `invalid_agent_id`, `agent_not_found`, `agent_not_allowed`, `invalid_request`, `lifecycle_state_unavailable`, `lifecycle_target_unavailable`, `agent_not_drained`, `task_store_corrupt`, and `runtime_stop_failed`.

## Rollback

Disabling `OPS_ROOM_OPERATOR_API_ENABLED` hides all operator endpoints. Disabling `OPS_ROOM_AGENT_LIFECYCLE_ENABLED` independently hides the agent lifecycle endpoint. Neither action deletes audit, idempotency, or lifecycle records.

Disabling the endpoint does not restart a stopped agent. Use the approved manual runtime recovery procedure and record the action separately. Existing persistent records must remain available for operational traceability.
