# OPS-010B Workflow Read and Restart Reconciliation

Status: initial implementation slice

## Purpose

OPS-010B makes the durable `feature-development` workflow model observable and recoverable without granting automatic execution authority.

It introduces reusable bounded read handlers and startup reconciliation for interrupted active child records. It does not dispatch agents, execute Git, allocate workspaces, mutate GitHub, or advance workflow stages.

## Read contract

Planned authenticated routes:

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

Startup reconciliation scans durable workflow records before later HTTP integration begins serving workflow reads.

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

## Failure behavior

- Missing or corrupt records are reported as unavailable and are not repaired silently.
- A failed reconciliation does not create a replacement workflow.
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

## Next integration gate

After the handler and reconciler contracts pass Linux and Windows CI:

- add `OPS_ROOM_WORKFLOW_RUNS_DIR` to runtime paths;
- wire authenticated GET routes into the HTTP server;
- run reconciliation once during startup before serving workflow requests;
- expose workflow-store readiness in health;
- preserve all existing review/fix API and reconciliation behavior.
