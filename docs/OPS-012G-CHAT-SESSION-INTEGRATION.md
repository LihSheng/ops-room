# OPS-012G.3 — Final Chat Session Integration and Acceptance

## Purpose

OPS-012G.3 closes governed chat by giving operators one bounded lifecycle index across direct and Mission-bound sessions, exact transcript drill-in, and Needs Human evidence without creating another task runner or notification system.

## Unified index

Authenticated route:

```text
GET /api/operator/chat-sessions
```

Required authority:

```text
agent.chat
```

Supported filters:

```text
type=all|direct|mission
state=all|open|needs_human|closed
attention=true|false
agent_id=<exact agent>
mission_id=<exact Mission>
limit=1..200
```

The index returns only:

- session ID and type;
- lifecycle state and title;
- direct agent or Mission ownership;
- declared participant IDs;
- turn count;
- latest turn ID, state, target, bounded error code, and timestamp;
- attention status;
- creating actor identity;
- created, updated, and closed timestamps;
- bounded internal navigation links;
- independent direct-session and Mission-session source health.

The index never returns:

- human message text;
- agent response text;
- provider request or response bodies;
- idempotency keys;
- content or response hashes;
- credentials or environment values;
- repository, workspace, task, Workflow, effect, host-path, or authenticated-remote evidence;
- private reasoning.

Direct and Mission sources degrade independently. A failure to list one source does not erase valid evidence from the other.

## Exact transcript drill-in

The Chat Sessions workspace lives under:

```text
/interventions?view=chat
```

Selecting one session adds:

```text
session=<exact session ID>
```

Only then does the browser call the existing exact detail endpoint:

```text
Direct:  GET /api/operator/chat-sessions/:sessionId
Mission: GET /api/operator/mission-chat-sessions/:sessionId
```

This preserves a transcript-free common index while allowing an authorized operator to inspect one exact durable transcript.

## Needs Human integration

The existing Needs Human workspace now includes a bounded chat section sourced from:

```text
GET /api/operator/chat-sessions?attention=true
```

A chat session enters this section only when its durable session state is:

```text
needs_human
```

A closed session is historical and does not remain an open intervention even when its final recorded turn required attention before closure.

Chat intervention cards expose only:

- exact session and type;
- attention code;
- latest addressed agent;
- updated timestamp;
- source health;
- exact session-evidence link.

Transcript and response text are not copied into intervention evidence.

## Retry boundary

Chat Needs Human evidence always treats automatic provider replay as blocked.

```text
accepted human message
        ↓ provider outcome uncertain
needs_human
        ↓ no automatic replay
human inspection and deliberate next action
```

Safe browser-delivery replay remains owned by the original create and message endpoints. Reusing the same accepted idempotency identity returns stored evidence without another provider call. G.3 does not create a new retry mutation.

## Lifecycle acceptance

- open sessions remain indexed and may accept new messages only through the G.1/G.2 authority checks;
- needs-human sessions remain indexed, read-only, and visible in Needs Human;
- closed sessions remain indexed and readable as history;
- disabled agents and Mission participants retain historical evidence;
- new provider turns to disabled identities remain blocked by the original server contracts;
- restart-interrupted direct and Mission turns converge to needs-human evidence without replay;
- exact transcript reads do not change durable state.

## Security boundary

G.3 adds read-only composition only. It cannot:

- invoke a provider;
- replay an interrupted provider turn;
- create or advance tasks or Workflows;
- mutate workspaces, Git, or GitHub;
- resolve provider effects;
- write memory or Obsidian content;
- change agent lifecycle;
- release or deploy software;
- deliver notifications.

Notifications and activity-feed delivery remain OPS-012H.

## Validation

Focused tests cover:

- unified direct and Mission summaries;
- transcript exclusion;
- exact owner/type/state filtering;
- attention filtering;
- closed-history retention;
- independent source degradation;
- exact route matching and `agent.chat` authorization;
- server registration before HTTP composition;
- first-class Chat Sessions workspace;
- exact detail drill-in;
- chat Needs Human evidence without transcript duplication;
- blocked automatic replay messaging;
- bounded navigation contracts.

Final acceptance requires Ubuntu and Windows tests/dashboard builds, OpenAB smoke, immutable release verification, and required-check aggregation to pass on the reviewed head.
