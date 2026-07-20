# Ops Room Architecture

Status: **Accepted — canonical**
Updated: 2026-07-20

This is the single authoritative product and runtime architecture for Ops Room. Obsidian notes and implementation plans are supporting history unless this document links them as an active decision.

## Product Boundary

Ops Room is the control plane around OpenAB-backed agents.

- Ops Room owns agent identity, policy visibility, task routing, workflow supervision, operational state, and deployment identity.
- OpenAB owns chat connections, ACP, sessions, streaming, provider processes, and agent execution.
- GitHub is one task source and workflow integration.
- Obsidian supplies curated durable knowledge, not unrestricted runtime access or raw conversation storage.

Existing GitHub review, fix, lease-fencing, effect-ledger, and reconciliation behavior must remain stable while the control plane evolves.

## Current Goal

Deliver a secure, reliable production control plane with deterministic deployment, audited task operations, Git-backed read-only policy, a runtime-neutral observation boundary, and one tightly guarded lifecycle test action before broader orchestration.

Completion requires:

- CI committed and configured as a required `main` check.
- One normalized runtime definition source exposing desired and observed state.
- One read-only runtime adapter registry separating API consumers from Docker/OpenAB inspection details.
- One versioned agent profile source exposing mission, behavior, exact skill assignments, logical memory assignments, and repository scope.
- One validated versioned skill-manifest source exposing immutable metadata and declared requirements without execution authority.
- One validated memory-space source exposing curated publication paths, ownership, write-review policy, and provenance requirements without vault I/O authority.
- One authenticated, audited, and idempotent contract for cancel, retry, pause, and resume task actions.
- One feature-flagged, allowlisted, confirmed, audited, idempotent graceful-stop action for one canonical non-critical test agent.
- No whole-vault agent mounts; only curated read-only knowledge mounts.
- Loopback-by-default API binding or an equivalently verified network/auth boundary.
- Health output containing deployed commit SHA, process lifecycle state, profile, skill-registry, memory-registry, lifecycle-store, and critical local dependency status.
- Immutable, commit-addressed host-systemd releases containing no secrets or runtime data.
- Tested manual activation and rollback.
- SIGTERM stops intake, drains tracked work within a bound, and leaves durable review/fix work recoverable.

## Sources of Truth

| Concern | Authority now |
|---|---|
| Agent runtime definitions, roles, bindings, and guarded lifecycle eligibility | `ops-room/src/services/agent-definitions.ts` |
| Runtime preparation and observed-state normalization | `ops-room/src/services/runtime-adapter/*` |
| Guarded external lifecycle command boundary | `ops-room/src/services/runtime-lifecycle/*` |
| Durable desired lifecycle state and operation evidence | Persistent lifecycle records under `data/ops-room/lifecycle/` |
| Agent mission, personality, exact skill assignments, logical memory assignments, and repository scope | `config/agent-profiles/*.json` |
| Immutable skill metadata and declared requirements | `config/skills/<key>/<version>/manifest.json` |
| Curated memory-space metadata and governance | `config/memory-spaces/<key>/<version>/manifest.json` |
| OpenAB agent configuration | Git-managed `config/agents/*.toml` deployed outside release artifacts |
| Task, effect, lease, audit, and idempotency state | Persistent paths under `data/ops-room/` |
| Release identity | `RELEASE.json` plus external SHA-256 checksum |
| Secrets | Protected environment/secret files outside Git and release directories |
| Shared bare repository caches | `repository-cache.ts` under `OPS_ROOM_REPOSITORY_CACHE_ROOT` |
| Isolated task worktrees | `workspace-manager.ts` under `OPS_ROOM_TASK_WORKSPACE_ROOT` |
| Durable workspace records | `workspace-store.ts` under `OPS_ROOM_WORKSPACE_RECORDS_DIR` |
| Task-to-workspace bindings | Additive bounded fields on review and fix task records |
| Workspace cleanup and investigation-hold state | Durable workspace record state under `OPS_ROOM_WORKSPACE_RECORDS_DIR` |

Clearly distinguish:

- **Repository cache** = shared read-only Git object storage. Never an execution working directory.
- **Task workspace** = isolated execution directory owned by one task.
- **Workspace record** = durable ownership and lifecycle evidence.

