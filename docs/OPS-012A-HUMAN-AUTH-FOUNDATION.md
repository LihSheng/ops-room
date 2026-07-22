# OPS-012A — Human Authentication Foundation

Status: **Emergency read-only and step-up confirmation slice**

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
- `session.manage`
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
| Administrative session listing and revocation | `session.manage` |

`OPS_ROOM_OPERATOR_API_ENABLED=false` continues to hide all operator mutation and audit endpoints, including from valid sessions.

## Emergency read-only mode

`OPS_ROOM_EMERGENCY_READ_ONLY_ENABLED=true` is the operational safety switch required by the V2 note.

When active:

- authenticated operator `GET`, `HEAD`, and `OPTIONS` requests remain available;
- every authenticated operator mutation is rejected before its route handler runs;
- bearer and browser-session mutations are blocked consistently;
- the response is `423` with `operator_emergency_read_only`;
- the rejected attempt is recorded as `operator.authorization.denied` with the actor, permission, method, and bounded path;
- audit persistence failure returns a bounded `503` response rather than allowing the mutation.

Session logout remains available through `DELETE /api/auth/session` so an operator can always terminate their own browser session. The emergency guard applies to bounded operator-control routes and does not reimplement task, lifecycle, workflow, workspace, or session state transitions.

## Step-up confirmation

Sensitive browser-session mutations require deliberate, action-bound confirmation after permission and CSRF validation.

The browser sends:

```text
X-Ops-Room-Confirmation: confirm:<permission>:<METHOD>:<API path>
```

Example:

```text
X-Ops-Room-Confirmation: confirm:agent.lifecycle:POST:/api/operator/agents/professor/stop
```

The confirmation is bound to the exact permission, HTTP method, and pathname. A confirmation for one agent, route, permission, or method cannot authorize another action.

The initial sensitive permission set is:

- `workflow.approve`;
- `agent.lifecycle`;
- `agent.configure`;
- `policy.manage` mutations;
- `session.manage` mutations;
- `repository.manage`;
- `release.approve`.

Ordinary `task.manage` and `workflow.recover` actions continue to require authentication, authorization, CSRF, a human-readable reason, idempotency, and durable route-level audit evidence, but do not require this additional confirmation header.

Missing or mismatched confirmation returns `428` with `operator_step_up_required` and writes an actor-attributed denial event. The dedicated operator bearer remains backward-compatible and does not use browser confirmation headers.

This control is explicit deliberate-action evidence for the current local identity model. It is not password re-entry, MFA, or external identity-provider reauthentication. A future identity-provider integration may replace it with stronger step-up authentication without changing the bounded route contracts.

## Durable authentication audit evidence

Session and authorization activity is recorded through the existing append-only audit store.

The current event model includes:

| Event | Outcome |
|---|---|
| `operator.session.create` | A bootstrap credential created a browser session |
| `operator.session.revoke` | The authenticated session logged out and was durably revoked |
| `operator.authorization.denied` | Permission, CSRF, step-up, or emergency-mode authorization was rejected |
| `operator.session.revoke.admin` | An administrator accepted or rejected cross-session revocation |

Session-authenticated audit actors include:

- human operator ID;
- display name;
- authentication method;
- bounded session ID.

Audit records never contain the raw session token, token hash, CSRF token, bearer credential, cookie value, environment values, or storage path.

A newly created session is not disclosed to the browser unless its creation audit event is written successfully. If audit persistence fails, the undisclosed session is revoked. Authorization denials also fail closed with a bounded unavailable response if their required audit evidence cannot be persisted.

## Administrative session management

Only the `administrator` role receives `session.manage`.

```text
GET  /api/operator/sessions
POST /api/operator/sessions/:session_id/revoke
```

Both endpoints remain hidden while `OPS_ROOM_OPERATOR_API_ENABLED=false`. The dedicated operator bearer remains a supported V1-compatible authorization path even when human authentication is disabled. Cookie-session authorization additionally requires `OPS_ROOM_HUMAN_AUTH_ENABLED=true`, a valid administrator session, and CSRF evidence for revocation.

The list endpoint exposes bounded public session metadata, status, expiry, and revocation attribution. It never exposes raw tokens, token hashes, cookies, CSRF values, file names, or storage paths. Optional filters are `actor_id`, `status`, and a validated `limit` from 1 to 100. Concurrent revocations of the same session are serialized within the running Ops Room process.

Cross-session revocation requires:

- an authenticated principal with `session.manage`;
- CSRF evidence for browser sessions;
- action-bound step-up confirmation for browser sessions;
- a reason of 1-500 characters;
- an 8-128 character idempotency key;
- durable session-state metadata identifying the revoking actor, reason, and idempotency key;
- an append-only `operator.session.revoke.admin` audit event.

A replay with the same actor, target, payload, and idempotency key returns the stored response without creating another audit event. Reusing the key for a different request is rejected. When an administrator revokes their current session, the response also clears the browser cookie.

## Configuration

```text
OPS_ROOM_OPERATOR_API_ENABLED=false
OPS_ROOM_OPERATOR_TOKEN=
OPS_ROOM_EMERGENCY_READ_ONLY_ENABLED=false
OPS_ROOM_HUMAN_AUTH_ENABLED=false
OPS_ROOM_OPERATOR_ID=
OPS_ROOM_OPERATOR_DISPLAY_NAME=
OPS_ROOM_OPERATOR_ROLES=
OPS_ROOM_OPERATOR_SESSION_TTL_SECONDS=28800
OPS_ROOM_OPERATOR_SESSION_COOKIE_SECURE=true
OPS_ROOM_OPERATOR_SESSIONS_DIR=/absolute/path/to/operator-sessions
```

Human authentication remains disabled unless `OPS_ROOM_HUMAN_AUTH_ENABLED=true` is configured explicitly.

`OPS_ROOM_EMERGENCY_READ_ONLY_ENABLED` defaults to `false`. Production operators can set it to `true` and restart the service to prevent all bounded operator mutations while preserving reads and logout.

`OPS_ROOM_OPERATOR_SESSION_COOKIE_SECURE=false` is intended only for direct localhost HTTP development. Production traffic behind HTTPS should keep secure cookies enabled.

## Security boundaries

This implementation does not:

- accept the dashboard token as a human credential;
- accept the webhook secret as a human credential;
- store raw session tokens;
- persist session, CSRF, or confirmation values in audit events;
- permit cookie mutations without CSRF evidence;
- permit sensitive cookie mutations without action-bound confirmation;
- allow operator mutations while emergency read-only mode is active;
- grant unknown roles or permissions;
- enable operator APIs automatically;
- expose session hashes, storage paths, environment values, or credentials;
- introduce password storage, account registration, MFA, or external identity-provider integration;
- expose authentication material through administrative session APIs;
- add the dashboard login/logout interface.

## Remaining OPS-012A order

1. Add the minimal dashboard login/logout experience and session-backed dashboard reads.
2. Run the production authentication and credential-separation drill.

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
- session creation and logout audit events;
- session-attributed permission and CSRF denial events;
- emergency read-only rejection for bearer and session mutations;
- authenticated reads while emergency mode is active;
- exact permission, method, and path binding for sensitive confirmations;
- step-up denial audit evidence and audit failure handling;
- ordinary task management without unnecessary step-up;
- administrator-only session listing and filtering;
- reason- and idempotency-guarded cross-session revocation;
- self-revocation cookie clearing;
- continued legacy operator-bearer authorization;
- hidden operator endpoints while the operator API is disabled.
