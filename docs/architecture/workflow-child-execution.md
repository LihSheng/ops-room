# OPS-010E Explicit Workflow Child Execution

Status: initial implementation slice

## Purpose

OPS-010E adds one internal execution contract for an already-created and already-bound workflow child. It does not create a workflow, choose the next stage, expose a mutation endpoint, or automatically invoke an agent.

A trusted internal caller must explicitly select one workflow and child. The execution service validates durable state, serializes concurrent attempts, activates the child, invokes an injected stage runner inside the managed OPS-009 workspace, validates the resulting SHA evidence, persists the terminal child state, and then applies terminal workspace policy.

## Required preconditions

The service requires:

- a valid `feature-development` workflow in `planned` or `active` state;
- one child in `pending` state;
- a pre-existing bounded workspace binding on that child;
- an OPS-009 workspace record matching the child task ID, owner agent, repository, mode, branch, requested SHA, resolved SHA, and active state;
- a managed workspace directory that passes the existing path and directory checks;
- an explicitly injected stage runner;
- an explicitly injected workspace-HEAD inspector for writable stages.

The service does not allocate an unbound child workspace. It calls the OPS-010D binding authority only to validate and reuse the existing binding.

## Execution ordering

```text
acquire filesystem execution lock
        ↓
re-read workflow and child
        ↓
validate existing workspace binding
        ↓
persist child state = active
        ↓
invoke one injected stage runner
        ↓
validate bounded terminal outcome
        ↓
persist completed or needs_human
        ↓
request cleanup or investigation hold
```

External execution begins only after durable activation.

The execution lock is derived from the workflow and child IDs. It serializes explicit attempts across processes that share the workflow data directory. The default stale threshold is six hours so a normal long-running agent operation is not mistaken for an abandoned lock. Operators must investigate before removing a stale execution lock.

## Stage-runner boundary

The runner receives only:

- bounded workflow identity, repository, source SHA, state, policy, and current iteration;
- bounded child identity, stage, owner, iteration, attempt, dependency, state, and input SHA;
- the internal managed workspace path needed for execution;
- the bounded workspace summary.

It does not receive workflow history, request keys, credentials, authenticated remotes, environment values, repository-cache paths, raw provider output, or unrestricted host state.

The runner may return only:

```text
{ outcome: "completed", output_sha: <exact 40-character SHA> }
```

or:

```text
{ outcome: "needs_human", reason: <bounded reason code> }
```

Unknown result shapes and unsafe free-form errors become the bounded reason `workflow_child_runner_failed`.

## SHA verification

Writable stages (`implementation`, `test`, and `integration`) require an injected workspace-HEAD inspector. The exact returned workspace HEAD must equal the runner's `output_sha` before completion can be persisted.

The `review` stage uses a detached exact-SHA workspace. A successful review result must return the same SHA as the child's immutable `input_sha`; review execution cannot claim a new source revision.

Output mismatch, invalid SHA evidence, or missing inspection authority moves the active child to `needs_human` and holds the workspace for investigation.

## Durable terminal behavior

### Successful completion

1. Persist child state `completed` and immutable `output_sha`.
2. Request workspace cleanup through the existing OPS-009 lifecycle authority.
3. Do not remove the worktree inside the execution transaction.

If cleanup-request persistence fails after completion, the completion evidence remains authoritative and immutable. The operational error is reported for reconciliation; the child is not rewritten to `needs_human`.

### Needs human or runner failure

1. Persist child state `needs_human` with a bounded reason code.
2. Persist parent workflow state `needs_human`.
3. Place the workspace in `held_for_investigation`.

The service never stores raw exception text from an untrusted runner.

## Idempotency and restart behavior

- Completed and `needs_human` children return a deduplicated terminal result without invoking the runner again.
- An already-active child returns `workflow_child_execution_in_progress` and is never replayed.
- Concurrent explicit attempts serialize; after the first completes, the second observes the durable terminal state and does not execute the runner.
- Startup reconciliation remains authoritative for a process interrupted after activation. It converts an interrupted active child to `needs_human`; it never replays provider or workspace effects.
- Explicit retry remains a separate future operation.

## Workspace sequencing

Successful child execution requests cleanup but does not execute cleanup automatically. The next stage may not bind a branch that remains actively owned by the prior child.

For the canonical Professor implementation → Tokyo test → Professor integration sequence, a later coordinator must verify the previous workspace has reached `released` before binding a conflicting writable branch. OPS-010E does not transfer branch ownership.

## Explicit non-goals

- automatic workflow or child creation;
- automatic child binding, activation, retry, or stage selection;
- automatic Professor → Tokyo → Professor → Berlin dispatch;
- provider-specific OpenAB or OpenCode wiring;
- HTTP mutation endpoints or browser controls;
- automatic cleanup execution or branch ownership transfer;
- Git push, pull request creation, review posting, merge, or deployment;
- agent lifecycle mutation;
- PostgreSQL authority;
- changes to existing review/fix execution behavior or OPS-009 ownership rules.

## Next gate

A later reviewed slice may add a provider-specific stage runner and an explicitly enabled coordinator. It must preserve this contract, use durable effect fencing for every external Git/GitHub action, wait for required workspace release, and model Berlin approval versus requested changes before automatically advancing an iteration.
