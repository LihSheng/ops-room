# OPS-012G.1 — Durable Direct Agent Chat Sessions

## Status

Implementation for issue #93.

OPS-012G.1 introduces direct human-to-agent chat as a governed Ops Room capability. The browser manages durable Ops Room session records; each message creates at most one bounded external provider turn.

## Routes

```text
GET  /api/operator/agents/:agentId/chat-sessions
POST /api/operator/agents/:agentId/chat-sessions
GET  /api/operator/chat-sessions/:sessionId
POST /api/operator/chat-sessions/:sessionId/messages
POST /api/operator/chat-sessions/:sessionId/close
```

Every route requires an authenticated human operator session or accepted dedicated operator bearer with `agent.chat`. Browser mutations additionally require session CSRF.

Session creation and close requests require:

- one exact target;
- a human-readable reason;
- one idempotency key;
- durable accepted or rejected audit evidence.

Message submission requires:

- one exact open session;
- bounded content of at most 4,000 characters;
- one idempotency key;
- serialized execution under the session lock;
- durable audit metadata containing a content digest and length rather than message text.

## Durable session authority

Ops Room stores direct sessions in `agent-chat-sessions` under the runtime data root.

A session has one of these states:

```text
open
needs_human
closed
```

A turn has one of these states:

```text
provider_pending
completed
needs_human
```

The human message is persisted as `provider_pending` before the provider request starts. A completed response is then attached to the same turn.

The same message idempotency key and content return the stored turn without invoking the provider again. Reusing the key with different content fails closed.

## Restart safety

At startup, every durable `provider_pending` turn is converted to:

```text
state: needs_human
error_code: agent_chat_provider_interrupted
```

The message is never replayed automatically. The session remains durable investigation evidence and may be closed by an operator.

## Provider boundary

Direct chat uses the configured OpenCode-compatible chat-completions endpoint as a stateless provider turn.

The provider receives only:

- the agent's validated public ID and display name;
- public mission text;
- public communication style, decision policies, and constraints;
- at most the latest 20 bounded human and agent messages.

The request does not contain:

- repository assignments;
- memory-space keys or content;
- skill manifests or executable tools;
- workspace records or paths;
- task or Workflow mutation authority;
- shell, file, Git, GitHub, web, lifecycle, or deployment tools.

The provider response is normalized to one bounded final text response. Raw provider bodies and failure details are not exposed to the browser.

## Browser workflow

Every profile-backed Agent Detail page now contains a Direct Chat panel.

Operators and administrators can:

- create a session with a reason and explicit authority acknowledgement;
- select durable sessions;
- read bounded transcripts;
- send a message while retaining the same request identity if delivery is uncertain;
- close a session with a reason and explicit consequence acknowledgement.

The UI states explicitly that chat is for clarification, conceptual investigation, implementation discussion, and summaries. It cannot replace tasks, deterministic Workflow state, workspace ownership, exact-SHA handoffs, Berlin decisions, or approvals.

## Audit boundary

Accepted and rejected operations record:

- authenticated actor and browser session;
- operation and exact target;
- reason where required;
- idempotency key;
- previous and resulting state;
- agent/session/turn identifiers;
- provider invocation flag;
- message digest and length for sends;
- bounded error code when applicable.

Audit records do not contain transcript text or provider response text.

## Deferred

OPS-012G.1 does not include:

- Mission participant group chat;
- provider-native session continuation or export;
- direct memory or Obsidian writes;
- attachments;
- agent-to-agent free-form messaging;
- chat-driven task, Workflow, workspace, GitHub, lifecycle, release, or deployment mutation.

## Validation

Focused tests cover:

- deterministic session creation;
- message and close idempotency;
- one provider invocation per message identity;
- conflicting message-key refusal;
- provider failure and interrupted-turn fencing;
- bounded public session serialization;
- tool-free provider requests;
- profile policy inclusion without repository or memory assignment leakage;
- route decoding and malformed-route refusal;
- operator/administrator permission separation;
- durable accepted and rejected audit evidence;
- Agent Detail integration and retained browser request identities.

Cross-platform CI, OpenAB smoke, immutable release verification, and required-check aggregation must pass before the pull request becomes ready for review.
