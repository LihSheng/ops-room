# OPS-012F.2 — Workflow Recovery and Berlin Approval Controls

## Status

Implementation complete in PR #90. Final review readiness depends on the latest required CI run.

This slice exposes the accepted OPS-010G recovery contracts and bounded Berlin-decision authority through authenticated operator routes and visible browser controls. React remains a presentation layer; durable Workflow, provider-effect, workspace, idempotency, and audit stores remain authoritative.

## Routes

```text
POST /api/operator/workflows/:workflowId/children/:childId/retry
POST /api/operator/workflows/:workflowId/children/:childId/resume
POST /api/operator/workflows/:workflowId/children/:childId/decision
```

Workflow and child identifiers are URL-encoded by the browser and safely decoded by the route before the service revalidates them.

Every request targets one exact Workflow, child, and expected attempt and includes:

```json
{
  "reason": "Human-readable operator reason",
  "expected_attempt": 0,
  "idempotency_key": "client-stable-request-key"
}
```

The decision route additionally accepts only `approved` or `changes_requested`.

## Authorization

| Action | Permission | Session controls |
|---|---|---|
| Retry child | `workflow.recover` | CSRF |
| Resume pending child | `workflow.recover` | CSRF |
| Berlin decision | `workflow.approve` | CSRF + action-bound step-up confirmation |

For a session-backed decision request, confirmation is bound to the exact encoded method and path:

```text
confirm:workflow.approve:POST:/api/operator/workflows/<encoded-workflow-id>/children/<encoded-child-id>/decision
```

Legacy dashboard-token mode remains read only.

## Browser workflow

### Needs Human

The Needs Human page now contains:

- the existing review-task control desk;
- a Workflow control desk listing active and needs-human Missions;
- Mission selection with direct Mission Room navigation;
- bounded legal-action suggestions derived from current Mission Room evidence;
- exact-stage recovery and Berlin decision dialogs.

### Mission Room

Each Mission Room now includes a Workflow control panel before the activity feed and deterministic timeline. The panel displays:

- exact Workflow ID and child ID;
- iteration, stage, owner, and expected attempt;
- bounded stage, effect, and workspace states;
- only actions suggested by the current public evidence;
- role-aware button availability.

Browser gating is a usability aid only. The server re-reads and verifies every authority before mutation.

## Confirmation and uncertain delivery

Opening an action dialog creates one request identity. The dialog requires:

- a human-readable reason of at most 500 characters;
- acknowledgement of the exact consequence;
- the authenticated session CSRF token;
- step-up confirmation for Berlin decisions.

If the browser does not receive a definite server response, the dialog remains open and retains the same idempotency key. Retrying cannot duplicate an accepted transition.

After definite accepted or rejected responses, the browser invalidates:

- selected Mission Room;
- Mission list;
- Needs Human intervention evidence;
- dashboard metrics;
- Agent Fleet evidence;
- Workflow reads.

## Recovery authority

Retry composes `retryWorkflowChildAfterInvestigation`:

- Workflow and child must be `needs_human`;
- expected attempt must match;
- current-attempt provider effect must be terminal `failed` or `needs_human`;
- `claimed` and `completed` effects are refused;
- workspace ownership and exact HEAD are re-read;
- held workspace evidence is reactivated only after verification;
- attempt increments exactly once.

Resume composes `resumePendingWorkflowAfterInvestigation`:

- Workflow must be `needs_human` and child must remain pending;
- expected attempt must match;
- no current-attempt provider effect may exist;
- any bound workspace must remain active at the exact input SHA;
- attempt is not incremented.

Neither browser request invokes a provider.

## Berlin decision authority

The decision route accepts one completed Berlin review child only.

When a Workflow was escalated solely because review-decision evidence was missing, the operator contract may reactivate it before recording the decision. Other needs-human reasons remain blocked.

### Approved

The accepted `persistReviewDecision` contract records `approved`. Deterministic advancement completes the Workflow without calling Berlin or another provider.

### Changes requested

The accepted contract records `changes_requested` with bounded reason code `operator_changes_requested`.

- below the iteration limit, `ensureWorkflowChild` creates or reuses exactly one next-iteration Professor implementation child at the reviewed output SHA;
- at the iteration limit, advancement records `workflow_iteration_limit_exceeded`;
- the request never activates or executes the next child.

## Idempotency and audit

Every operation is bound to:

```text
actor + operation + workflow/child target + request key + payload
```

Identical retries replay the original response. Conflicting key reuse fails closed.

Accepted and rejected requests append actor-attributed audit evidence with Workflow/child IDs, stage, owner, attempt, decision, next-child ID when applicable, `provider_invoked: false`, and `uncertain_effect_replayed: false`.

## Explicit non-goals

This slice does not:

- invoke Professor, Tokyo, or Berlin;
- replay an uncertain provider effect;
- execute or activate a newly created iteration;
- mutate Git or GitHub;
- create, review, merge, release, or deploy a pull request;
- resolve ambiguous effects;
- provide workspace hold/release or cleanup controls beyond accepted recovery contracts;
- expose credentials, environment values, authenticated remotes, host paths, raw provider output, unrestricted logs, or private reasoning.

Effect resolution and general workspace investigation controls remain OPS-012F.3.

## Validation coverage

Focused tests cover:

- retry gating from terminal retryable effect plus inspectable workspace evidence;
- refusal of claimed effects and released workspaces;
- resume gating only when no current-attempt effect exists;
- unresolved completed Berlin review decisions;
- operator/reviewer/administrator permission separation;
- retained browser request-key generation;
- exact encoded route and action-bound approval confirmation;
- route decoding and malformed-encoding rejection;
- deterministic approval, next-iteration creation, iteration-limit escalation, recovery idempotency, and durable audit;
- Needs Human and Mission Room browser integration and bounded-data exclusions.
