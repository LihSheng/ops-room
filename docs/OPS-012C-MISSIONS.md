# OPS-012C — Mission data model and creation

## First implementation slice

This slice introduces the durable Mission authority required by Ops Room V2.

Mission creation records an authenticated operator's approved intent. It does **not** start a workflow, allocate a workspace, dispatch an agent, invoke a provider, or mutate Git.

## Mission schema

The initial schema is:

```text
ops-room.mission.v1
```

A valid mission contains:

- bounded mission title and objective;
- validated repository ID;
- validated starting branch;
- exact lowercase 40-character starting SHA;
- the fixed `feature-development` workflow type;
- maximum-iteration policy;
- the fixed `berlin-review-required` approval policy;
- canonical Professor → Tokyo → Professor → Berlin stage ownership;
- optional GitHub issue, reference identifiers, required capabilities, priority, deadline, and supporting context;
- authenticated creator identity;
- durable timestamps and history;
- `planned` state;
- `workflow_id: null` until an explicit future start/binding operation.

## API contract

Read APIs:

```text
GET /api/missions
GET /api/missions/:missionId
```

Creation API:

```text
POST /api/operator/missions
```

Creation requires:

- enabled operator API;
- authenticated bearer operator or human operator session;
- `mission.create` permission;
- CSRF protection for session-based requests;
- human-readable reason;
- valid idempotency key;
- bounded validated mission input;
- durable accepted or rejected audit evidence.

The `mission.create` permission belongs to the `operator` and `administrator` roles. Viewer, reviewer, and deployer roles cannot create missions.

## Required request fields

```text
title
objective
repository
starting_branch
starting_sha
workflow_type
max_iterations
approval_policy
reason
idempotency_key
```

The MVP accepts only:

```text
workflow_type: feature-development
approval_policy: berlin-review-required
```

## Optional request fields

```text
github_issue
reference_documents
required_capabilities
priority
deadline
supporting_context
```

Reference identifiers are bounded and cannot be absolute local paths or `file:` URLs.

## Security and execution boundaries

Mission creation does not:

- create a V1 workflow run;
- bind a workflow ID;
- allocate or inspect a workspace;
- create tasks or workflow children;
- invoke Professor, Tokyo, Berlin, or any provider;
- create commits, branches, pull requests, or deployment effects;
- expose credentials, environment values, authenticated remotes, provider output, filesystem paths, unrestricted logs, or private reasoning.

The future mission-start operation must reuse the existing deterministic workflow service contracts rather than reimplementing workflow transitions in an HTTP route.

## Idempotency and concurrency

Mission IDs are deterministic for one repository, title, and client request key.

The idempotency store fences concurrent and repeated requests by actor, operation, target, and key:

- identical requests replay the original response;
- conflicting reuse of a key returns `IDEMPOTENCY_CONFLICT`;
- concurrent creation converges on one durable mission file;
- durable mission-record conflicts fail closed.

## Follow-up slices

1. Mission creation dashboard form.
2. Explicit mission-to-workflow binding and start operation.
3. Current mission evidence in Agent Fleet and Agent Detail.
4. Mission Room and workflow timeline under OPS-012D.
