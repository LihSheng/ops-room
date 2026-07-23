# OPS-012D.1 — Mission Room Read Model and Workflow Timeline

## Purpose

OPS-012D.1 introduces the first read-only Mission Room for Ops Room V2.

The Mission Room combines existing durable authorities without changing their state machines:

```text
Mission authority
      +
Workflow-run authority
      +
Workflow-child authority
      +
Workspace evidence
      +
Provider-effect evidence
      ↓
Bounded Mission Room read model
```

The room is visibility only. It does not allocate workspaces, dispatch agents, invoke providers, advance workflows, mutate Git, create pull requests, merge, or deploy.

## Read contract

The existing authenticated Mission detail endpoint remains backward compatible:

```text
GET /api/missions/:missionId
```

It continues returning:

```json
{
  "mission": {}
}
```

and now adds:

```json
{
  "room": {},
  "room_unavailable": false,
  "room_error_code": null
}
```

Using the existing detail route avoids introducing a competing Mission or Workflow execution path. Existing consumers that read only `mission` remain valid.

## Authentication correction

`/api/missions` and all paths below it are included in the dashboard-read authentication matcher.

This means Mission list, Mission detail, and Mission Room evidence accept only the existing dashboard read credentials or an authenticated human session. They are not public read endpoints.

## Deterministic timeline

For every observed iteration, the room renders the fixed stage order:

```text
Professor implementation
        ↓
Tokyo test development
        ↓
Professor integration
        ↓
Berlin exact-SHA review
```

All four stages are present even when a future child has not yet been created. Such entries use:

```text
state: not_created
```

The room never invents a child ID, workspace, provider effect, output SHA, or successful outcome for a stage that has no durable evidence.

## Stage evidence

Each timeline stage exposes only bounded fields:

- iteration;
- stage and deterministic owner;
- child ID when created;
- state;
- attempt and retry count;
- dependency child;
- input and output SHA;
- created, started, and completed timestamps;
- calculated duration;
- bounded failure reason;
- review decision and bounded review reason;
- bounded workspace evidence;
- latest bounded provider-effect evidence and effect count;
- verification status;
- bounded child history.

## Verification result

A stage can report:

```text
not_started
pending
in_progress
verified
degraded
attention
cancelled
unavailable
```

A completed child is `verified` only when:

1. the child has a valid output SHA;
2. a completed provider effect exists;
3. the provider-effect output SHA, when present, matches the child output SHA.

When durable provider-effect evidence is absent, the stage is degraded. External success is never inferred from child state alone.

## Source degradation

Mission Room source states are independent:

```text
available
degraded
unavailable
not_applicable
```

Examples:

- a planned Mission without a workflow reports Workflow, workspace, and effect sources as `not_applicable`;
- a bound Mission with an unreadable Workflow keeps valid Mission evidence and reports Workflow as `unavailable`;
- corrupt workspace records mark workspace evidence `degraded` without hiding the Workflow;
- an unavailable provider-effect store does not imply that no external effect occurred.

## Workspace boundary

The public workspace shape may include:

- workspace ID;
- mode;
- state;
- repository ID;
- branch or detached state;
- resolved SHA;
- investigation hold;
- cleanup requested;
- bounded timestamps.

It excludes:

- absolute paths;
- relative host paths;
- repository cache paths;
- credentials;
- authenticated remotes;
- environment values.

## Provider-effect boundary

The public effect shape may include:

- effect ID;
- bounded effect type;
- state;
- attempt;
- claim and completion timestamps;
- output SHA;
- bounded result code.

It excludes:

- effect payload;
- payload hash;
- prompts;
- raw provider output;
- environment values;
- credentials;
- private reasoning.

## Dashboard experience

The Agent Fleet mission area now contains two separate surfaces:

1. **Mission workflow queue** — existing authorized Mission start operation.
2. **Mission Rooms** — read-only mission list and evidence viewer.

Opening a room displays:

- Mission title, objective, state, repository, exact starting point, participants, and source health;
- deterministic timeline grouped by iteration;
- selectable stage details;
- workspace and provider-effect evidence;
- review decisions, retries, duration, and bounded failure reasons.

Mission creation and Mission start behavior are unchanged.

## Safety invariants

OPS-012D.1 does not expose:

- credentials or tokens;
- environment values;
- authenticated remotes;
- absolute or relative host paths;
- raw provider output;
- unrestricted logs;
- private model reasoning;
- automatic replay of uncertain effects.

## Follow-up slices

After this read model is merged, later OPS-012D work can add:

- dedicated top-level Mission navigation and URL-addressable room routes;
- richer activity event correlation;
- operator-action affordances wired to accepted OPS-012F mutation contracts;
- links from agent mission evidence directly to a selected Mission Room.
