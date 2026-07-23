# OPS-012H — Mission Activity and Notifications

## H.1 global durable Mission activity index

OPS-012H.1 introduces one server-owned read contract for chronological activity across all Missions:

```text
GET /api/activity-events
```

The contract is protected by the existing dashboard-read authentication boundary and composes only the durable activity arrays already produced by each Mission Room.

## Public evidence model

Each returned event includes only bounded public evidence:

- durable activity and event IDs;
- event type, category, severity, source, title, detail, reason code, and timestamp;
- Mission ID, title, state, repository ID, and workflow ID;
- stage, owner agent, attempt, bounded input/output SHA evidence, and current event state;
- safe internal links to Mission Room, stage, Agent Detail, and Workflow views.

The index excludes raw provider output, credentials, environment values, authenticated remotes, absolute host paths, unrestricted logs, request bodies, chat transcripts, and private reasoning.

## Determinism and degradation

Events are deduplicated by exact Mission ID plus durable event ID and ordered by:

1. timestamp descending;
2. Mission ID;
3. activity ID.

Mission-list and Mission-room source health are reported independently as `available`, `degraded`, or `unavailable`. A failed Mission Room never creates a synthetic event and does not hide healthy Mission activity.

## Filters

The endpoint supports bounded filters:

- `severity`;
- `category`;
- `mission_id`;
- `attention=true`;
- `limit` from 1 to 500.

Invalid severity or category values fail closed with HTTP 400.

## Authority boundary

H.1 is read-only composition. It cannot invoke a provider, retry an effect, mutate a task or Workflow, change a workspace, use Git/GitHub, write chat or memory, alter agent lifecycle, release, deploy, acknowledge notifications, or deliver external messages.

## Later OPS-012H slices

- H.2: durable per-operator dashboard notification inbox with read and acknowledgement state;
- H.3: Activity page and notification badge integration, actionable drill-in, final lifecycle/restart acceptance, and epic close-out.

Email, Slack, Discord, and GitHub-comment delivery remain deferred beyond the stable dashboard notification model.
