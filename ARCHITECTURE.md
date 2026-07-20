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
| Durable workflow-run records | `workflow-run-store.ts` under `OPS_ROOM_WORKFLOW_RUNS_DIR` |
| Workflow-run schema, transition, and event authority | `workflow-run-store.ts` — created, active, terminal transitions validated |
| Workflow-child workspace bindings | `workflow-child-workspace.ts` — one deterministic workspace per workflow child |
| Explicit workflow-child execution contract | `workflow-child-execution.ts` — durable activation, output-SHA verification, terminal deduplication |
| Workspace ownership and lifecycle (workflow children) | OPS-009 workspace records remain authoritative |
| Workflow API read contract | `src/routes/workflow-runs.ts` — authenticated read-only list and detail |

Clearly distinguish:

- **Repository cache** = shared bare Git object and reference cache managed only by the workspace administration layer. It is never an execution working directory or a task-owned writable checkout.
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

Allocation succeeds from `allocating` to `active` or fails to `failed`.
Cleanup progresses from `cleanup_requested` to `cleaning`, then to `released` or `failed`.
`held_for_investigation` may be entered from `active`, `failed`, or `cleanup_requested`.

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
- The task reconciler idempotently reapplies terminal outcome classification after restart. Successful tasks remain `cleanup_requested` until the separate cleanup operation advances the workspace through `cleaning` to `released`.

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

---

## Workflow Architecture

OPS-010 adds one bounded `feature-development` workflow record above the existing OPS-009 task-workspace ownership layer. The workflow layer records durable parent and child state, binds children to deterministic workspaces, and executes one explicit child safely — but does not automatically dispatch stages, invoke provider-specific runners, or mutate GitHub.

### Stage model

```
Professor implementation
        ↓  immutable checkpoint SHA
Tokyo test development
        ↓  immutable test SHA
Professor integration
        ↓  immutable combined SHA
Berlin exact-SHA review
```

The stage graph is fixed. It is not a general workflow engine.

### Stage ownership

| Stage | Owner | Workspace mode | Starting branch |
|---|---|---|---|
| `implementation` | Professor | writable canonical feature branch | canonical feature branch for workflow + iteration |
| `test` | Tokyo | writable deterministic test branch | deterministic Tokyo test branch |
| `integration` | Professor | writable canonical feature branch | same canonical feature branch as implementation (after prior workspace released) |
| `review` | Berlin | detached exact-SHA workspace | none |

### Durable identity

A parent workflow ID is deterministic from the canonical repository identity and a bounded request key. Restart recovery or an identical retry resolves to the same record.

A child ID is deterministic from:

- parent workflow ID;
- iteration number;
- fixed stage name.

Recreating a child with the same immutable fields returns the existing child. A conflicting owner, dependency, iteration, stage, or input SHA fails closed.

### State model

Parent states:

```
planned | active | blocked | completed | needs_human | cancelled
```

Child states:

```
pending | active | completed | failed | cancelled | needs_human
```

### Accepted contracts

1. **One deterministic parent workflow** — a bounded `feature-development` type with one fixed stage graph. Not a general workflow engine.
2. **Deterministic child identities** — child IDs are reproducible from parent ID, iteration, and stage. Re-creation returns the existing record.
3. **Exact 40-character SHA dependencies between stages** — every child input is an immutable full SHA. A downstream child may be created only after its dependency is durably completed. The dependency output SHA must exactly equal the downstream input SHA.
4. **Durable workflow and child state** — records persist under `OPS_ROOM_WORKFLOW_RUNS_DIR`. Workflow directories remain outside immutable release artifacts. Activation and rollback preserve them.
5. **Immutable completed-child evidence** — completing a child is idempotent for the same output SHA. A different output SHA for an already-completed child is rejected. Failed children retain history and increment their attempt when explicitly retried.
6. **Authenticated read-only workflow list and detail APIs** — `GET /api/workflows` and `GET /api/workflows/:workflowId` require dashboard bearer authentication. Output is bounded to workflow and child identifiers, states, policy, ownership, dependency, attempt, timestamps, and immutable SHAs.
7. **Startup reconciliation before HTTP readiness** — the webhook entrypoint reconciles workflow records before importing the HTTP server. Every child left in `active` is treated as interrupted and transitions to `needs_human` with `workflow_child_interrupted` evidence. No child, branch, commit, review, workspace, or external effect is replayed.
8. **Interrupted active execution is never automatically replayed** — startup reconciliation converts interrupted active children to `needs_human`. It never replays provider, Git, or workspace effects.
9. **Workflow-store readiness is included in `/api/health`** — a readable and writable workflow store reports `ok`. An unavailable workflow directory makes readiness false.
10. **One child owns at most one workspace** — workspace ID is deterministic from child ID and owner agent. Workspace mode, repository, branch, requested SHA, and resolved SHA must match the fixed stage plan.
11. **Existing OPS-009 ownership, capacity, branch-conflict, filesystem, and cleanup rules remain authoritative** — workspace allocation, branch-conflict detection, quota, disk safety, Git administration, managed push, and terminal workspace policy are not redefined.
12. **Bounded workspace metadata only** — workflow children store only bounded workspace metadata (workspace ID, mode, repository identity, branch, resolved SHA, lifecycle state, cleanup-request, investigation-hold). Absolute host paths, repository-cache paths, authenticated remotes, credentials, environment values, and raw provider or Git output are excluded from workflow APIs.
13. **No paths, remotes, credentials, environment values, or raw provider output in workflow APIs** — same redaction boundary as existing OPS-009 workspace and task APIs.

