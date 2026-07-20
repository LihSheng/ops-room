# Task Workspace Operations

## Purpose

OPS-009 gives each executable review or fix task one durable isolated Git worktree backed by a shared bare repository cache.

Review workspaces are detached at an immutable exact SHA. Fix and implementation workspaces own one writable branch. Workspace allocation is separate from agent lifecycle control and from OPS-010 multi-agent orchestration.

## Persistent roots

Configure these outside immutable release directories:

```text
OPS_ROOM_REPOSITORY_CACHE_ROOT
OPS_ROOM_TASK_WORKSPACE_ROOT
OPS_ROOM_WORKSPACE_RECORDS_DIR
OPS_ROOM_WORKSPACE_LOCK_DIR
```

Defaults are derived from `OPENAB_DATA_DIR` and `OPS_ROOM_DATA_DIR`.

Recommended production layout:

```text
/var/lib/openab/data/repositories/        shared bare Git caches
/var/lib/openab/data/workspaces/          isolated task worktrees
/var/lib/openab/data/ops-room/workspaces/ durable workspace records
/var/lib/openab/data/ops-room/workspace-locks/ bounded filesystem locks
```

The service account must own these roots. They must not be writable by the public ingress account and must never be included in immutable release archives.

## Capacity controls

```text
OPS_ROOM_WORKSPACE_MAX_ACTIVE
OPS_ROOM_WORKSPACE_MIN_FREE_BYTES
```

Allocation fails closed when either limit is reached. Ops Room does not delete another task's workspace to make room.

## Workspace modes

### Detached review

- Required for review tasks.
- Requires an exact 40-character commit SHA.
- `git rev-parse HEAD` must equal the recorded reviewed SHA before any review effect is posted.
- Multiple detached workspaces may inspect the same SHA independently.

### Writable branch

- Required for fix and implementation tasks.
- One active workspace may own a repository branch.
- A second task attempting to own the same writable branch is rejected before worktree creation.
- File edits, approved verification commands, commit, and push run from this managed worktree.

## Task binding

A task stores bounded workspace metadata:

- workspace ID;
- mode;
- repository ID;
- branch where applicable;
- resolved SHA;
- workspace lifecycle state;
- cleanup and investigation-hold flags.

Absolute host paths, authenticated remotes, cache paths, tokens, raw Git output, and environment values are not public task metadata.

## Completion policy

- `PASSED` and `FIX_PUSHED` request cleanup only after the terminal task transition is durable.
- `ERROR`, `NEEDS_HUMAN`, `CANCELLED`, `CANCEL_REQUESTED`, and `SUPERSEDED` preserve the workspace under an investigation hold.
- Running or queued workspaces are not cleaned.
- Cleanup and hold operations are idempotent.
- An investigation-held workspace is never removed automatically.

## Restart recovery

At restart, reconcile task and workspace evidence without allocating or deleting anything:

1. Read the task's workspace ID.
2. Read the durable workspace record.
3. Verify task ID, agent owner, and repository identity.
4. Verify the relative path remains below the configured workspace root.
5. Verify the worktree directory exists.
6. Verify active tasks reference an executable workspace state.

Missing, mismatched, corrupt, or ambiguous evidence is reported as blocked. Operators must investigate; Ops Room does not guess or create a replacement workspace.

Legacy active tasks without workspace metadata remain readable and are classified as `legacy_unbound`. They must not be silently migrated while running.

## Diagnostics

Inspect only sanitized task/workspace metadata through authenticated read APIs. On the host, operators may inspect:

```bash
git --git-dir <cache>.git worktree list --porcelain
```

Do not paste authenticated remote URLs, credential-helper output, environment files, or raw command output into GitHub issues.

Common bounded reason codes:

```text
workspace_record_unavailable
workspace_task_mismatch
workspace_owner_mismatch
workspace_repository_mismatch
workspace_directory_missing
workspace_state_not_executable
legacy_task_without_workspace
```

## Cleanup

Cleanup requires a durable `cleanup_requested` state. It must not run for active, held, or ambiguous workspaces.

If cleanup fails:

- preserve the record;
- record a bounded failure reason;
- do not remove the directory with an unrelated recursive-delete command;
- investigate Git worktree registration and filesystem ownership.

## Rollback

Application rollback does not delete caches, workspace records, or worktrees. The previous release must continue to treat these paths as persistent data.

When rolling back to a release that does not execute workspace-bound tasks:

- stop new review/fix dispatch first;
- preserve all active and held workspaces;
- do not manually strip workspace fields from task records;
- use the previous release only after confirming it can read the additive task fields safely.

## Security boundary

- Git administration uses fixed executable and argument arrays without a shell.
- Repository IDs, branches, SHAs, agents, tasks, workspace IDs, and paths are validated.
- Repository cache paths are never execution working directories.
- Verification commands are selected from an explicit approved command set.
- OPS-009 does not add lifecycle start/stop authority, browser mutations, automatic PR creation, or OPS-010 parent/child orchestration.
