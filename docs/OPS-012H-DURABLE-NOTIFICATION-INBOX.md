# OPS-012H.2 — Durable Dashboard Notification Inbox

OPS-012H.2 adds restart-safe, per-operator dashboard notification state on top of the durable activity index introduced by OPS-012H.1.

## Source of truth

Notification content is never copied into a second event store.

```text
Mission / Workflow / stage / workspace / provider-effect evidence
                              ↓
                  GET /api/activity-events
                              ↓
          deterministic notification projection
                              ↓
       per-operator unread / read / acknowledged state
```

The durable Mission activity event remains the evidence authority. The notification store persists only the operator ID, notification ID, activity ID, state, timestamps, and acknowledgement reason.

## Routes

```text
GET  /api/operator/notifications
GET  /api/operator/notifications/:notificationId
POST /api/operator/notifications/:notificationId/read
POST /api/operator/notifications/:notificationId/acknowledge
```

All routes require an authenticated operator with `dashboard.read`.

- GET routes do not require CSRF.
- POST routes require CSRF.
- Read and acknowledgement do not require step-up confirmation because they only alter the authenticated operator's own notification state.
- Dashboard-token-only legacy reads cannot access or mutate per-operator notification state.

## Actionable notification projection

Deterministic notification IDs are derived from exact durable activity IDs. The initial notification types are:

- `mission_completed`;
- `review_approved`;
- `review_changes_requested`;
- `workflow_needs_human`;
- `provider_timeout`;
- `provider_failure`;
- `retry_budget_exhausted`;
- `agent_unavailable`;
- `workspace_cleanup_failure`;
- `approval_required`;
- fallback `attention_required` for other durable attention/error events.

Informational activity is not turned into a notification.

## Per-operator state

A notification begins as `unread` without requiring a stored record.

```text
unread → read → acknowledged
   └────────────→ acknowledged
```

Acknowledgement:

- implies read;
- requires a bounded human-readable reason;
- cannot be downgraded by a later mark-read request;
- remains available after restart.

Operator state files use hashed filenames, and concurrent updates for one operator are serialized with a stale-safe lock.

## Idempotency and audit

Read and acknowledgement mutations require an idempotency key.

- Identical redelivery returns the stored response and original audit event ID.
- Reusing one key for a changed target or acknowledgement reason fails closed.
- Accepted mutations record actor, session when available, operation, notification ID, previous/resulting state, activity ID, notification type, Mission, Workflow, stage, and domain-idempotent status.
- Rejected domain actions are also audited when audit storage is available.

## Safety boundary

OPS-012H.2 cannot:

- invoke a provider;
- replay an uncertain effect;
- mutate a task, Workflow, stage, Mission, workspace, provider effect, or chat session;
- use Git or GitHub;
- change agent lifecycle;
- release or deploy;
- send email, Slack, Discord, or GitHub comments.

It excludes raw provider output, credentials, environment values, authenticated remotes, absolute host paths, unrestricted logs, chat transcripts, and private reasoning.

## Deferred to OPS-012H.3

- replace the existing task-snapshot Activity page with the durable activity index;
- add the dashboard notification badge and inbox UI;
- exact actionable drill-in;
- final restart/lifecycle/browser acceptance and OPS-012H close-out.