### OPS-010E — Explicit child execution behavior

The explicit workflow-child execution contract implemented in OPS-010E is an internal-only service that executes one already-created and already-bound pending child through a validated, lock-serialized, and durably recorded sequence.

#### Required preconditions

- A valid `feature-development` workflow in `planned` or `active` state.
- One child in `pending` state.
- A pre-existing bounded workspace binding on that child.
- An OPS-009 workspace record matching the child task ID, owner agent, repository, mode, branch, requested SHA, resolved SHA, and `active` state.
- A managed workspace directory that passes the existing path and directory checks.
- An explicitly injected stage runner.
- An explicitly injected workspace-HEAD inspector for writable stages.

#### Execution ordering

```
acquire filesystem execution lock
        ↓
re-read workflow and child from durable state (holding lock)
        ↓
validate workflow, child, owner, repository, mode, branch, workspace state, input SHA, resolved SHA
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

The execution lock is derived from workflow and child IDs. It serializes concurrent explicit attempts across processes sharing the workflow data directory. Default stale threshold is six hours. Operators must investigate before removing a stale execution lock.

#### Accepted terminal outcomes

The stage runner may return only:

- `{ outcome: "completed", output_sha: <exact 40-character SHA> }`
- `{ outcome: "needs_human", reason: <bounded reason code> }`

Unknown result shapes and unsafe free-form errors become the bounded reason `workflow_child_runner_failed`.

#### Output SHA verification

For writable stages (`implementation`, `test`, `integration`), the returned `output_sha` must equal the managed workspace HEAD as independently inspected by the injected inspector before completion can be persisted.

For the `review` stage, the returned output SHA must equal the child's immutable `input_sha` — Berlin's detached review cannot claim a new source revision.

Output mismatch, invalid SHA evidence, or missing inspection authority moves the child to `needs_human` and holds the workspace for investigation.

#### Durable terminal behavior

**Successful completion:**

1. Persist child state `completed` and immutable `output_sha`.
2. Request workspace cleanup through the OPS-009 lifecycle authority.
3. If cleanup-request persistence fails after completion, the completion evidence remains authoritative. The child is not rewritten to `needs_human`.

**Needs human or runner failure:**

1. Persist child state `needs_human` with a bounded reason code.
2. Persist parent workflow state `needs_human`.
3. Place the workspace in `held_for_investigation`.
4. Raw exception text from the untrusted runner is never stored.

#### Idempotency and restart behavior

- Completed and `needs_human` children return a deduplicated terminal result without invoking the runner again.
- An already-active child returns `workflow_child_execution_in_progress` and is never replayed.
- Concurrent explicit attempts serialize; after the first completes, the second observes the durable terminal state and skips the runner.
- Startup reconciliation remains authoritative for a process interrupted after activation. It never replays provider or workspace effects.
- Explicit retry remains a separate future operation.

#### Workspace sequencing after success

Successful child execution requests cleanup but does not execute cleanup automatically. The next stage may not bind a branch that remains actively owned by the prior child. For the canonical Professor → Tokyo → Professor → Berlin sequence, a later coordinator must verify the previous workspace has reached `released` before binding a conflicting writable branch.

### Explicit non-goals

OPS-010E does not introduce:

- automatic Professor → Tokyo → Professor → Berlin stage dispatch;
- provider-specific OpenAB or OpenCode stage-runner wiring;
- automatic next-child creation after stage completion;
- automatic iteration creation or advancement;
- Berlin approval versus changes-requested semantics;
- an HTTP workflow mutation endpoint;
- browser workflow controls;
- automatic Git push, PR creation, review posting, merge, or deployment;
- automatic workspace cleanup execution or branch-ownership transfer;
- PostgreSQL authority;
- a general-purpose workflow engine.

### Remaining future work

The next planned slices after OPS-010E:

1. **OPS-010F — Provider-specific stage runner and durable effect fencing:** Professor, Tokyo, and Berlin runtime integration; bounded prompts and outputs; timeouts and cancellation; durable effect claims before Git or GitHub side effects; duplicate-effect prevention; safe output parsing and redaction.
2. **OPS-010G — Deterministic workflow advancement:** implementation → test → integration → review; Berlin approved outcome; Berlin changes-requested outcome; iteration creation and maximum iteration policy; exact-SHA propagation; workflow completion and `needs_human` escalation; workspace cleanup and branch-ownership sequencing.
3. **Later gate:** Controlled end-to-end production workflow drill.

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
10. Add one guarded graceful-start action for Gemini (guarded-start & already-running adoption).
11. OPS-009 workspace foundation and execution integration — complete.
12. OPS-010A parent/child workflow foundation — complete.
13. OPS-010B read and restart contracts — complete.
14. OPS-010C API and health integration — complete.
15. OPS-010D workflow-child workspace binding — complete.
16. OPS-010E explicit child execution contract — complete.
17. Next: provider-specific stage runner and durable effect fencing (OPS-010F).
18. After that: deterministic stage advancement and Berlin review-decision semantics (OPS-010G).
19. Then: controlled end-to-end production workflow drill.

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
