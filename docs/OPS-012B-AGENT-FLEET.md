# OPS-012B — Agent Fleet and Agent Detail

## First implementation slice — normalized fleet contract

This slice introduces the V2 read-only Agent Fleet contract without enabling lifecycle or configuration mutations.

### Scope

- normalize profile, runtime, lifecycle, and task evidence into one bounded fleet read model;
- derive the V2 agent states `offline`, `idle`, `working`, `waiting`, `paused`, `needs_human`, and `unavailable`;
- extend the existing `/api/agents` response with a backward-compatible fleet list;
- expose attention reasons, current work, repository/workspace summary, runtime health, and last activity;
- add a typed dashboard client contract;
- preserve existing profile, runtime, task, authentication, and lifecycle contracts;
- keep all agent mutations disabled.

## Second implementation slice — Agent Detail operational summary

The Agent Detail page consumes the normalized fleet contract alongside the independently loaded profile and runtime authorities.

### Visible evidence

- canonical V2 fleet state;
- operator-attention reason and bounded summary;
- current task title, state, and task type;
- runtime status, health, backend, and restart count;
- current repository assignment;
- last known activity time;
- bounded workspace ID, mode, state, branch, and short SHA;
- investigation-hold and cleanup-request markers.

Fleet-source failure remains isolated: profile policy and runtime observation continue to render independently.

## Third implementation slice — Agent Fleet page presentation

The authenticated `/agents` route now presents the normalized fleet contract as the primary V2 fleet workspace. The compact legacy table remains only on the command-center dashboard as a summary view.

### Fleet workspace

- summary metrics for registered, working, attention-required, and offline/unavailable agents;
- search across agent identity, role, responsibility, task, and repository evidence;
- bounded state filters for working, attention, and offline views;
- responsive agent cards showing canonical state, current work, runtime health, repositories, workspace evidence, and last activity;
- explicit degraded-source warning when profile, runtime, or task evidence is unavailable;
- direct navigation to the existing Agent Detail page;
- an explicit read-only marker and no browser mutation controls.

## Security boundaries

- read-only APIs use the existing dashboard-read authorization boundary;
- no credentials, environment values, absolute or relative workspace paths, raw provider output, or unrestricted logs are returned;
- profile policy and runtime observation remain separate authorities;
- missing or conflicting evidence degrades to explicit bounded states rather than guessed operational authority;
- no lifecycle, profile, workspace, or mission mutation authority is introduced.

## Remaining boundaries

- current mission evidence remains deferred until OPS-012C defines the mission model;
- lifecycle, workspace, and profile controls remain deferred to the browser-control epic;
- direct agent chat and capability-based routing remain outside OPS-012B.
