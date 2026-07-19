# Ops Room Architecture

Status: **Accepted — canonical**
Updated: 2026-07-19

This is the single authoritative product and runtime architecture for Ops Room. Obsidian notes and implementation plans are supporting history unless this document links them as an active decision.

## Product Boundary

Ops Room is the control plane around OpenAB-backed agents.

- Ops Room owns agent identity, policy visibility, task routing, workflow supervision, operational state, and deployment identity.
- OpenAB owns chat connections, ACP, sessions, streaming, provider processes, and agent execution.
- GitHub is one task source and workflow integration.
- Obsidian supplies curated durable knowledge, not unrestricted runtime access or raw conversation storage.

Existing GitHub review, fix, lease-fencing, effect-ledger, and reconciliation behavior must remain stable while the control plane evolves.

## Current Goal

Deliver a secure, reliable production control plane with deterministic deployment, audited mutations, and Git-backed read-only agent, skill, and memory policy before adding lifecycle or configuration editing.

Completion requires:

- CI committed and configured as a required `main` check.
- One normalized runtime definition source exposing desired and observed state.
- One versioned agent profile source exposing mission, behavior, exact skill assignments, logical memory assignments, and repository scope.
- One validated versioned skill-manifest source exposing immutable metadata and declared requirements without execution authority.
- One validated memory-space source exposing curated publication paths, ownership, write-review policy, and provenance requirements without vault I/O authority.
- No whole-vault agent mounts; only curated read-only knowledge mounts.
- Loopback-by-default API binding or an equivalently verified network/auth boundary.
- Health output containing deployed commit SHA, lifecycle state, profile, skill-registry, memory-registry, and critical local dependency status.
- Immutable, commit-addressed host-systemd releases containing no secrets or runtime data.
- Tested manual activation and rollback.
- SIGTERM stops intake, drains tracked work within a bound, and leaves durable review/fix work recoverable.

## Sources of Truth

| Concern | Authority now |
|---|---|
| Agent runtime definitions, roles, and bindings | `ops-room/src/services/agent-definitions.ts` |
| Agent mission, personality, exact skill assignments, logical memory assignments, and repository scope | `config/agent-profiles/*.json` |
| Immutable skill metadata and declared requirements | `config/skills/<key>/<version>/manifest.json` |
| Curated memory-space metadata and governance | `config/memory-spaces/<key>/<version>/manifest.json` |
| OpenAB agent configuration | Git-managed `config/agents/*.toml` deployed outside release artifacts |
| Task, effect, lease, audit, and idempotency state | Persistent paths under `data/ops-room/` |
| Runtime and command observation | Docker/OpenAB and bounded health inspection |
| Release identity | `RELEASE.json` plus external SHA-256 checksum |
| Secrets | Protected environment/secret files outside Git and release directories |

PostgreSQL is not currently authoritative. Introducing it requires a separate migration decision with dual-read/cutover/rollback semantics that preserve existing lease and effect guarantees.

## Security Boundary

- Host deployment binds `127.0.0.1` by default. Public access must pass through the verified Cloudflare Tunnel and Access boundary or equivalent authenticated ingress.
- Container deployment may bind `0.0.0.0` internally only when the published host port remains loopback-bound.
- Operator mutation APIs are disabled by default and use a credential separate from webhook ingress when enabled.
- Authentication, operator identity, RBAC, audit records, confirmation, idempotency, and secret references must precede new control-plane mutations.
- Agent knowledge is mounted from `OPENAB_AGENT_KNOWLEDGE_DIR` read-only. This directory must be a curated publication target, never the whole Obsidian vault.
- Agent profiles, skill manifests, and memory-space manifests contain policy metadata only. They must not contain tokens, private keys, provider credentials, prompts, secret values, unrestricted filesystem paths, or note contents.
- Skill compatibility is an inspection result, not proof that a skill is installed, materialized, or executable.
- A memory write assignment is future policy intent only. OPS-005 does not grant filesystem write access, browse notes, perform search, sync Obsidian, or publish content.

## Agent Model

An agent is a logical identity independent from its current container.

`agent-definitions.ts` owns operational bindings:

- desired state: currently `unmanaged` until an audited lifecycle controller exists;
- observed state: current Docker/OpenAB runtime inspection;
- role, backend, service, container, config, data binding, and polling intent.

`config/agent-profiles/*.json` owns versioned policy metadata:

- mission and communication style;
- decision policies and constraints;
- exact immutable skill key/version assignments;
- logical memory-space read/write assignments;
- allowed repositories;
- enabled state and profile version.

Profiles are validated before the HTTP server starts. A missing, malformed, unsupported, duplicate, or runtime-inconsistent profile blocks startup. Runtime bindings remain authoritative in `agent-definitions.ts`; profiles may reference but must not redefine container or service wiring.

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

## Runtime and Shutdown

Production topology is host systemd for Ops Room plus Docker-hosted OpenAB agents.

On SIGTERM/SIGINT, Ops Room:

1. marks lifecycle `draining` and rejects new mutation ingress;
2. aborts issue-poller sleep/intake;
3. stops reconciliation scheduling and closes the HTTP listener;
4. waits for tracked review/fix/poller operations up to `OPS_ROOM_SHUTDOWN_TIMEOUT_MS`;
5. exits non-zero on timeout so systemd and startup reconciliation can recover durable work;
6. removes dead legacy issue locks during next startup.

Legacy issue coding/chat work does not yet have the full durable effect ledger used by review/fix tasks. Production deployment must not force restart while such work remains active.

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

Forbidden: `.env`, secrets, `data/`, logs, workspaces, tests, source dashboard, non-JSON profile files, non-manifest registry files, provider homes, symlinks, and `node_modules`.

The release builder validates the exact approved skill and memory-space manifest sets before copying them. The archive checksum is external; `RELEASE.json` never self-hashes its containing archive. Manual activation verifies the allowlist, checksum, manifest SHA, fixed release path, systemd restart, profile/skill/memory registry validation, and SHA-aware readiness. Failure restores the previous symlink and verifies previous-release health.

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
7. Introduce a runtime adapter read model.
8. Consider guarded lifecycle control and database-backed operational indexing only after demonstrated need.

## Explicit Non-Goals Now

- PostgreSQL migration
- profile, skill-manifest, or memory-manifest editing
- skill execution, installation, activation, or provider materialization
- credential creation, storage, rotation, or value display
- Obsidian note browsing, search, synchronization, publication, or writes
- general workflow engine
- full memory service or vector database
- dynamic unrestricted Docker control
- multi-tenancy
- automatic production deployment
