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

The Agent Detail page now consumes the normalized fleet contract alongside the independently loaded profile and runtime authorities.

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

## Security boundaries

- read-only APIs use the existing dashboard-read authorization boundary;
- no credentials, environment values, absolute or relative workspace paths, raw provider output, or unrestricted logs are returned;
- profile policy and runtime observation remain separate authorities;
- missing or conflicting evidence degrades to explicit bounded states rather than guessed operational authority;
- no lifecycle, profile, workspace, or mission mutation authority is introduced.

## Remaining OPS-012B work

- replace the legacy Agents table with the V2 Agent Fleet page presentation;
- add broader operational tabs after the fleet page is stable;
- integrate current mission evidence only after OPS-012C defines the mission model;
- defer bounded agent controls to the later browser-control epic.