PostgreSQL is not currently authoritative. Introducing it requires a separate migration decision with dual-read/cutover/rollback semantics that preserve existing lease and effect guarantees.

## Security Boundary

- Host deployment binds `127.0.0.1` by default. Public access must pass through the verified Cloudflare Tunnel and Access boundary or equivalent authenticated ingress.
- Container deployment may bind `0.0.0.0` internally only when the published host port remains loopback-bound.
- Operator mutation APIs are disabled by default and use a credential separate from webhook ingress and dashboard access when enabled.
- Authentication, operator identity, audit records, idempotency, confirmation, and authorization must precede control-plane mutations.
- Agent lifecycle mutations additionally require a separate disabled-by-default feature flag, an environment allowlist, and canonical per-agent eligibility.
- Agent knowledge is mounted from `OPENAB_AGENT_KNOWLEDGE_DIR` read-only. This directory must be a curated publication target, never the whole Obsidian vault.
- Agent profiles, skill manifests, and memory-space manifests contain policy metadata only. They must not contain tokens, private keys, provider credentials, prompts, secret values, unrestricted filesystem paths, or note contents.
- Skill compatibility is an inspection result, not proof that a skill is installed, materialized, or executable.
- A memory write assignment is future policy intent only. OPS-005 does not grant filesystem write access, browse notes, perform search, sync Obsidian, or publish content.
- Browser mutation controls remain deferred until stable browser identity, RBAC, session revocation, and confirmation rules are approved.
- Runtime adapters perform bounded read-only inspection only. They must not expose raw command output, secrets, host environment values, or lifecycle mutation methods.
- Runtime lifecycle controllers are separate from read adapters. The current controller exposes only one fixed-form bounded graceful stop operation for an approved test target; it does not expose a shell, raw Docker output, start, restart, kill, force stop, recreate, or general Docker authority.

## Agent Model

An agent is a logical identity independent from its current container.

`agent-definitions.ts` owns operational bindings:

- baseline desired state, which remains `unmanaged` until a successful guarded lifecycle operation creates durable desired-state evidence;
- runtime backend, service, container target, config, data binding, and polling intent;
- stable identity used by the runtime adapter registry;
- canonical lifecycle eligibility, which is disabled for production workflow agents and currently permits only Gemini as the guarded-stop test target.

`config/agent-profiles/*.json` owns versioned policy metadata:

- mission and communication style;
- decision policies and constraints;
- exact immutable skill key/version assignments;
- logical memory-space read/write assignments;
- allowed repositories;
- enabled state and profile version.

Profiles are validated before the HTTP server starts. A missing, malformed, unsupported, duplicate, or runtime-inconsistent profile blocks startup. Runtime bindings remain authoritative in `agent-definitions.ts`; profiles may reference but must not redefine container or service wiring.

Observed state is produced by the read-only runtime adapter registry. It is evidence about the current runtime, not desired-state authority and not permission to mutate a provider process.

Durable lifecycle records expose desired state and operation phase separately from observed state. A desired `stopped` value does not prove that a container stopped, and an observed `running` value does not itself authorize a stop.

Hardcoded workflow names may assign current roles, but future routing should select by capability and policy rather than treating a personified name as a capability.

## Skill Model

`config/skills/<key>/<version>/manifest.json` is the only approved skill-manifest root. Each manifest declares:

- schema version, stable key, immutable semantic version, and description;
- supported runtime backends;
- normalized command requirements that Ops Room already knows how to inspect safely;
- logical credential reference names;
- action-permission categories from an explicit allowlist.

The skill registry initializes after profiles and before the HTTP server accepts requests. It loads manifests once, rejects malformed or unsafe structure, and resolves each profile assignment to the exact declared version. It never downloads manifests, scans arbitrary repository JSON, follows external symlinks, executes manifest-provided commands, reads secret values, or writes provider skill directories.

Structural corruption blocks startup and registry readiness. Runtime mismatch, missing commands, missing credential references, and unavailable inspection data are compatibility results (`compatible`, `incompatible`, or `unknown`) and do not redefine the profile runtime backend. Compatibility alone does not make a skill installed or executable.

## Memory Governance Model

`config/memory-spaces/<key>/<version>/manifest.json` is the only approved memory-space manifest root. Profiles assign stable logical keys rather than raw vault paths.

Each manifest declares:

