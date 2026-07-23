# OPS-012F — Safe Browser Task and Workflow Controls

## Purpose

OPS-012F exposes accepted V1/V2 mutation contracts through authenticated browser interfaces without moving state-machine authority into React.

```text
Human operator session
        ↓ permission + CSRF
Explicit browser confirmation
        ↓ reason + idempotency key
Accepted bounded server route
        ↓ lock + state-machine validation
Durable transition + audit
```

The browser presents actions and consequences. The server remains authoritative for authorization, legal transitions, retry budgets, external-effect fencing, dispatch, idempotency, and audit.

## Delivery plan

| Slice | Scope | Status |
|---|---|---|
| OPS-012F.1 | Review-task pause, resume, cancel, and retry controls | Implemented in PR branch |
| OPS-012F.2 | Workflow recovery and Berlin approval controls | Pending |
| OPS-012F.3 | Effect resolution, workspace investigation, and final control integration | Pending |

## OPS-012F.1 — Review-task controls

### Existing server contract

```text
POST /api/operator/tasks/:taskId/pause
POST /api/operator/tasks/:taskId/resume
POST /api/operator/tasks/:taskId/cancel
POST /api/operator/tasks/:taskId/retry
```

The browser does not create a second route or transition implementation.

### Browser state gating

The control desk offers only states accepted by the durable review-task store:

| Action | Browser-visible source states |
|---|---|
| Pause | `QUEUED`, `FIX_QUEUED` |
| Resume | `PAUSED` |
| Cancel | `QUEUED`, `FIX_QUEUED`, `CLAIMED`, `RUNNING`, `FIXING` |
| Retry | `ERROR`, `NEEDS_HUMAN`, `SUPERSEDED`, `CANCELLED` |

This gating improves usability but is not a security boundary. The server re-reads the durable task and validates the transition under a per-task action lock.

### Required request evidence

Every confirmed browser action sends:

```json
{
  "reason": "Human-readable operator reason",
  "idempotency_key": "browser-task:<unique request id>"
}
```

The session CSRF value is sent in:

```text
X-Ops-Room-CSRF
```

A browser dialog requires:

1. an explicit action selection;
2. an operator reason of at most 500 characters;
3. acknowledgement of the exact consequence;
4. confirmation for the exact durable task ID.

### Idempotency behavior

One idempotency key is generated when the confirmation dialog opens.

- A definite accepted or rejected HTTP response closes that request identity.
- If delivery is uncertain because the browser receives no definite response, the dialog remains open and retains the same key.
- Retrying the uncertain delivery uses the same task, action, reason, and idempotency key.
- The server returns the stored response rather than executing the transition twice.

### Permissions and modes

Task controls require a human operator session with `task.manage`, initially provided by:

```text
operator
administrator
```

Legacy dashboard-token mode remains read only. The browser hides or disables actions for roles without task management, while the server still performs the authoritative RBAC check.

### Accepted outcomes

The UI handles:

- accepted transition;
- idempotent replay;
- invalid transition;
- retry budget exhausted;
- task not found;
- permission denial;
- invalid CSRF;
- emergency read-only mode;
- idempotency conflict;
- identical request still in progress;
- uncertain client delivery.

Accepted responses expose the bounded resulting task state and durable audit-event ID.

### Query refresh

After a definite response, the browser invalidates:

```text
review-tasks
interventions
ops-dashboard
mission-room
agent-fleet
```

This does not replace durable state. It only refreshes accepted read projections.

## Boundaries retained for later slices

OPS-012F.1 does not expose:

- Berlin approval or next-iteration approval;
- Workflow resume or failed-stage recovery;
- provider-effect resolution;
- workspace cleanup, hold, or release;
- agent lifecycle actions;
- provider invocation;
- Git or GitHub mutation;
- pull-request creation, merge, release, or deployment;
- automatic replay of uncertain external effects.

## Security invariants

- Human session and permission checks remain server-side.
- Mutations require CSRF protection.
- Emergency read-only mode is enforced by the server.
- Every accepted and rejected action is actor-attributed in durable audit evidence.
- Per-task locking prevents concurrent browser transitions from racing.
- Idempotency prevents duplicate execution and dispatch.
- Retry budget remains server-authoritative.
- No credentials, environment values, authenticated remotes, host paths, effect payloads, raw provider output, unrestricted logs, or private reasoning are displayed.
