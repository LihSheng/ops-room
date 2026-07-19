# Runtime Adapter Read Model

OPS-007 introduces a read-only boundary between Ops Room APIs and provider/runtime inspection details.

## Responsibilities

Each `AgentRuntimeAdapter` must:

1. declare a stable adapter ID;
2. state whether it supports an agent definition;
3. prepare a provider-neutral `PreparedRuntime` without creating files or changing runtime state;
4. inspect one or more prepared runtimes using bounded read-only operations;
5. return normalized status, health, timestamps, restart count, exit code, and OOM information where available;
6. return bounded diagnostics that do not expose command output, environment values, tokens, or host paths.

The registry requires exactly one adapter for every canonical agent. Unsupported or ambiguously supported definitions are configuration errors.

## Current adapter

`openab-docker` supports the current OpenAB/OpenCode and OpenAB/Gemini definitions. Their inspection mechanics are materially identical: both are observed as named Docker containers. A separate Gemini adapter is unnecessary until its runtime differs in a way that requires a distinct inspection contract.

The Docker implementation is split into:

- `docker-read-inspector.ts` — the only runtime-observation module allowed to call the Docker CLI;
- `openab-docker-adapter.ts` — maps agent definitions to prepared container targets and normalized statuses;
- `registry.ts` — selects adapters, groups inspection, degrades bounded failures to `unknown`, and exposes provider-neutral snapshots.

## Consumer contract

Agent registry and instance API code may consume only the runtime adapter snapshot. They must not:

- execute `docker`, provider CLIs, Compose, or systemd commands;
- inspect the Docker socket directly;
- parse provider-specific command output;
- infer lifecycle authority from observed state;
- turn an inspection failure into a mutation attempt.

The existing `/api/agents` and `/api/openab/instances` response fields remain compatible. Additive `runtime_adapter` and `runtime_adapters` fields identify the normalized observation source and its bounded availability status.

## Security and lifecycle boundary

OPS-007 is read-only. It does not add:

- start, stop, restart, kill, pause-process, or recreate operations;
- Docker socket writes or unrestricted Docker access;
- provider session creation or command execution;
- desired-state reconciliation;
- dashboard mutation controls;
- automatic recovery actions.

`desired_state` remains `unmanaged`. Observed runtime status is evidence only and does not authorize a lifecycle change.

Lifecycle mutations belong to OPS-008 and must reuse authenticated operator identity, audit, idempotency, confirmation, resource limits, drain behavior, and rollback rules.

## Adding another adapter

A new adapter must include contract tests proving:

- deterministic support selection;
- side-effect-free preparation;
- normalized status output;
- bounded failure behavior;
- no secret or raw command-output exposure;
- backward-compatible API consumption through a fake adapter;
- no lifecycle mutation methods.