- schema version, stable key, immutable semantic version, display name, and description;
- one kind: `project`, `shared`, `private-agent`, or `archive`;
- one normalized relative publication path under an approved root;
- optional parent space for explicitly governed nested scopes;
- owner identity for private-agent spaces;
- a `read-only` or `review-required` write policy;
- provenance fields and whether future publication requires review.

Approved publication roots are:

```text
20_Projects/   project knowledge
90_Shared/     approved cross-agent knowledge
90_Agents/     private agent knowledge
99_Archive/    read-only historical knowledge
```

The memory-space registry initializes after profiles and skills and before the HTTP server accepts requests. It loads manifests once and validates every profile assignment. Startup fails for malformed JSON, unsupported structure, symlinks, unsafe or overlapping paths, unresolved parents, missing spaces, foreign private-space access, writes to read-only spaces, or write assignments without matching read access.

Public APIs expose only logical keys, versions, display metadata, relative publication paths, governance policy, provenance requirements, and reader/writer agent IDs. They do not expose manifest source paths, absolute host paths, note contents, Obsidian configuration, or runtime mount paths.

`review-required` describes the contract a future governed publisher must satisfy. No automated write, publication, sync, note creation, memory search, vector retrieval, or vault inspection is introduced by this registry.

## Controlled Task Operations

Review and fix task mutations use one operator contract for `cancel`, `retry`, `pause`, and `resume`.

- Canonical routes are `POST /api/operator/tasks/:taskId/<action>`.
- The mutation API remains disabled by default and requires a separate operator bearer credential and resolvable stable actor identity.
- Every request requires a bounded human reason and client-generated idempotency key.
- Accepted and rejected attempts append audit events containing actor, operation, target, previous/resulting state, outcome, and safe metadata.
- Idempotency records persist the original completed response and prevent duplicate state transitions under retries.
- Different-key requests for the same task are serialized in the running process; only one valid competing transition may succeed.
- `pause` applies only to queued work. Running work uses cancellation rather than pretending execution has paused.
- `retry` applies only to terminal recoverable states and respects a finite task retry budget when configured.
- Review tasks return to `QUEUED`; fix tasks return to `FIX_QUEUED`.
- Retry and resume request dispatch only after task state and audit evidence are durable. Reconciliation, lease fencing, and the effect ledger remain authoritative for preventing duplicate external side effects.
- Compatibility aliases under `/api/review-tasks/:taskId/<action>` use the same contract; they do not bypass audit or idempotency.

These task actions do not provide agent process start/stop/restart, unrestricted workflow execution, browser controls, or Docker mutation.

## Task Workspace Ownership Model

OPS-009 gives every new executable review or fix task one durable isolated Git worktree backed by a shared bare repository cache.

### Cardinality

- Every new executable task owns exactly one durable workspace.
- One workspace belongs to exactly one task.
- One workspace has one owner agent.
- One workspace belongs to one canonical repository identity.
- Retries and restart recovery reuse the same workspace.
- A second workspace must not be allocated when a valid binding already exists.
- Ownership or repository mismatches fail closed.

### Workspace data model

Each bound task carries:

```text
Task
 ├── workspace_id
 ├── owner agent
 ├── repository identity
 ├── workspace mode (branch | detached)
 ├── branch (writable mode only)
 └── workspace lifecycle state
```

### Writable branch workspace

Implementation and fix tasks use writable branch worktrees.

- The task has exclusive ownership of the repository branch while active.
- Another active task attempting to own the same writable branch is rejected before worktree creation.
- File edits, approved verification commands, commits, and pushes execute from the managed worktree.
- Execution never happens from the shared bare cache.
- Writable dependencies, generated files, or uncommitted changes are never shared with another task.

### Detached exact-SHA workspace

Review tasks use detached worktrees.

- The workspace requires an exact immutable 40-character commit SHA before allocation.
- Workspace HEAD must equal the recorded reviewed SHA before any review effect is posted.
- Review tasks do not mutate the reviewed branch.
- Separate review workspaces may inspect the same SHA without sharing a writable checkout.
- Berlin reviews the recorded immutable SHA.

### Durable binding metadata

The following bounded metadata is persisted on a task and its workspace record:

- workspace ID;
- mode (branch | detached);
- repository ID;
- branch (writable mode only);
- resolved SHA;
- workspace lifecycle state;
- cleanup-request status;
- investigation-hold status.

