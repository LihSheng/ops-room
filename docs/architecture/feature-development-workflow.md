# OPS-010A Feature Development Workflow Foundation

Status: initial implementation slice

## Purpose

OPS-010A introduces one bounded `feature-development` workflow record above the existing OPS-009 task-workspace ownership layer. It records durable parent and child state but does not automatically execute agents or mutate GitHub.

## Stage model

```text
Professor implementation
        ↓ immutable checkpoint SHA
Tokyo test development
        ↓ immutable test SHA
Professor integration
        ↓ immutable combined SHA
Berlin exact-SHA review
```

The stage graph is fixed. It is not a general workflow engine.

| Stage | Canonical owner | Dependency |
|---|---|---|
| `implementation` | `professor` | source SHA for iteration 1; prior review output for later iterations |
| `test` | `tokyo` | implementation output SHA from the same iteration |
| `integration` | `professor` | test output SHA from the same iteration |
| `review` | `berlin` | integration output SHA from the same iteration |

## Durable identity

A parent workflow ID is deterministic from the canonical repository identity and a bounded request key. Restart recovery or an identical retry resolves to the same record.

A child ID is deterministic from:

- parent workflow ID;
- iteration number;
- fixed stage name.

Recreating a child with the same immutable fields returns the existing child. A conflicting owner, dependency, iteration, stage, or input SHA fails closed.

## State model

Parent states:

```text
planned | active | blocked | completed | needs_human | cancelled
```

Child states:

```text
pending | active | completed | failed | cancelled | needs_human
```

The first slice implements child creation, activation, completion, failure, and explicit retry. It does not automatically advance stages or replay provider/Git effects after restart.

## Immutability and recovery

- Every child input is an exact 40-character commit SHA.
- A downstream child can be created only after its dependency is durably completed.
- The dependency output SHA must exactly equal the downstream input SHA.
- Completing a child is idempotent for the same output SHA.
- A different output SHA for an already-completed child is rejected.
- Failed children retain history and increment their attempt when explicitly retried.
- A later iteration can begin only from the completed review output of the prior iteration.
- Maximum iteration and concurrency policies are bounded and persisted on the parent run.
- Duplicate or structurally ambiguous records fail validation rather than being repaired silently.

## OPS-009 relationship

OPS-010A does not redefine workspace ownership.

When execution integration is added later:

- implementation, test, and integration children must use OPS-009 writable branch workspaces;
- review children must use OPS-009 detached exact-SHA workspaces;
- one child task owns one workspace;
- retries and restart recovery reuse the existing valid workspace binding;
- no workflow transition may bypass workspace owner, repository, branch, or SHA validation.

## Read boundary

Public workflow serialization exposes only bounded identifiers, states, policy, ownership, dependency, attempt, timestamps, and immutable SHAs.

It excludes:

- absolute host paths;
- workspace and repository-cache paths;
- authenticated remotes;
- credentials and tokens;
- environment values;
- raw provider or Git output.

## Explicit non-goals

- automatic Professor → Tokyo → Berlin dispatch;
- arbitrary child-task graphs;
- a drag-and-drop workflow editor;
- automatic push, pull request creation, merge, or deployment;
- browser workflow mutation before authentication and RBAC;
- agent lifecycle start or stop coupling;
- PostgreSQL authority;
- changes to existing review/fix task semantics.
