# OPS-012D.2 — Dedicated Mission Navigation and URL-Addressable Rooms

## Purpose

OPS-012D.2 promotes Missions into a first-class dashboard area.

OPS-012D.1 introduced the bounded Mission Room read model. This slice adds stable navigation and durable URLs without changing Mission, Workflow, Workspace, Provider Effect, or operator mutation authorities.

## Routes

```text
/missions
/missions/:missionId
```

`/missions` is the dedicated Mission list.

`/missions/:missionId` is the exact Mission Room route. Mission IDs are encoded when links are created and read through the existing authenticated Mission detail contract.

## Primary navigation

The application sidebar now includes:

```text
Missions
```

Nested Mission Room paths keep the Missions navigation item active and preserve the `Ops Room / Missions` breadcrumb.

## Mission list

The list shows bounded durable Mission fields:

- title and objective;
- Mission ID;
- Mission state and priority;
- repository;
- starting branch and short exact SHA;
- Workflow binding;
- declared participants.

The list supports bounded browser-side search and state filters:

```text
all
planned
active
attention
completed
```

Unreadable Mission records remain excluded from direct navigation and are reported through a bounded warning count.

Mission creation and explicit start remain under Agent Fleet operator controls.

## Mission Room deep link

A direct Mission Room URL:

- survives browser refresh;
- can be copied or bookmarked;
- loads the exact durable Mission identifier;
- reuses the accepted OPS-012D.1 read contract;
- does not redirect missing or invalid Mission URLs to the dashboard.

The route distinguishes:

```text
loading
invalid identifier
Mission not found
read contract unavailable
Mission available but room evidence unavailable
Mission Room available
```

Missing Workflow, workspace, or provider-effect evidence is never inferred.

## Agent cross-links

The shared current-Mission component used by Agent Fleet and Agent Detail now links to:

```text
/missions/<encoded mission_id>
```

Compact Agent Fleet cards expose `Open room`.

Agent Detail exposes `Open Mission Room`.

Both links use the same durable Mission identifier and route contract.

## Embedded Agent Fleet surface

The Mission workflow queue remains in Agent Fleet for:

- planned Mission visibility;
- authorized explicit start;
- the existing deliberate start confirmation boundary.

The former embedded Mission Room modal is removed. Its panel now directs users to the first-class Missions area.

## Refresh behavior

The global dashboard refresh invalidates:

```text
missions
mission-room
```

alongside existing dashboard, fleet, profile, skill, memory, and runtime queries.

## Security invariants

This slice is navigation and presentation only. It does not:

- create or start Missions;
- advance Workflows;
- activate, retry, or cancel Workflow Children;
- allocate or mutate workspaces;
- invoke providers;
- mutate Git or GitHub;
- create pull requests;
- merge;
- deploy;
- replay uncertain effects.

The routes expose only the bounded Mission Room contract and do not expose credentials, environment values, authenticated remotes, host paths, provider payloads, raw provider output, unrestricted logs, or private reasoning.
