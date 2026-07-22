# OPS-012A — Human Authentication Foundation

Status: **Initial implementation slice**

Issue: #54

## Goal

Introduce the durable primitives required for authenticated human operators in Ops Room V2 without changing the V1 runtime boundary or enabling browser mutation authority by default.

## Included in this slice

### Canonical roles

The first V2 role set is:

- `viewer`
- `operator`
- `reviewer`
- `administrator`
- `deployer`

Unknown or empty role assignments fail closed.

### Permission model

Roles resolve to bounded permissions rather than route-specific role-name checks:

- `dashboard.read`
- `task.manage`
- `workflow.recover`
- `workflow.approve`
- `agent.lifecycle`
- `agent.configure`
- `policy.manage`
- `repository.manage`
- `release.approve`

`administrator` and `deployer` remain separate authorities. An administrator does not automatically receive release approval authority.

### Durable opaque sessions

The session store provides:

- 256-bit opaque random session tokens;
- SHA-256 token hashes at rest;
- one durable JSON record per token hash;
- bounded expiry between five minutes and seven days;
- explicit durable revocation;
- fail-closed handling for missing, malformed, expired, revoked, or corrupted records;
- public session projections that omit token hashes and filesystem information;
- `HttpOnly`, `SameSite=Strict` cookie serialization;
- secure cookies by default.

Raw session tokens are returned only at creation time and are never written to disk.

## Configuration

```text
OPS_ROOM_HUMAN_AUTH_ENABLED=false
OPS_ROOM_OPERATOR_ID=
OPS_ROOM_OPERATOR_DISPLAY_NAME=
OPS_ROOM_OPERATOR_ROLES=
OPS_ROOM_OPERATOR_SESSION_TTL_SECONDS=28800
OPS_ROOM_OPERATOR_SESSION_COOKIE_SECURE=true
OPS_ROOM_OPERATOR_SESSIONS_DIR=/absolute/path/to/operator-sessions
```

Human authentication remains disabled unless `OPS_ROOM_HUMAN_AUTH_ENABLED=true` is configured explicitly.

`OPS_ROOM_OPERATOR_SESSION_COOKIE_SECURE=false` is intended only for direct localhost HTTP development. Production traffic behind HTTPS should keep secure cookies enabled.

## Security boundaries

This slice does not:

- accept the dashboard token as a human credential;
- accept the webhook secret as a human credential;
- change existing operator mutation authorization;
- expose a login endpoint;
- authorize browser mutations through cookies;
- add CSRF-sensitive cookie-authenticated mutation routes;
- enable operator APIs automatically;
- expose session hashes, storage paths, environment values, or credentials.

## Follow-up implementation order

1. Add bootstrap session create/read/revoke routes using only the dedicated operator credential.
2. Add cookie-session principal resolution.
3. Add CSRF validation before any cookie-authenticated mutation.
4. Map existing bounded operator actions to explicit permissions.
5. Add actor-attributed session and authorization audit events.
6. Add administrative session revocation and emergency read-only mode.
7. Add the minimal dashboard login/logout experience.

## Tests

The initial tests cover:

- role normalization and deduplication;
- unknown role rejection;
- permission union behavior;
- administrator/deployer separation;
- session creation and expiry;
- raw-token non-persistence;
- malformed-token rejection;
- durable and idempotent revocation;
- strict session-cookie handling;
- invalid actor, role, TTL, and token rejection.