**Public APIs and task serialization must not expose:**

- absolute host paths;
- repository cache paths;
- authenticated remotes;
- credentials or tokens;
- environment values;
- raw Git errors or command output.

### Workspace lifecycle states

```text
allocating
    ↓
 active
    ↓
 cleanup_requested
    ↓
 cleaning
    ↓
 released
```

`failed` is reachable from `allocating`, `active`, and `cleanup_requested`. `held_for_investigation` is reachable from `active`, `failed`, and `cleanup_requested`.

| State | Meaning |
|---|---|
| `allocating` | Worktree creation or cache fetch in progress |
| `active` | Worktree is usable and bound to an executable task |
| `cleanup_requested` | Terminal success recorded; cleanup is pending |
| `cleaning` | Worktree removal or record finalization in progress |
| `released` | Worktree successfully removed; record retained for audit |
| `failed` | Allocation or cleanup failed with a bounded reason |
| `held_for_investigation` | Workspace preserved after a terminal failure outcome |

### Terminal-task workspace policy

- `PASSED` and `FIX_PUSHED` request cleanup only after the terminal task transition is durable.
- `ERROR`, `NEEDS_HUMAN`, `CANCELLED`, `CANCEL_REQUESTED`, and `SUPERSEDED` preserve the workspace for investigation.
- Cleanup and hold transitions are idempotent.
- Active, queued, or investigation-held workspaces cannot be deleted automatically.
- Cleanup is not complete merely because cleanup was requested — the workspace record must transition through `cleaning` to `released`.
- The workspace reconciler applies terminal outcomes at startup and on its recurring cycle to recover from interrupted cleanup requests.

### Restart recovery

Restart reconciliation:

1. Reads the task workspace ID from the durable task.
2. Reads the durable workspace record.
3. Validates task ID, owner agent, and repository identity.
4. Validates that the relative path remains below the configured workspace root.
5. Verifies the worktree directory exists.
6. Verifies that the workspace lifecycle state is executable (`active` or `held_for_investigation`).
7. Reconnects the task without allocating a duplicate workspace.

**Fail-closed handling:**

| Condition | Behaviour |
|---|---|
| Missing workspace record | Blocked — `workspace_record_unavailable` |
| Task ID mismatch | Blocked — `workspace_task_mismatch` |
| Agent owner mismatch | Blocked — `workspace_owner_mismatch` |
| Repository identity mismatch | Blocked — `workspace_repository_mismatch` |
| Worktree directory missing or path escape | Blocked — `workspace_directory_missing` |
| Stale or ambiguous workspace state | Blocked — `workspace_state_not_executable` |
| Incompatible lifecycle state | Blocked — `workspace_state_not_executable` |

**Legacy unbound tasks:** Active tasks without workspace metadata remain readable and are classified as `legacy_unbound`. They are not silently migrated while running.

### Persistence and release separation

Repository caches, worktrees, workspace records, and workspace locks are persistent runtime data. They live outside immutable release directories.

Immutable release artifacts exclude:

- repository caches (`OPS_ROOM_REPOSITORY_CACHE_ROOT`);
- task workspaces (`OPS_ROOM_TASK_WORKSPACE_ROOT`);
- workspace records (`OPS_ROOM_WORKSPACE_RECORDS_DIR`);
- workspace locks (`OPS_ROOM_WORKSPACE_LOCK_DIR`);
- task-generated dependencies and build output.

Application rollback must not delete or recreate these persistent paths.

### Security and capacity controls

- Git administration and managed push operations use fixed executable and argument arrays — never a shell.
- Repository IDs, branches, SHAs, agent IDs, task IDs, workspace IDs, and relative paths are validated against safe patterns.
- Filesystem locking (`withWorkspaceLock`) guards cache fetch and worktree administration.
- Exclusive writable branch ownership prevents concurrent branch mutation.
- Maximum-active-workspace admission control (`OPS_ROOM_WORKSPACE_MAX_ACTIVE`) caps concurrent allocations.
- Minimum-free-disk admission control (`OPS_ROOM_WORKSPACE_MIN_FREE_BYTES`) prevents allocation below a threshold.
- Verification commands are selected from an explicit approved set.
- Errors are normalized; raw Git output, credentials, and authenticated remotes are never returned.

### OPS-010 boundary

