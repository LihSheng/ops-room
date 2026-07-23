# OPS-012F.3 — Effect Resolution and Workspace Investigation Controls

## Status

Ready for review in PR #92. CI #278 passes all required checks.

OPS-012F.3 completes the safe browser-control epic by adding explicit provider-effect resolution and workspace investigation controls. React presents bounded evidence and submits exact requests; durable state authority remains on the server.

## Routes

```text
POST /api/operator/workflows/:workflowId/children/:childId/effects/:effectId/resolve
POST /api/operator/workflows/:workflowId/children/:childId/workspaces/:workspaceId/hold
POST /api/operator/workflows/:workflowId/children/:childId/workspaces/:workspaceId/release
POST /api/operator/workflows/:workflowId/children/:childId/workspaces/:workspaceId/cleanup
```

Every request requires:

- an authenticated human session or accepted dedicated operator bearer;
- `workflow.recover`;
- session CSRF for browser mutations;
- one exact Workflow ID, child ID, expected attempt, and effect or workspace ID;
- a human-readable reason;
- one retained idempotency key;
- durable accepted or rejected audit evidence.

## Provider-effect resolution

A `claimed` effect remains unresolved and cannot be changed or retried from the browser.

A `needs_human` current-attempt effect must receive one explicit resolution before the existing retry route will accept it.

### Verified safe to retry

The server:

1. re-reads the Workflow and exact child;
2. verifies the expected attempt;
3. verifies the effect belongs to that child, stage owner, effect type, and attempt;
4. re-reads workspace ownership;
5. inspects the actual Git workspace HEAD;
6. requires the actual HEAD to equal the child input SHA;
7. records the effect as `failed` with `operator.safe_to_retry` and bounded resolution metadata.

This action does not increment the attempt, activate the child, or invoke a provider. The operator may then use the existing retry action as a separate deliberate request.

### Verified completed

The server requires:

- a `needs_human` current-attempt effect;
- an exact 40-character output SHA supplied by the operator;
- actual workspace HEAD equal to that SHA;
- result code `ok` for implementation, test, and integration stages;
- `review.approved` or `review.changes_requested:<bounded-code>` for Berlin review stages.

The effect becomes `completed` without replaying the provider. Existing restart-safe reconciliation remains responsible for recovering the Workflow child from completed effect and workspace evidence.

## Retry fencing

The F.2 retry route now rejects:

- `claimed` effects because execution may still be uncertain;
- unresolved `needs_human` effects because the operator has not yet classified the durable evidence.

Only a terminal `failed` effect may enter the existing retry contract. The retry contract still re-verifies the workspace input SHA and all Workflow authority.

## Workspace investigation controls

### Hold

An exact workspace in `active`, `failed`, or `cleanup_requested` may enter `held_for_investigation`.

The workspace is preserved. No cleanup or provider execution occurs.

### Release

A held workspace may return to `active` only when:

- the exact Workflow, child, attempt, workspace ownership, repository, mode, and branch still match;
- the operator supplies the authoritative child SHA;
- the server inspects actual Git HEAD and confirms the same SHA.

Release does not resume the Workflow or invoke an agent.

### Cleanup request

Cleanup may be requested only when:

- the exact child or Workflow is terminal;
- the current-attempt effect is not `claimed` or `needs_human`;
- the workspace is in an accepted requestable state.

The browser action changes only the durable record to `cleanup_requested`. It never runs physical workspace deletion. The existing server-owned cleanup worker remains responsible for `cleanup_requested → cleaning → released`.

## Browser workflow

The final investigation panel appears in:

- every Mission Room;
- the existing Needs Human Workflow control desk.

The panel provides:

- exact Workflow, child, effect, workspace, stage, owner, iteration, and attempt evidence;
- bounded legal-action suggestions;
- separate completed and safe-to-retry effect resolutions;
- workspace hold, verified release, and cleanup-request controls;
- explicit consequence confirmation;
- required operator reason;
- one retained request identity for uncertain browser delivery;
- accepted, replayed, rejected, audited, and uncertain-delivery presentation;
- affected Mission Room, Mission list, Needs Human, dashboard, Agent Fleet, and Workflow refresh.

Browser action visibility is advisory. Every mutation re-reads durable server authority.

## Security boundary

This slice does not:

- invoke Professor, Tokyo, or Berlin;
- replay a claimed or uncertain effect;
- automatically retry a stage;
- physically delete a workspace;
- mutate Git or GitHub;
- create, review, merge, release, or deploy a pull request;
- expose credentials, environment values, authenticated remotes, host paths, payload hashes, raw provider output, unrestricted logs, or private reasoning.

## Validation

Focused tests cover:

- blocking retry until explicit effect resolution;
- safe-to-retry resolution at exact input SHA;
- completed resolution at exact output SHA;
- real temporary Git workspace HEAD inspection;
- exact workspace hold and verified release;
- cleanup request without deletion;
- encoded route targeting and malformed encoding refusal;
- browser legal-action and role gating;
- retained idempotency identity;
- Mission Room and Needs Human integration;
- bounded public-data exclusions.

CI #278 passed:

- Ubuntu tests and dashboard build;
- Windows tests and dashboard build;
- OpenAB instances smoke;
- immutable release build and verification;
- required-check aggregation.
