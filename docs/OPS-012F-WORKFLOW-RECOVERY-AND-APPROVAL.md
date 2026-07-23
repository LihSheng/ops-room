# OPS-012F.2 — Workflow Recovery and Berlin Approval Controls

## Status

Initial server-authority slice for issue #87.

This slice exposes existing OPS-010G recovery contracts and a bounded operator Berlin-decision contract through authenticated operator routes. Browser presentation remains the next commit in the same work item.

## Routes

```text
POST /api/operator/workflows/:workflowId/children/:childId/retry
POST /api/operator/workflows/:workflowId/children/:childId/resume
POST /api/operator/workflows/:workflowId/children/:childId/decision
```

Every request targets one exact Workflow, child, and expected attempt.

Common body:

```json
{
  "reason": "Human-readable operator reason",
  "expected_attempt": 0,
  "idempotency_key": "client-stable-request-key"
}
```

The decision route additionally requires:

```json
{
  "decision": "approved"
}
```

or:

```json
{
  "decision": "changes_requested"
}
```

## Authorization

| Action | Permission | Session controls |
|---|---|---|
| Retry child | `workflow.recover` | CSRF |
| Resume pending child | `workflow.recover` | CSRF |
| Berlin decision | `workflow.approve` | CSRF + action-bound step-up confirmation |

For a session-backed approval request, the confirmation value is bound to the exact method and path:

```text
confirm:workflow.approve:POST:/api/operator/workflows/<workflowId>/children/<childId>/decision
```

The existing dedicated operator bearer remains supported by the V1-compatible authorization boundary. Legacy dashboard-token mode remains read only.

## Recovery authority

Retry composes `retryWorkflowChildAfterInvestigation`:

- Workflow and child must be `needs_human`;
- the expected attempt must match;
- the current-attempt provider effect must be terminal `failed` or `needs_human`;
- `claimed` and `completed` effects are refused;
- workspace ownership and exact HEAD are re-read;
- held workspace evidence is reactivated only after verification;
- the attempt increments exactly once.

Resume composes `resumePendingWorkflowAfterInvestigation`:

- Workflow must be `needs_human` and child must remain pending;
- the expected attempt must match;
- no current-attempt provider effect may exist;
- any bound workspace must remain active at the exact input SHA;
- the attempt is not incremented.

Neither route invokes a provider.

## Berlin decision authority

The decision route accepts one completed Berlin review child only.

When the Workflow was escalated solely because review-decision evidence was missing, the operator contract may reactivate it before recording the decision. Other needs-human reasons remain blocked.

### Approved

The accepted `persistReviewDecision` contract records `approved`. The deterministic advancement planner must then report `complete`; the existing advancement authority completes the Workflow without calling an execution provider.

### Changes requested

The accepted `persistReviewDecision` contract records `changes_requested` with the bounded reason code `operator_changes_requested`.

- below the iteration limit, the accepted `ensureWorkflowChild` contract creates or reuses exactly one next-iteration Professor implementation child at the reviewed output SHA;
- at the iteration limit, the existing advancement authority records `workflow_iteration_limit_exceeded`;
- the browser request never activates or executes the next child.

## Idempotency and audit

Every operation is bound to:

```text
actor + operation + workflow/child target + request key + payload
```

An identical retry replays the original response. Conflicting key reuse fails closed.

Accepted and rejected requests append actor-attributed audit evidence with:

- Workflow and child IDs;
- stage and owner;
- expected and resulting attempt;
- decision and next-child ID when applicable;
- `provider_invoked: false`;
- `uncertain_effect_replayed: false`.

## Explicit non-goals

This slice does not:

- invoke Professor, Tokyo, or Berlin;
- replay an uncertain provider effect;
- execute or activate a newly created iteration;
- mutate Git or GitHub;
- create, review, merge, release, or deploy a pull request;
- resolve ambiguous effects or mutate workspace cleanup state beyond the accepted OPS-010G recovery contracts;
- expose credentials, environment values, authenticated remotes, host paths, raw provider output, unrestricted logs, or private reasoning.

## Remaining OPS-012F.2 work

- add typed dashboard client contracts;
- add legal-action derivation from bounded Workflow/Mission Room evidence;
- add deliberate confirmation dialogs with retained request keys for uncertain delivery;
- integrate controls into Needs Human and Mission Room;
- add query invalidation and browser error presentation;
- complete cross-platform CI and immutable release verification.