OPS-009 provides workspace isolation and ownership only. It does not introduce:

- parent and child workflow runs;
- automatic Professor → Tokyo → Berlin handoffs;
- a general workflow engine;
- automatic pull request creation or merge;
- browser workspace mutation;
- lifecycle start or stop coupling;
- PostgreSQL authority.

OPS-010 may consume OPS-009 workspaces, but it must not redefine workspace ownership or bypass exact-SHA and writable-branch rules.

## Runtime Adapter Read Model

`ops-room/src/services/runtime-adapter/` is the only approved control-plane boundary for runtime preparation and observed-state inspection.

The contract separates:

- `prepare` — a deterministic, side-effect-free conversion from an agent definition to a provider-neutral prepared runtime target;
- `inspect` — bounded read-only observation returning normalized status and adapter availability diagnostics;
- registry selection — exactly one adapter must support each canonical agent definition;
- API consumption — agent and instance services consume normalized snapshots rather than Docker/OpenAB command details.

The current `openab-docker` adapter supports both OpenAB/OpenCode and OpenAB/Gemini because both are observed through the same named-container mechanism. Docker CLI reads are isolated in `docker-read-inspector.ts`. Other API, registry, dashboard, and lifecycle services must not duplicate provider-specific observation commands.

Adapter failures degrade to bounded `unknown` runtime status and a safe adapter diagnostic. Raw stdout/stderr, environment values, credentials, absolute provider paths, and Docker socket details are not returned.

Existing `/api/agents` and `/api/openab/instances` response fields remain compatible. Additive runtime-adapter identifiers make the observation source visible without granting lifecycle authority.

The read adapter interface still exposes no start, stop, restart, kill, recreate, provider-session, desired-state reconciliation, or Docker mutation method. OPS-008 consumes the prepared target through a separate, narrower lifecycle-controller boundary.

## Guarded Agent Lifecycle — First Slice

OPS-008 begins with one reversible vertical slice rather than a general lifecycle engine.

### Endpoint and eligibility

```text
POST /api/operator/agents/:agentId/stop
```

The endpoint is available only when the existing operator API and the separate lifecycle feature flag are both enabled. The target must be explicitly present in the environment allowlist and marked `guarded-stop-test` in the canonical agent definition. Gemini is the only current eligible target. Professor, Berlin, and Tokyo remain lifecycle-disabled.

Every request requires:

- authenticated stable operator identity;
- bounded human reason;
- client-generated idempotency key;
- `confirm_agent_id` exactly matching the path target.

Accepted and rejected requests use the stable audit operation `agent.stop`.

### State model

Durable per-agent records under the lifecycle store separate desired state and operation phase from read-only runtime observation.

Current phases are:

```text
unmanaged → draining → stopping → stopped
                  ↘ failed ↗

unmanaged → starting → running
                  ↘ failed ↗
```

`starting` and `running` phases were added alongside the guarded-start endpoint (OPS-008B). `failed` records a bounded failure or interrupted operation. The `running` terminal phase indicates durable convergence, while `starting` blocks task dispatch until the convergence watch completes.

### Start endpoint and eligibility

```text
POST /api/operator/agents/:agentId/start
```

Same eligibility rules as stop: requires operator API + lifecycle feature flag, allowlist presence, and `guarded-test` lifecycle control in agent definitions. Gemini is the only current eligible target.

Every request requires the same preconditions as stop:

- authenticated stable operator identity;
- bounded human reason;
- client-generated idempotency key;
- `confirm_agent_id` exactly matching the path target.

Accepted and rejected requests use the stable audit operation `agent.start`.

### Drain and dispatch rules

- Persist `desired_state=stopped` and `phase=draining` before checking active work.
- Once draining or stopped, the durable review/fix dispatcher fails closed for the target agent.
- Check dispatch permission before and after acquiring the task concurrency lock to prevent a late claim race.
- Wait only for bounded durable active states: `CLAIMED`, `RUNNING`, `FIXING`, and `CANCEL_REQUESTED`.
- Do not cancel, kill, or force active work.
- On timeout or corrupt task evidence, reject the stop, restore the previous desired state, and record `failed`.
- The first slice is restricted to Gemini because legacy polling work for the production workflow agents is not yet fully represented by this drain contract.

### Runtime mutation boundary

After drain succeeds, the selected lifecycle controller may execute only:

