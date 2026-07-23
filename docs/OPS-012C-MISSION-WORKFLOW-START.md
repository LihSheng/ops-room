# OPS-012C.3 — Mission-to-workflow binding and explicit start

## Purpose

This slice connects the V2 Mission product authority to the accepted deterministic V1 workflow authority.

A start request converts one durable `planned` mission into:

```text
Mission: active
        ↓ bound by workflow_id
Workflow: active
        ↓
Iteration 1 / implementation: pending / Professor
```

The operation records execution intent and prepares the first workflow child. It does not execute that child.

## HTTP contract

```text
POST /api/operator/missions/:missionId/start
```

Request:

```json
{
  "reason": "Start the approved mission from its recorded exact SHA.",
  "idempotency_key": "mission-start-..."
}
```

A browser-session request requires:

```text
Cookie: human operator session
X-Ops-Room-CSRF: <session-bound token>
X-Ops-Room-Confirmation: confirm:mission.start:POST:/api/operator/missions/:missionId/start
```

The dedicated operator bearer remains a bounded automation path and does not require browser CSRF or confirmation headers.

## Authority separation

| Record | Authority |
|---|---|
| Mission | Product objective, repository starting point, policy, participants, workflow binding |
| Workflow run | Deterministic execution state and iteration authority |
| Workflow child | Exact stage, owner, dependency SHA, attempt, and terminal evidence |
| Workspace | Isolated Git ownership and exact HEAD authority |
| Provider effect | External execution fencing and replay authority |

The start route calls the existing workflow-run and child services. It does not reimplement their state transitions.

## Deterministic identity

Each mission derives one workflow request key:

```text
mission-start:<mission_id>:v1
```

The existing workflow authority derives the workflow ID from:

```text
repository_id + request key
```

Repeated and concurrent starts therefore converge on one workflow record.

The first child is always:

```text
iteration: 1
stage: implementation
owner: professor
input_sha: mission.starting_sha
state: pending
```

## Transaction and recovery order

```text
cross-process mission start lock
        ↓
read and validate planned mission
        ↓
create or load deterministic workflow
        ↓
create or load first implementation child
        ↓
bind workflow_id to mission and mark active
        ↓
write accepted audit evidence
```

This order supports restart recovery:

- crash after workflow creation: retry loads the same workflow;
- crash after child creation: retry loads the same workflow and child;
- crash before mission binding: retry binds the existing verified workflow;
- active mission with missing or conflicting workflow evidence: fail closed;
- repeated completed request: return the existing binding without duplication.

The idempotency store additionally converges identical HTTP requests and rejects conflicting key reuse.

## Permission and safety controls

New permission:

```text
mission.start
```

Granted to:

- Operator;
- Administrator.

Denied to:

- Viewer;
- Reviewer;
- Deployer.

Browser mission start is a sensitive action and requires action-bound confirmation. Emergency read-only mode blocks the mutation before the route handler runs.

## Audit evidence

Operation:

```text
mission.start
```

Accepted audit metadata includes bounded identifiers and booleans:

- workflow ID;
- initial child ID;
- whether the workflow record was created or reused;
- whether the child was created or reused;
- whether the mission binding was newly written;
- `provider_invoked: false`.

Rejected requests record bounded error codes without credentials, paths, provider output, environment values, or private reasoning.

## Explicit non-goals

Mission start does not:

- allocate or inspect a workspace;
- activate or execute the pending child;
- invoke Professor or any provider;
- create a provider effect;
- mutate Git;
- push a branch;
- create or update a pull request;
- merge;
- deploy;
- replay an uncertain external effect.

Provider-backed advancement remains governed by the existing child-execution, workspace, effect, and recovery services.
