# Guarded Agent Lifecycle

Status: **OPS-008 first vertical slice**

This document defines the initial lifecycle mutation boundary for Ops Room. It adds one audited graceful-stop action for one explicitly approved non-critical test agent. It is not a general Docker controller and does not complete the full lifecycle roadmap.

## Scope

The current slice supports:

```http
POST /api/operator/agents/:agentId/stop
```

Only an agent that satisfies both controls is eligible:

1. its canonical `agent-definitions.ts` entry declares `lifecycleControl: guarded-stop-test`;
2. its ID is present in `OPS_ROOM_AGENT_LIFECYCLE_ALLOWED_AGENTS`.

Gemini is the only current canonical test target. Professor, Berlin, and Tokyo are explicitly lifecycle-disabled because their production workflow and legacy polling activity require a broader drain and reconciliation contract.

## Authority boundaries

| Concern | Authority |
|---|---|
| Stable agent identity and lifecycle eligibility | `agent-definitions.ts` |
| Provider-neutral runtime target | OPS-007 runtime adapter registry |
| External stop operation | guarded runtime lifecycle controller |
| Desired lifecycle state and operation evidence | persistent lifecycle records |
| Observed process state | read-only runtime adapter inspection |
| Actor, reason, outcome, and safe metadata | append-only audit events |
| Retry replay protection | persistent idempotency store |
| Active review/fix work | durable review-task store |

Desired and observed state remain separate. A stored desired state does not prove the container state, and an observed container state does not grant authority to mutate it.

## Durable state

Per-agent records are stored outside immutable releases under the configured lifecycle directory. The loader accepts only the documented schema, agent identity, state enums, bounded error code, and bounded operation fields. Unexpected fields are discarded; malformed or unsupported records fail closed.

```json
{
  "schema": "ops-room.agent-lifecycle.v1",
  "agent_id": "gemini",
  "desired_state": "stopped",
  "phase": "stopped",
  "previous_desired_state": null,
  "last_operation": {
    "operation": "agent.stop",
    "actor_id": "lihsheng",
    "reason": "Approved test stop",
    "requested_at": "2026-07-19T12:00:00.000Z",
    "completed_at": "2026-07-19T12:00:01.000Z",
    "outcome": "accepted"
  },
  "last_error": null,
  "updated_at": "2026-07-19T12:00:01.000Z"
}
```

Current phases are:

- `unmanaged` — no successful lifecycle request controls the agent;
- `draining` — new durable review/fix dispatch is blocked while active work is checked;
- `stopping` — drain is complete and the bounded runtime stop is in progress;
- `stopped` — the stop operation completed or observation proved an already-stopped no-op;
- `failed` — the requested lifecycle transition could not complete safely.

A later slice may introduce explicit `starting` and `running` phases when a reviewed start and reconciliation contract exists.

## Graceful stop sequence

1. Authenticate through the existing operator credential and resolve stable actor identity.
2. Require the separate lifecycle feature flag.
3. Validate agent ID, explicit environment allowlist, canonical eligibility, reason, exact confirmation, and idempotency key.
4. Select the runtime target through the OPS-007 adapter preparation boundary.
5. Persist `desired_state=stopped` and `phase=draining`.
6. Block new durable review/fix dispatch for the target agent.
7. Scan durable review/fix tasks until no active task remains or the drain deadline expires.
8. Persist `phase=stopping`.
9. Execute one fixed-form `docker stop --time <bounded> <validated-name>` command asynchronously without a shell and with ignored output.
10. Persist `phase=stopped` and append the accepted audit event.
11. Persist the completed response in the idempotency store.

If read-only observation already reports `exited`, `dead`, `missing`, or `stopped`, step 9 becomes an audited no-op. Durable `stopped` state also short-circuits later different-key requests as audited no-ops, preventing stale observation-cache data from triggering a second Docker command.

## Failure handling

### Drain timeout

The controller does not cancel or kill active work. It rejects the stop, restores the previous desired state, records `phase=failed`, and writes a rejected audit event with bounded counts and duration.

### Corrupt task state

If the durable task scan contains corrupt records, Ops Room cannot prove a safe drain. The action fails closed without executing Docker.