```text
docker stop --time <bounded-seconds> <validated-container-name>
```

The command uses a fixed executable and argument array without a shell. Container names and timeout values are bounded. Stdout and stderr are suppressed. Errors returned to APIs and audit records are normalized and do not expose provider or host details.

If read-only observation already reports an exited, dead, missing, or stopped runtime, the action completes as an audited no-op without executing Docker.

### Restart recovery and concurrency

Lifecycle mutations are serialized globally in the current process, limiting the 2 CPU / 8 GB host to one heavy runtime action at a time.

Startup does not replay an interrupted external command. Records left in `draining` or `stopping` are converted to `failed` with bounded interruption evidence. Records left in `starting` also convert to `failed`, preserving `desired_state=running`. Operators must inspect desired and observed state before any manual recovery.

### Guarded start flow (OPS-008B)

The start handler uses strict observation allowlisting before executing any command:

| Observation | Classification | Action |
|---|---|---|
| `running` + health `healthy` or `none` | Adoptable | Audited no-op adoption, zero commands |
| `running` + health `starting` | Unapproved | Rejected with `runtime_observation_unexpected` |
| `running` + health `unhealthy` | Unapproved | Rejected with `runtime_observation_unexpected` |
| `exited`, `dead`, `stopped` | Startable | Guarded start: `docker start <container>` |
| `unknown`, `unavailable`, `missing` | Non-observable | Rejected with `runtime_observation_<status>` |
| `created`, `paused`, `restarting`, `removing` | Non-approved | Rejected with `runtime_observation_unexpected` |

**Approved health states** are `healthy` and `none` (no health check configured). All other health values (`starting`, `unhealthy`, `unknown`) prevent adoption.

#### Adoption path (already running)

When `desired_state=running` + `phase=running` + observed is running with approved health, the handler records an audited no-op with `command_executed=false` and returns the current convergence status. No Docker command is executed.

#### OPS-008A mismatch resolution

When `desired_state=stopped` + `phase=stopped` + observed is running with approved health, the handler transitions the record to `desired_state=running` + `phase=running` without executing any command. This absorbs containers that were manually started after a stop.

#### Recovery path (durable running, observed startable)

When `desired_state=running` + `phase=running` + observed is a startable state (exited, dead, stopped), the handler enters the guarded-start path rather than rejecting. This allows recovery of a previously converged container that later exited.

#### Guarded start with convergence watch

For startable observations:

1. Persist `desired_state=running` + `phase=starting` (blocks task dispatch).
2. Execute `docker start <container>` via the lifecycle controller (fixed args, no shell).
3. Poll convergence for up to `OPS_ROOM_AGENT_LIFECYCLE_START_TIMEOUT_SECONDS` (default 30s, minimum 1s).
4. Convergence requires running status **and** approved health. `running` + `unhealthy` fails fast with `runtime_start_convergence_unhealthy`.
5. On timeout, persist `phase=failed` with `last_error=runtime_start_convergence_timeout` (or `unhealthy`), append failed audit event, return HTTP 504.
6. On convergence, persist `phase=running`, append accepted audit event, return HTTP 202.

#### Cache-bypass for convergence polling

The `freshRuntimeSnapshot` parameter allows the production harness to inject an uncached inspection function for convergence polling. When set, the convergence loop uses this fresh view instead of the potentially stale cached `getRuntimeSnapshot`. This prevents false convergence timeouts when the Docker inspector cache TTL (5s) exceeds the configured start timeout.

#### Start-time timeout minimum

`OPS_ROOM_AGENT_LIFECYCLE_START_TIMEOUT_SECONDS` enforces a minimum of 1 second. Operators configuring this below the established Docker inspector cache TTL should also provide a fresh inspection path to avoid false negative convergence.

### Runtime mutation boundary

After drain succeeds, the selected lifecycle controller may execute only:

```text
docker stop --time <bounded-seconds> <validated-container-name>
```

For start, the controller executes only:

```text
docker start <validated-container-name>
```

Both commands use a fixed executable and argument array without a shell. Container names and timeout values are bounded. Stdout and stderr are suppressed. Errors returned to APIs and audit records are normalized and do not expose provider or host details.

### Explicit boundary retained

