# Workflow Read Operations

## Purpose

This runbook covers the read-only OPS-010 workflow endpoints and startup recovery behavior. It does not authorize workflow mutation or automatic agent execution.

## Persistent configuration

Set an absolute persistent directory in the production environment when the default Ops Room data root is not sufficient:

```text
OPS_ROOM_WORKFLOW_RUNS_DIR=/var/lib/ops-room/workflow-runs
```

The directory must:

- exist on persistent storage outside `/opt/ops-room/releases/<sha>`;
- be readable and writable by the Ops Room service account;
- survive release activation and rollback;
- never contain credentials, authenticated remotes, or provider homes.

When the variable is omitted, Ops Room uses `<OPS_ROOM_DATA_DIR>/workflow-runs`.

## Startup behavior

Before the HTTP server is imported, Ops Room scans durable workflow records.

- Active child records are treated as interrupted and moved to `needs_human`.
- The parent workflow moves to `needs_human`.
- Completed children, prior iterations, immutable input/output SHAs, and history are preserved.
- Re-running startup reconciliation is idempotent.
- No provider, Git, GitHub, workspace, branch, commit, review, lifecycle, or deployment effect is replayed.

Bounded startup logs may report recovered child counts or unavailable record counts. They must not print workflow contents, host paths, credentials, remotes, or raw parse errors.

## Authentication

Use the existing dashboard bearer credential:

```text
Authorization: Bearer <dashboard-token>
```

Unauthenticated requests return HTTP 401.

## List workflows

```text
GET /api/workflows
```

Optional filters:

```text
limit=1..100
repository=<exact owner/repository identity>
state=planned|active|blocked|completed|needs_human|cancelled
```

Examples:

```text
GET /api/workflows?limit=20
GET /api/workflows?repository=LihSheng/ops-room
GET /api/workflows?state=needs_human
```

## Workflow detail

```text
GET /api/workflows/:workflowId
```

The endpoint returns bounded parent and child state, fixed ownership, dependencies, attempts, iterations, policy, timestamps, and immutable SHAs.

## Unavailable records

A corrupt or structurally ambiguous record is exposed only as a bounded unavailable summary with:

```text
unavailable = true
last_error = workflow_record_unavailable
```

Raw JSON, parse errors, validation details, filesystem paths, and record contents are not returned.

## Health verification

Check:

```text
GET /api/health
```

Expected dependency:

```text
dependencies.workflow_store.status = ok
```

The overall readiness becomes false when the workflow directory is not readable and writable.

## Investigation flow

When startup reports recovered or unavailable workflows:

1. Query `GET /api/workflows?state=needs_human`.
2. Inspect the bounded workflow detail.
3. Verify the persistent workflow directory permissions and available storage.
4. Preserve the record and related OPS-009 workspace for investigation.
5. Do not edit completed child history or immutable SHAs manually.
6. Do not restart provider or Git effects automatically.

Workflow mutation and human resolution actions remain deferred to a separately reviewed OPS-010 slice.
