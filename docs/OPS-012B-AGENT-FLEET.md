# OPS-012B — Agent Fleet and Agent Detail

## First implementation slice

This slice introduces the V2 read-only Agent Fleet contract without enabling lifecycle or configuration mutations.

### Scope

- normalize profile, runtime, lifecycle, and task evidence into one bounded fleet read model;
- derive the V2 agent states `offline`, `idle`, `working`, `waiting`, `paused`, `needs_human`, and `unavailable`;
- extend the existing `/api/agents` response with a backward-compatible fleet list;
- expose attention reasons, current work, repository/workspace summary, runtime health, and last activity;
- add a typed dashboard client contract for the next presentation slice;
- preserve existing profile, runtime, task, authentication, and lifecycle contracts;
- keep all agent mutations disabled in this slice.

### Security boundaries

- read-only APIs use the existing dashboard-read authorization boundary;
- no credentials, environment values, absolute or relative workspace paths, raw provider output, or unrestricted logs are returned;
- profile policy and runtime observation remain separate authorities;
- missing or conflicting evidence degrades to explicit bounded states rather than guessed operational authority.

### Deferred

- V2 Agent Fleet page presentation and Agent Detail fleet summary;
- lifecycle controls;
- profile editing;
- mission assignment and mission data;
- workspace detail controls;
- direct agent chat;
- capability-based routing.
