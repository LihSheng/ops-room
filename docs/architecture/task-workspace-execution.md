# Task Workspace Execution Architecture

Status: Accepted for OPS-009

## Decision

Every new executable review or fix task owns one durable isolated Git worktree backed by a shared bare repository cache.

The workspace layer is authoritative for repository checkout isolation. Agent lifecycle state, provider runtime state, GitHub effects, task leases, and task state remain separate authorities.

## Sources of truth

| Concern | Authority |
|---|---|
| Shared Git objects and worktree administration | `repository-cache.ts` and `workspace-manager.ts` |
| Durable workspace identity and lifecycle | workspace records under `OPS_ROOM_WORKSPACE_RECORDS_DIR` |
| Task-to-workspace binding | additive bounded fields on the durable review/fix task |
| Task execution state, lease, and history | review task store |
| External GitHub effects | effect ledger |
| Runtime process state | runtime adapter and lifecycle stores |

## Workspace modes

### Detached review workspace

Review tasks require a 40-character exact SHA. The workspace manager creates a detached worktree and records the resolved SHA. Before any GitHub review or chat effect, the review workflow verifies that local `HEAD` equals the reviewed SHA.

A review must never execute from:

- the shared bare cache;
- a mutable default branch checkout;
- another task's writable worktree;
- an unverified or symbolic ref.

### Writable fix workspace

Fix and implementation tasks use one writable branch worktree. Active branch ownership is exclusive per repository and branch. The fix worker receives the pre-bound workspace and is not allowed to create a second clone.

File writes, approved verification commands, commit, and push execute from the managed worktree. The workspace lifecycle, not the worker, owns cleanup.

## Ordering invariant

The required order is:

```text
allocate or recover workspace
        ↓
persist bounded task binding
        ↓
transition task to RUNNING or FIXING
        ↓
execute from isolated worktree
        ↓
persist terminal task state
        ↓
request cleanup or investigation hold
```

A provider or Git failure cannot cause cleanup before the terminal task transition is durable.

## Completion and failure policy

- `PASSED` and `FIX_PUSHED` request cleanup.
- `ERROR`, `NEEDS_HUMAN`, `CANCELLED`, `CANCEL_REQUESTED`, and `SUPERSEDED` are held for investigation.
- Active and queued tasks preserve the workspace.
- Cleanup and hold operations are idempotent.
- Held, active, or ambiguous workspaces cannot be deleted automatically.

The review reconciler applies terminal workspace outcomes at startup and on its recurring cycle. This allows recovery when the process exits after persisting a terminal task state but before updating the workspace lifecycle.

## Restart reconciliation

For active tasks, reconciliation validates:

- workspace record availability;
- exact task ID ownership;
- agent ownership;
- repository identity;
- path containment;
- worktree directory existence;
- executable workspace state.

A mismatch transitions the active task to `NEEDS_HUMAN` with a bounded reason. Reconciliation does not allocate a replacement or delete ambiguous data.

Legacy active tasks without workspace metadata remain readable as `legacy_unbound`. They are not silently migrated while running.

## Public read model

Task APIs expose only bounded workspace metadata:

- workspace ID;
- mode;
- repository ID;
- branch when writable;
- resolved SHA;
- lifecycle state;
- cleanup-requested flag;
- investigation-hold flag.

They do not expose absolute paths, repository-cache paths, remotes, credentials, raw Git output, or host environment values.

## Capacity and disk safety

Allocation is denied when the configured active-workspace quota or minimum-free-disk threshold is reached. Ops Room does not evict another task's workspace automatically.

## Security boundary

Git administration and managed push operations use fixed executable and argument arrays without a shell. Verification commands are selected from an explicit approved set. File destinations are validated as safe relative paths beneath the worktree root.

## Explicit non-goals

OPS-009 does not add:

- Professor → Tokyo → Berlin parent/child orchestration;
- automatic PR creation or merge;
- lifecycle start/stop coupling;
- browser workspace mutation controls;
- general workflow authoring;
- PostgreSQL authority.

Those remain separate future work, primarily OPS-010 and later governance milestones.
