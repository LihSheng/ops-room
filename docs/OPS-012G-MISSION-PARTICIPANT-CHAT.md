# OPS-012G.2 — Mission-Bound Participant Chat

## Status

Implementation for issue #95.

OPS-012G.2 adds one governed, durable participant conversation to every Mission Room. The transcript is owned by Ops Room and bound to the exact Mission record. Each human message addresses exactly one agent declared in that Mission's participant list.

## Routes

```text
GET  /api/operator/missions/:missionId/participant-chat
POST /api/operator/missions/:missionId/participant-chat
GET  /api/operator/mission-chat-sessions/:sessionId
POST /api/operator/mission-chat-sessions/:sessionId/messages
POST /api/operator/mission-chat-sessions/:sessionId/close
```

Every route requires an authenticated human operator session or accepted dedicated operator bearer with `agent.chat`. Browser mutations additionally require session CSRF.

## Mission authority

The Mission record remains the participant authority.

Before every create, read, send, and close operation, Ops Room reads the exact Mission record. A message target must match one entry in `mission.participants`.

The fixed feature-development participant declaration is:

```text
professor — implementation, integration
tokyo     — test
berlin    — review
```

The browser participant selector is advisory. The server rejects any target outside the Mission declaration before provider invocation.

Completed and cancelled Missions are historical read-only records:

- existing transcripts remain visible;
- a new Mission chat cannot be created;
- no new participant message can invoke a provider;
- closing an existing chat remains allowed as a deliberate archival action.

## One session per Mission

A Mission has one deterministic session ID derived from its Mission ID.

Session creation is explicit and audited, but never invokes a provider. Repeating creation returns the same durable session rather than producing fragmented conversations.

Session states:

```text
open
needs_human
closed
```

Turn states:

```text
provider_pending
completed
needs_human
```

Every turn records:

- exact target agent ID;
- target role snapshot;
- human actor and bounded message;
- bounded final participant response when completed;
- provider and model labels;
- bounded error code when attention is required.

Internal idempotency keys and content hashes are not exposed to the browser.

## Idempotency and serialization

A turn ID is deterministic from the Mission chat session and message idempotency key.

The content hash covers both:

```text
target participant
message content
```

Therefore the same message identity cannot be reused to silently switch from Professor to Tokyo or Berlin.

The same key, target, and content return stored evidence without a second provider call. A changed target or changed content fails closed.

One session lock serializes concurrent sends.

## External-effect fencing

The addressed human message is durably persisted as `provider_pending` before the provider request starts.

On success:

```text
provider_pending → completed
```

On bounded provider failure:

```text
provider_pending → needs_human
session → needs_human
```

On restart, any remaining pending turn becomes:

```text
needs_human
mission_chat_provider_interrupted
```

Startup removes abandoned Mission-chat locks left by the previous process before reconciliation. The server is not accepting requests at this point.

No interrupted participant message is replayed automatically.

## Provider boundary

The selected participant's enabled Git-backed profile is validated before the pending turn is created and again by the provider adapter.

The provider receives only:

- selected participant public ID and display name;
- public profile mission and personality policy;
- Mission title, objective, and state;
- selected participant roles;
- declared participant IDs and roles;
- at most the latest 30 bounded transcript messages.

The provider does not receive:

- repository ID;
- branch or SHA;
- supporting context or reference documents;
- workspace or provider-effect evidence;
- tasks or Workflow child records;
- file, shell, Git, GitHub, skill, memory-body, web, lifecycle, release, or deployment tools.

No tool contract is sent. The provider returns one bounded final response. Raw provider response bodies and private reasoning are not exposed.

## Browser workflow

Every Mission Room contains a Mission Participant Chat panel.

Operators and administrators can:

- create the Mission's single chat with a reason and authority acknowledgement;
- see the declared participant and role badges;
- address Professor, Tokyo, or Berlin explicitly;
- read the shared Mission transcript;
- see pending, completed, and needs-human participant turns;
- retry uncertain browser delivery with the same target, content, and request identity;
- close the chat with reason and explicit consequence acknowledgement.

The UI prefers the owner of the current visible stage, when available, but the operator may select any declared Mission participant.

Terminal Missions and closed or needs-human sessions are visibly read only.

## Audit boundary

Accepted and rejected create, send, and close operations record:

- authenticated human actor and session;
- exact Mission, session, turn, and participant target;
- reason where required;
- idempotency identity;
- previous and resulting state;
- provider-invoked flag;
- message digest and length;
- bounded error code when applicable.

Transcript and provider response text are not duplicated into the audit log.

## Deferred

OPS-012G.2 does not add:

- autonomous agent-to-agent conversation;
- chat-driven task or Workflow mutation;
- attachments;
- direct memory or Obsidian writes;
- provider-native continuation IDs or exports;
- cross-Mission chat;
- final chat indexing, notifications, and epic acceptance work reserved for OPS-012G.3.

## Validation target

Focused tests cover:

- one deterministic session per Mission;
- exact participant and role attribution;
- participant-switch idempotency conflict;
- undeclared and disabled participant refusal;
- terminal Mission read-only behavior;
- provider failure and restart fencing;
- startup abandoned-lock recovery;
- provider request exclusions;
- audited create, send, and close operations;
- encoded route targeting and CSRF-bound browser client;
- first-class Mission Room integration and retained uncertain-delivery identity.

Cross-platform CI, OpenAB smoke, immutable release verification, and required-check aggregation must pass before the pull request becomes ready for review.
