# OPS-012E.1 — Human Intervention Inbox

## Purpose

OPS-012E.1 introduces the first read-only `Needs Human` inbox for Ops Room V2.

The inbox does not become a new task, workflow, workspace, effect, or intervention state authority. It composes existing authenticated read contracts:

```text
Mission list and Mission Rooms
          +
Review tasks and review effects
          +
Agent Fleet evidence
          ↓
Human Intervention Inbox
```

Mutation controls remain deferred to OPS-012F.

## Dashboard route

```text
/interventions
```

The primary navigation label is:

```text
Needs Human
```

The Command Center operator queue also links to the same page.

## Included evidence

### Mission and Workflow evidence

The inbox reads the accepted Mission Room activity stream and includes events that are:

- `intervention` category;
- `attention` severity;
- `error` severity;
- Berlin `changes_requested` review decisions.

This carries bounded Mission, Workflow, Workflow Child, Workspace, Provider Effect, review, and needs-human evidence into the inbox without duplicating their state machines.

### Review-task evidence

Review tasks are included when they are in:

```text
NEEDS_HUMAN
ERROR
CHANGES_REQUESTED
CANCEL_REQUESTED
```

For each included task, the inbox loads bounded durable effects in:

```text
CLAIMED
COMPLETED
```

An unresolved `CLAIMED` effect blocks retry because the external action may already have occurred.

### Agent evidence

Agent Fleet entries are included when:

- attention is required;
- fleet state is `needs_human`;
- fleet state is `unavailable`.

Examples include:

- missing or disabled profile;
- runtime unavailable;
- unhealthy runtime;
- desired/observed lifecycle mismatch;
- lifecycle error;
- current task in an attention state.

## Intervention item contract

Each item explains:

- what happened;
- affected Mission, Workflow, stage, agent, task, workspace, and repository identifiers when available;
- whether an external effect may have occurred;
- whether retry is safe, blocked, unsafe, unknown, or not applicable;
- why an action is blocked;
- recommended operator response;
- bounded evidence used for the recommendation;
- safe internal links to Mission Room, stage evidence, Agent Detail, Tasks, or Workflows.

## External-effect assessment

Possible values:

```text
not_applicable
none_recorded
possible
completed
failed
unknown
```

The inbox reports `possible` when durable evidence shows an unresolved or interrupted effect claim. It never treats missing evidence as proof that no external effect occurred.

## Retry assessment

Possible values:

```text
safe
blocked
unsafe
unknown
not_applicable
```

OPS-012E.1 is conservative:

- Berlin changes requested is `not_applicable` because it is a review decision;
- unresolved or interrupted external effects are `blocked`;
- investigation-held workspaces are `blocked`;
- ordinary task failures remain `unknown` unless durable evidence proves a safe boundary;
- agent lifecycle conditions are `not_applicable` to task retry.

The page does not present a retry button.

## Source degradation

The browser read model tracks independent source state for:

```text
missions
mission_rooms
review_tasks
review_effects
agents
```

Each source can report:

```text
available
degraded
unavailable
not_applicable
```

A failed source does not remove valid intervention evidence from another source.

## Determinism

Intervention IDs are derived deterministically from bounded source identity and problem evidence.

Items are deduplicated by intervention ID. When duplicate representations exist, the richer evidence set is retained.

Ordering is stable:

1. severity: error, attention, warning;
2. newest authoritative timestamp;
3. intervention ID tie-breaker.

## Dashboard experience

The page includes:

- open item count;
- error count;
- retry-blocked count;
- retry-unknown count;
- source health badges;
- search across Mission, agent, task, workspace, repository, problem code, and recommendation;
- filters for errors, blocked retry, unknown retry, and effect uncertainty;
- chronological intervention entries;
- bounded evidence and internal cross-links.

## Security boundary

OPS-012E.1 does not:

- retry, resume, pause, cancel, or resolve tasks;
- advance or mutate Workflows;
- allocate or mutate workspaces;
- invoke providers;
- replay uncertain effects;
- mutate Git or GitHub;
- create pull requests;
- merge;
- deploy.

It does not expose:

- credentials or tokens;
- environment values;
- authenticated remotes;
- absolute or relative host paths;
- provider-effect payloads or payload hashes;
- raw provider output;
- unrestricted logs;
- private reasoning.

## Follow-up slices

After OPS-012E.1 merges, later work can add:

- a server-owned normalized intervention read endpoint if scale or caching requires it;
- durable acknowledgement or assignment state if product review approves a separate intervention authority;
- intervention detail routes;
- OPS-012F authorized retry, resume, cancel, investigation, and effect-resolution controls;
- OPS-012H dashboard notification integration.