This slice adds no restart, kill, force stop, recreate, automatic reconciliation, arbitrary Docker command execution, Docker socket exposure, browser lifecycle control, RBAC, automatic idle stop, provider session creation, or production-agent lifecycle authority (Professor, Berlin, Tokyo remain lifecycle-disabled).

Disabling the lifecycle endpoint does not restart a stopped agent. Recovery uses the explicitly confirmed start endpoint when the lifecycle feature flag is re-enabled.

## Runtime and Shutdown

Production topology is host systemd for Ops Room plus Docker-hosted OpenAB agents.

On SIGTERM/SIGINT, Ops Room:

1. marks the Ops Room process lifecycle `draining` and rejects new mutation ingress;
2. aborts issue-poller sleep/intake;
3. stops reconciliation scheduling and closes the HTTP listener;
4. waits for tracked review/fix/poller operations up to `OPS_ROOM_SHUTDOWN_TIMEOUT_MS`;
5. exits non-zero on timeout so systemd and startup reconciliation can recover durable work;
6. removes dead legacy issue locks during next startup;
7. converts interrupted agent lifecycle `draining` or `stopping` records to `failed` on the next start rather than replaying runtime commands. `starting` records also convert to `failed`, preserving `desired_state=running`.

Legacy issue coding/chat work does not yet have the full durable effect ledger used by review/fix tasks. Production deployment must not force restart while such work remains active. This limitation is also why the first lifecycle target is restricted to non-polling Gemini.

## Deployment Contract

Production releases are immutable archives identified by a full Git commit SHA.

Allowed artifact contents:

```text
RELEASE.json
config/agent-profiles/*.json
config/skills/<key>/<version>/manifest.json
config/memory-spaces/<key>/<version>/manifest.json
ops-room/package.json
ops-room/src/**
ops-room/dist/dashboard/**
```

Forbidden: `.env`, secrets, `data/`, logs, workspaces, lifecycle records, audit/idempotency records, tests, source dashboard, non-JSON profile files, non-manifest registry files, provider homes, symlinks, and `node_modules`.

Repository caches, task workspaces, workspace records, and workspace locks are persistent runtime data that must never be included in release archives. Rollback must not delete or recreate these persistent paths.

The release builder validates the exact approved skill and memory-space manifest sets before copying them. The archive checksum is external; `RELEASE.json` never self-hashes its containing archive. Manual activation verifies the allowlist, checksum, manifest SHA, fixed release path, systemd restart, profile/skill/memory registry validation, lifecycle-store readiness, and SHA-aware readiness. Failure restores the previous symlink and verifies previous-release health.

Production layout:

```text
/opt/ops-room/
├── bin/node                 # stable host-managed Node.js 20+ binding
├── releases/<sha>/
├── current -> releases/<sha>
├── previous -> releases/<sha>
├── locks/deploy.lock
└── scripts/                  # root-owned activation/rollback authority

/etc/openab/ops-room.env      # stable absolute config/data/secret references
```

Automatic deployment remains deferred until manual activation, active-work drain, failed-readiness rollback, and previous-release health are proven on the VPS.

## Delivery Order

1. Secure read-only foundation and deterministic manual deployment.
2. Verify several manual releases and rollback drills.
3. Add one audited, idempotent operator mutation.
4. Add Git-backed agent profiles and read-only policy visibility.
5. Add the Git-backed read-only skill registry and compatibility inspection.
6. Add Git-backed curated memory governance without vault I/O.
7. Expand the proven mutation contract to audited retry, pause, and resume task actions.
8. Introduce a runtime adapter read model.
9. Add one guarded graceful-stop action for a non-critical test agent.
| 10. Add one guarded graceful-start action for Gemini (guarded-start & already-running adoption).
| 11. OPS-009 workspace foundation and execution integration — complete. OPS-010 collaboration workflow — next.

## Explicit Non-Goals Now

- PostgreSQL migration
- profile, skill-manifest, or memory-manifest editing
- skill execution, installation, activation, or provider materialization
- credential creation, storage, rotation, or value display
- Obsidian note browsing, search, synchronization, publication, or writes
- browser mutation controls before authentication and RBAC
- agent force restart, kill, force stop, recreate, or unrestricted Docker control
- lifecycle control for Professor, Berlin, or Tokyo
- automatic desired-state reconciliation or idle shutdown
- general workflow engine
- full memory service or vector database
- multi-tenancy
- automatic production deployment
