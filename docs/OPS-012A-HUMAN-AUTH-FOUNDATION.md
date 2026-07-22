# OPS-012A — Human Authentication Foundation

Status: **Session route and authorization slice**

Issue: #54

## Goal

Introduce authenticated human operators in Ops Room V2 without weakening the V1 service-credential boundaries or enabling browser mutation authority by default.

## Canonical roles

The first V2 role set is:

- `viewer`
- `operator`
- `reviewer`
- `administrator`
- `deployer`

Unknown or empty role assignments fail closed.

## Permission model

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

## Durable opaque sessions

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

## Session HTTP contract

Human authentication remains hidden behind `OPS_ROOM_HUMAN_AUTH_ENABLED`.

```text
POST   /api/auth/session
GET    /api/auth/session
DELETE /api/auth/session
```

### Bootstrap

`POST /api/auth/session` exchanges only the dedicated `OPS_ROOM_OPERATOR_TOKEN` bearer credential for a bounded browser session.

The dashboard token and webhook secret are never accepted for bootstrap. The response sets the opaque session in an `HttpOnly` cookie and returns a session-bound CSRF token.

### Read

`GET /api/auth/session` resolves the opaque cookie through the durable session store and returns only the public operator identity, roles, expiry, and derived CSRF token.

### Revoke

`DELETE /api/auth/session` requires both the valid session cookie and its `X-Ops-Room-CSRF` token. Revocation is durable and the response clears the browser cookie.

## Operator authorization boundary

Existing operator actions accept either:

1. the existing dedicated operator bearer credential; or
2. an enabled, unexpired, unrevoked human session with the required permission.

Cookie-authenticated mutations require session-bound CSRF evidence. Bearer-authenticated service/operator requests preserve the V1 behavior and do not use cookie CSRF.

Current permission mappings are:

| Operation | Session permission |
|---|---|
| Task cancel, retry, pause, resume | `task.manage` |
| Agent lifecycle start and stop | `agent.lifecycle` |
| Ambiguous workflow-effect resolution | `workflow.recover` |
| Audit-event reads | `policy.manage` |

`OPS_ROOM_OPERATOR_API_ENABLED=false` continues to hide all operator mutation and audit endpoints, including from valid sessions.

## Configuration

```text
OPS_ROOM_OPERATOR_API_ENABLED=false
OPS_ROOM_OPERATOR_TOKEN=
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

This implementation does not:

- accept the dashboard token as a human credential;
- accept the webhook secret as a human credential;
- store raw session tokens;
- permit cookie mutations without CSRF evidence;
- grant unknown roles or permissions;
- enable operator APIs automatically;
- expose session hashes, storage paths, environment values, or credentials;
- introduce password storage, account registration, or external identity-provider integration;
- add administrative session listing or cross-session revocation;
- add the dashboard login/logout interface.

## Remaining OPS-012A order

1. Add actor-attributed session creation, revocation, and authorization audit events.
2. Add administrative session listing and cross-session revocation.
3. Add emergency read-only mode and step-up confirmation for sensitive actions.
4. Add the minimal dashboard login/logout experience.
5. Run the production authentication and credential-separation drill.

## Tests

Coverage includes:

- role normalization and permission union behavior;
- administrator/deployer separation;
- session creation, expiry, and durable revocation;
- raw-token non-persistence;
- strict session-cookie handling;
- hidden endpoints while human authentication is disabled;
- bootstrap rejection for non-operator credentials;
- session read and revoke behavior;
- CSRF rejection and success paths;
- permission denial for insufficient session roles;
- continued legacy operator-bearer authorization;
- hidden operator endpoints while the operator API is disabled.
