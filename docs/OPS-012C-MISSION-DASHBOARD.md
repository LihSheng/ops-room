# OPS-012C.2 — Mission creation dashboard

## Purpose

Expose the existing bounded `POST /api/operator/missions` contract through a human-operated dashboard form.

This slice does not add a new server mutation or workflow authority. It records one planned Mission through the durable OPS-012C.1 service contract.

## Entry point

The Agent Fleet page displays **Create mission** for a valid human session with either:

- `operator` role; or
- `administrator` role.

Legacy dashboard-token mode and other roles remain read-only.

## Browser mutation boundary

The form sends:

```text
POST /api/operator/missions
Cookie: HttpOnly human session
X-Ops-Room-CSRF: <session-bound token>
Content-Type: application/json
```

The browser does not store or resend the bootstrap operator bearer.

The backend remains authoritative for permission, emergency read-only, CSRF, validation, idempotency, concurrency, persistence, and audit decisions.

## Form contract

Required operator input:

- title;
- objective;
- repository;
- starting branch;
- exact 40-character starting SHA;
- maximum iterations from 1 through 20;
- operator reason.

Fixed MVP policy:

```text
workflow_type: feature-development
approval_policy: berlin-review-required
Professor implementation → Tokyo tests → Professor integration → Berlin review
```

Optional input:

- GitHub issue;
- priority;
- deadline;
- reference-document identifiers;
- required capabilities;
- supporting context.

## Idempotency behavior

The dashboard generates one bounded idempotency key for a submission attempt.

- an identical retry retains the same key;
- editing the request after an attempted submission generates a new key;
- successful creation resets the form and generates a new key;
- conflicting reuse remains rejected by the backend.

## Result

Successful creation displays a notification that the mission is in `planned` state and explicitly confirms that no workflow was started.

Bounded server errors may display:

- safe error message;
- error code;
- audit-event ID.

Credentials, environment values, storage paths, provider output, authenticated remotes, and private reasoning are never displayed.

## Deferred

- mission list and detail workspace;
- explicit mission-to-workflow binding and start;
- current mission evidence in Agent Fleet and Agent Detail;
- Mission Room and workflow timeline;
- task dispatch, provider invocation, Git mutation, PR creation, merge, or deployment.