### Runtime command failure

The controller ignores stdout and stderr, restores the previous desired state, records `runtime_stop_failed`, and returns a bounded `502` response. The spawned command is killed after the configured stop timeout plus a five-second control-plane margin.

### Process restart during an operation

Startup recovery does not replay Docker commands. Records left in `draining` or `stopping` become `failed` with `interrupted_lifecycle_operation`. The operator must inspect observed state and decide the next manual or reviewed action.

### Corrupt lifecycle state

Lifecycle dispatch checks and lifecycle mutations fail closed for the affected agent. Read APIs expose only a bounded unavailable state, never raw file contents, operator reason, or unexpected fields.

## Concurrency and dispatch

Lifecycle mutations are serialized globally in the current process. This intentionally permits only one heavy runtime mutation at a time on the 2 CPU / 8 GB host.

The review/fix dispatcher checks lifecycle permission before and after acquiring its concurrency reservation lock. This closes the race where a queued task could be claimed after an agent entered `draining`.

The first slice does not claim that all legacy issue work can be drained. That is why lifecycle eligibility is limited to Gemini, whose canonical definition has polling disabled.

## Configuration

Keep the feature disabled after deployment until an approved test window:

```text
OPS_ROOM_OPERATOR_API_ENABLED=true
OPS_ROOM_AGENT_LIFECYCLE_ENABLED=false
OPS_ROOM_AGENT_LIFECYCLE_ALLOWED_AGENTS=gemini
OPS_ROOM_LIFECYCLE_DIR=/absolute/path/to/data/ops-room/lifecycle
OPS_ROOM_AGENT_LIFECYCLE_DRAIN_TIMEOUT_MS=20000
OPS_ROOM_AGENT_LIFECYCLE_DRAIN_POLL_MS=500
OPS_ROOM_AGENT_LIFECYCLE_STOP_TIMEOUT_SECONDS=20
```

The default drain plus stop bounds fit inside the standard 55-second Ops Room shutdown window. Larger overrides are permitted only when the service manager timeout and restart-recovery plan have been reviewed together.

For the approved test, enable the lifecycle flag and restart Ops Room through the immutable deployment process. Do not add Professor, Berlin, or Tokyo to the allowlist.

## Verification checklist

Before calling the endpoint:

- confirm the deployed SHA;
- confirm health is ready and `lifecycle_store` is healthy;
- confirm Gemini has no active durable review/fix task;
- confirm the current observed state through `/api/agents` or `/api/openab/instances`;
- confirm the previous immutable Ops Room release remains rollback-capable;
- confirm the manual Gemini recovery procedure is available because a start endpoint does not yet exist.

After the request:

- verify the response is `202` and references `agent.stop`;
- verify the lifecycle record reports `desired_state=stopped` and `phase=stopped`;
- verify read-only observation converges to an exited/stopped state;
- verify one accepted audit event exists;
- repeat the identical request and verify `idempotent_replay=true` with no second Docker command;
- submit a different-key stop request and verify it is an audited no-op with no second Docker command;
- verify queued work for Gemini is not dispatched while stopped;
- verify public agent/instance APIs do not expose operator identity or human reason;
- verify Professor, Berlin, and Tokyo remain unaffected.

## Rollback and recovery

Code rollback uses the normal immutable Ops Room release rollback. Persistent lifecycle, audit, and idempotency records remain outside the release.

Disabling `OPS_ROOM_AGENT_LIFECYCLE_ENABLED` removes mutation access but does not restart a stopped agent. Recover Gemini using the separately approved manual runtime procedure, verify read-only observed state, and record the action. A future start endpoint must be reviewed as a separate slice.

## Explicit non-goals

- start or restart;
- force stop, kill, or recreate;
- Docker socket exposure to the web process;
- arbitrary Docker command execution;
- lifecycle control for production workflow agents;
- automatic desired-state reconciliation;
- automatic idle shutdown;
- browser lifecycle controls;
- browser identity, RBAC, or elevated confirmation policy;
- resource provisioning or autoscaling;
- provider session creation;
- automatic production deployment.
