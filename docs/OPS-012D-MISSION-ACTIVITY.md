# OPS-012D.3 — Mission Activity Correlation and Evidence Cross-Links

## Purpose

OPS-012D.3 adds one bounded Mission activity stream to the accepted Mission Room read model.

It does not create a new event store or execution authority. Activity is correlated at read time from existing durable authorities:

```text
Mission history
      +
Workflow history
      +
Workflow Child history
      +
Workspace records
      +
Provider Effect records
      +
Review decisions
      +
Needs-human / failure evidence
      ↓
Bounded Mission activity stream
```

## Additive read contract

The existing authenticated Mission detail endpoint remains unchanged:

```text
GET /api/missions/:missionId
```

Its `room` property now also contains:

```text
activity
activity_summary
```

Existing Mission and Mission Room fields remain valid.

## Activity event shape

Each event exposes only bounded fields:

- deterministic event ID;
- semantic event type;
- category;
- severity;
- durable source authority and source ID;
- bounded title and detail;
- bounded reason code;
- authoritative timestamp;
- Mission and Workflow IDs;
- Workflow Child ID;
- iteration, stage, stage owner, and stage key;
- input and output SHA when durably recorded;
- state and attempt;
- internal Mission, stage, agent, and workflow-summary links.

## Categories

```text
mission
workflow
stage
workspace
effect
review
intervention
```

`intervention` is not a separate mutable authority. It is a presentation category derived only from accepted durable states such as:

- Mission or Workflow `needs_human`;
- blocked Workflow;
- failed or needs-human Workflow Child;
- Berlin `changes_requested`;
- failed or needs-human Provider Effect;
- workspace investigation hold.

## Severity

```text
info
success
warning
attention
error
```

Severity is deterministic from the durable event type and state.

## Correlation and deduplication

Workflow history and Workflow Child history can represent the same state transition.

For example:

```text
workflow_child_completed
```

and:

```text
active → completed
```

may share the same child, stage, and timestamp.

The Mission Room creates one semantic `stage.completed` activity entry and prefers the representation containing richer bounded evidence.

The deduplication key uses:

```text
event type
+ stage/source identity
+ authoritative timestamp
```

Events are then sorted newest-first with a stable event-ID tie-breaker and capped at 200 entries.

## Cross-links

Activity events can link to:

```text
/missions/:missionId
/missions/:missionId#workflow-summary
/missions/:missionId#stage-:iteration-:stage
/agents/:agentId
```

Stage hashes select the corresponding timeline stage and scroll it into view on bookmarked Mission URLs.

Exact SHAs are displayed as bounded evidence. They are not linked to an external Git remote because the public read model does not expose or trust authenticated remotes.

## Dashboard experience

The Mission Room now shows:

- activity totals;
- attention-event count;
- review count;
- retry count;
- provider-effect event count;
- latest event time;
- filters for all, attention, reviews, effects, and workspaces;
- event timeline with source/category/severity badges;
- bounded reasons, attempts, stage identity, and input/output SHAs;
- direct links to stage evidence, agent detail, and workflow summary.

## Degradation behavior

Each underlying source still degrades independently.

- A valid Mission with no Workflow produces only Mission events.
- An unavailable Workflow source does not produce guessed Workflow events.
- An unavailable workspace store does not imply that no workspace existed.
- An unavailable Provider Effect store does not imply that no external effect occurred.
- Corrupt or missing timestamps do not produce invented ordering.

## Security boundary

The activity stream does not expose:

- credentials or tokens;
- environment values;
- authenticated remotes;
- absolute or relative host paths;
- Provider Effect payloads or payload hashes;
- raw provider output;
- unrestricted logs;
- private model reasoning.

It does not:

- create or mutate Missions;
- advance Workflows;
- activate, retry, or cancel Workflow Children;
- allocate or mutate workspaces;
- invoke providers;
- mutate Git or GitHub;
- create pull requests;
- merge;
- deploy;
- replay uncertain external effects.

## Handoff to OPS-012E

OPS-012D.3 completes the read-only Mission Room foundation.

OPS-012E can build the Human Intervention Inbox from the same accepted needs-human and failure evidence while introducing explicit intervention authority and bounded operator actions separately.
