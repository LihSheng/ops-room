# OPS-012C.4 — Current Mission Evidence

## Purpose

OPS-012C.4 connects the durable Mission and Workflow authorities to the existing Agent Fleet read model.

The change is read-only. It does not mutate missions, workflows, tasks, workspaces, provider effects, Git state, pull requests, releases, or agent lifecycle.

## Authority boundaries

The normalized agent view keeps each source distinct:

```text
Agent profile        declared identity and policy
Runtime observation  process and lifecycle evidence
Task store           current bounded work item
Workspace record     isolated repository execution evidence
Mission store        product-level objective and participants
Workflow store       deterministic stage and exact-SHA execution authority
```

Mission state never overwrites task or runtime state.

## Current mission contract

Each fleet record exposes either `current_mission: null` or one bounded summary:

```text
mission_id
title
state
priority
repository_id
starting_branch
starting_sha
workflow_id
workflow_state
participant_roles
stage
stage_state
stage_owner
iteration
current_agent_is_stage_owner
evidence_status
attention_required
attention_reason_code
updated_at
additional_mission_count
```

The summary intentionally excludes mission objective text, history, provider output, filesystem paths, credentials, environment values, authenticated remotes, and unrestricted logs.

## Assignment selection

A non-terminal mission is considered current when its state is one of:

- `planned`
- `active`
- `paused`
- `needs_human`

Every declared participant receives mission evidence. When an agent participates in more than one current mission, selection is deterministic:

1. prefer a mission whose current workflow stage is owned by that agent;
2. prefer needs-human, active, paused, then planned state;
3. prefer urgent, high, normal, then low priority;
4. prefer complete workflow evidence;
5. prefer the most recently updated evidence;
6. use mission ID as a stable tie-breaker.

The chosen summary reports `additional_mission_count` so other current assignments are not hidden.

## Workflow evidence

The current workflow child is the single non-terminal child in one of these states:

- `pending`
- `active`
- `failed`
- `needs_human`

The summary identifies the stage owner separately from mission participation. For example, when the first implementation child is pending:

```text
Professor  participant roles: implementation, integration
           current_agent_is_stage_owner: true

Tokyo      participant role: test
           current_agent_is_stage_owner: false

Berlin     participant role: review
           current_agent_is_stage_owner: false
```

No participant is described as executing a stage merely because they belong to the mission.

## Evidence degradation

Mission and workflow stores load independently.

Source states are:

- `available` — the store was readable and records validated;
- `degraded` — the store was readable but contained unavailable records;
- `unavailable` — the store could not be read.

Per-mission evidence states are:

- `available`
- `mission_only`
- `workflow_unavailable`
- `binding_missing`
- `workflow_conflict`
- `workflow_ambiguous`
- `stage_unavailable`

A valid Mission remains visible when its Workflow is unavailable. Missing state is never guessed.

## Presentation

Agent Fleet cards and Agent Detail use the same `CurrentMissionEvidence` component.

The Fleet view supports:

- mission title and state;
- participant roles;
- current stage and stage owner;
- stage-owner badge;
- additional mission count;
- mission-aware search and attention filtering;
- degraded source warnings.

Agent Detail adds the workflow ID/state, exact starting point, iteration, and evidence quality.

## Validation

The implementation includes tests for:

- participant mapping for Professor, Tokyo, and Berlin;
- stage-owner identification;
- deterministic multiple-mission selection;
- missing workflow evidence;
- independent mission/workflow source degradation;
- bounded public output;
- shared Agent Fleet and Agent Detail presentation.
