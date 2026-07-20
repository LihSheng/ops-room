# OPS-010 Workflow Read and Restart Reconciliation

Status: integrated runtime contract

## Purpose

OPS-010B and OPS-010C make the durable `feature-development` workflow model observable and restart-recoverable without granting automatic execution authority.

The implementation provides bounded authenticated reads, startup reconciliation for interrupted active child records, persistent runtime-path configuration, and workflow-store health readiness. It does not dispatch agents, execute Git, allocate workspaces, mutate GitHub, or advance workflow stages.

## Runtime authority

Workflow records are persistent runtime data stored under:

```text
OPS_ROOM_WORKFLOW_RUNS_DIR
```

When the environment override is absent, the default is:

```text
<OPS_ROOM_DATA_DIR>/workflow-runs
```

The workflow directory remains outside immutable release artifacts. Application activation and rollback must preserve it.

## Authenticated read contract

The existing dashboard bearer authentication protects:

```text
GET /api/workflows
GET /api/workflows/:workflowId
```

The list contract supports bounded filters:

- `limit`: 1 to 100;
- `repository`: exact canonical repository identity;
- `state`: one approved parent workflow state.

Public output includes only:

- workflow ID and fixed workflow type;
- repository identity and request key;
- source and handoff SHAs;
- parent and child states;
- fixed stage, owner, dependency, iteration, and attempt;
- bounded policy values;
- timestamps and bounded last-error codes.

Public output excludes:

- absolute host paths;
- task-workspace and repository-cache paths;
- authenticated remotes;
- credentials, tokens, and environment values;
- raw Git, provider, or runtime output.

A corrupt or structurally ambiguous record is represented by a bounded `workflow_record_unavailable` summary. Raw parse or validation errors are not returned.

## Restart reconciliation

The webhook entrypoint initializes profile, skill, and memory registries, then reconciles workflow records before importing the HTTP server. Workflow reads therefore cannot observe an unreconciled active child left by a previous process.

For every valid workflow:

1. Completed, pending, failed, cancelled, and existing `needs_human` children remain unchanged.
2. Every child left in `active` is treated as interrupted work.
3. The child transitions to `needs_human` with `workflow_child_interrupted` evidence.
4. The parent transitions to `needs_human`.
5. Existing `started_at`, completed history, previous iterations, and immutable SHAs are preserved.
6. A bounded reconciliation event records only the affected child IDs.

Reconciliation is idempotent. Running it again finds no `active` child and adds no duplicate history.

## Concurrency and persistence

Each reconciliation write is serialized by a filesystem lock derived from the workflow ID. The lock file contains no workflow content or credentials and is removed after the bounded operation.

Workflow records and reconciliation locks remain persistent runtime data outside immutable releases.

## Health contract

`GET /api/health` reports `workflow_store` as a required dependency and exposes the configured workflow directory in the existing bounded paths section.

- A readable and writable workflow store reports `ok`.
- An unavailable workflow directory makes readiness false.
- Individual corrupt records do not expose parse details and remain visible only as unavailable workflow summaries.

## Failure behavior

- Missing or corrupt records are reported as unavailable and are not repaired silently.
- A failed reconciliation does not create a replacement workflow.
- An unavailable workflow store fails startup or health readiness rather than silently dropping durable state.
- No child, branch, commit, review, workspace, or external effect is replayed.
- Ambiguity remains visible for human investigation.

## Explicit non-goals

- automatic Professor → Tokyo → Professor → Berlin execution;
- workflow mutation APIs;
- browser workflow controls;
- automatic branch, commit, push, pull request, merge, or deployment actions;
- runtime lifecycle coupling;
- PostgreSQL authority;
- any change to OPS-009 workspace ownership rules.

## Next orchestration gate

The next OPS-010 slice may connect durable workflow children to OPS-009 workspaces and existing task executors. It must preserve exact-SHA handoffs, one-child-to-one-workspace ownership, immutable completed iterations, bounded concurrency, and human escalation. Automatic execution must not begin until that integration has focused recovery and idempotency coverage.
