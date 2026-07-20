# OPS-010D Workflow Child Workspace Binding

Status: initial implementation slice

## Purpose

OPS-010D connects the durable `feature-development` workflow model to the accepted OPS-009 workspace authority without adding automatic agent execution.

The binding layer converts one validated workflow child into one deterministic task-workspace request, validates the resulting workspace record, and persists only bounded workspace metadata on the child.

## Stage workspace plan

| Stage | Owner | Workspace mode | Starting revision | Branch |
|---|---|---|---|---|
| implementation | Professor | writable branch | child `input_sha` | canonical feature branch for workflow + iteration |
| test | Tokyo | writable branch | Professor checkpoint `input_sha` | deterministic Tokyo test branch |
| integration | Professor | writable branch | Tokyo output `input_sha` | same canonical feature branch name as implementation |
| review | Berlin | detached | combined exact `input_sha` | none |

All starting revisions are full immutable 40-character SHAs.

The integration child may request the same canonical feature branch name used by implementation only after OPS-009 reports that no active workspace owns that branch. OPS-010D does not transfer ownership or clean up the prior workspace itself.

## Ownership contract

- one workflow child owns at most one workspace;
- one workspace record identifies exactly one workflow child task ID;
- workspace ID is deterministic from the child ID and owner agent;
- repository and owner must match the workflow record;
- mode, branch, requested SHA, and resolved SHA must match the fixed stage plan;
- only an `active` workspace may be newly bound;
- completed unbound children cannot receive retrospective workspace bindings;
- an existing identical binding is idempotently reused;
- a conflicting binding fails closed.

The authoritative workspace allocation, branch-conflict, capacity, disk, Git, and filesystem rules remain in OPS-009 services.

## Crash recovery

A process may fail after OPS-009 durably allocates the deterministic workspace but before the workflow child record is updated.

On retry:

1. the first allocation attempt encounters the existing deterministic workspace ID;
2. the binding layer switches to existing-record validation;
3. task ID, owner, repository, mode, branch, state, requested SHA, resolved SHA, and directory evidence are verified by the OPS-009 authority;
4. the bounded workspace summary is persisted on the child;
5. no duplicate worktree is created.

A missing record, directory, ownership mismatch, branch mismatch, mode mismatch, non-active state, or SHA mismatch remains a hard failure.

## Persisted and public metadata

The workflow child stores only:

- workspace ID;
- mode;
- repository identity;
- branch for writable workspaces;
- resolved starting SHA;
- bounded workspace state;
- cleanup-request and investigation-hold indicators.

Workflow API output excludes:

- absolute workspace paths;
- relative host paths used to locate worktrees;
- repository-cache paths;
- authenticated remotes;
- credentials, tokens, and environment values;
- raw Git or provider output.

Malformed workspace metadata is represented by a bounded `workflow_workspace_unavailable` value rather than exposing validation details.

## Explicit non-goals

- automatic workflow-child creation or activation;
- automatic Professor → Tokyo → Professor → Berlin dispatch;
- provider or agent invocation;
- command execution inside the workspace;
- automatic child completion or SHA production;
- workspace cleanup or branch-ownership transfer;
- push, pull request creation, merge, deployment, or lifecycle coupling;
- workflow mutation API or browser controls;
- PostgreSQL authority;
- any redefinition of OPS-009 workspace ownership.

## Next gate

A later reviewed slice may execute an already-created eligible workflow child inside its bound workspace and apply terminal workspace policy. That slice must preserve exact-SHA handoffs, effect idempotency, investigation holds, and existing review/fix behavior.
