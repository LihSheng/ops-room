# Ops Room Architecture

Status: **Accepted — canonical**
Updated: 2026-07-17

This is the single authoritative product and runtime architecture for Ops Room. Obsidian notes and implementation plans are supporting history unless this document links them as an active decision.

## Product Boundary

Ops Room is the control plane around OpenAB-backed agents.

- Ops Room owns agent identity, policy visibility, task routing, workflow supervision, operational state, and deployment identity.
- OpenAB owns chat connections, ACP, sessions, streaming, provider processes, and agent execution.
- GitHub is one task source and workflow integration.
- Obsidian supplies curated durable knowledge, not unrestricted runtime access or raw conversation storage.

Existing GitHub review, fix, lease-fencing, effect-ledger, and reconciliation behavior must remain stable while the control plane evolves.

## Current Goal

Deliver a secure, reliable, read-only production control plane with deterministic manual deployment before adding lifecycle or configuration mutations.

Completion requires:

- CI committed and configured as a required `main` check.
- One normalized agent definition source exposing desired and observed state.
- No whole-vault agent mounts; only curated read-only knowledge mounts.
- Loopback-by-default API binding or an equivalently verified network/auth boundary.
- Health output containing deployed commit SHA, lifecycle state, and critical local dependency status.
- Immutable, commit-addressed host-systemd releases containing no secrets or runtime data.
- Tested manual activation and rollback.
- SIGTERM stops intake, drains tracked work within a bound, and leaves durable review/fix work recoverable.

## Sources of Truth

| Concern | Authority now |
|---|---|
| Agent definitions, roles, runtime bindings | `ops-room/src/services/agent-definitions.ts` |
| OpenAB agent configuration | Git-managed `config/agents/*.toml` deployed outside release artifacts |
| Personality and skill packages | Git/filesystem; database migration deferred |
| Task, effect, lease, and audit-like workflow state | Persistent paths under `data/ops-room/` |
| Runtime observation | Docker/OpenAB inspection |
| Release identity | `RELEASE.json` plus external SHA-256 checksum |
| Secrets | Protected environment/secret files outside Git and release directories |

PostgreSQL is not currently authoritative. Introducing it requires a separate migration decision with dual-read/cutover/rollback semantics that preserve existing lease and effect guarantees.

## Security Boundary

- Host deployment binds `127.0.0.1` by default. Public access must pass through the verified Cloudflare Tunnel and Access boundary or equivalent authenticated ingress.
- Container deployment may bind `0.0.0.0` internally only when the published host port remains loopback-bound.
- Operator mutation APIs are disabled by default and use a credential separate from webhook ingress when enabled.
- Authentication, operator identity, RBAC, audit records, confirmation, idempotency, and secret references must precede new control-plane mutations.
- Agent knowledge is mounted from `OPENAB_AGENT_KNOWLEDGE_DIR` read-only. This directory must be a curated publication target, never the whole Obsidian vault.

## Agent Model

An agent is a logical identity independent from its current container. The registry exposes:

- desired state: currently `unmanaged` until an audited lifecycle controller exists;
- observed state: current Docker/OpenAB runtime inspection;
- role, backend, service, container, config, data binding, and polling intent.

Hardcoded workflow names may assign current roles, but future routing should select by capability and policy rather than treating a personified name as a capability.

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
ops-room/package.json
ops-room/src/**
ops-room/dist/dashboard/**
```

Forbidden: `.env`, secrets, `data/`, logs, workspaces, tests, source dashboard, and `node_modules`.

The archive checksum is external; `RELEASE.json` never self-hashes its containing archive. Manual activation verifies the allowlist, checksum, manifest SHA, fixed release path, systemd restart, and SHA-aware readiness. Failure restores the previous symlink and verifies previous-release health.

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
4. Expand personality/skill materialization and curated memory policy.
5. Consider lifecycle control and database-backed operational indexing only after demonstrated need.

## Explicit Non-Goals Now

- PostgreSQL migration
- config editing
- general workflow engine
- full memory service or vector database
- dynamic unrestricted Docker control
- multi-tenancy
- automatic production deployment
