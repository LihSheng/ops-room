# OPS-010G — Provider-Backed Advancement and Berlin Decision Recovery

Status: **Continuation slice**

Issue: #50

## Goal

Connect the merged deterministic advancement coordinator to the real OPS-010F provider-effect boundary while preserving no-replay restart behavior.

## Delivered in this slice

- A review-aware stage runner delegates implementation, test, and integration to the existing OPS-010F stage runner.
- Berlin review uses the same profile-backed provider adapter, credential isolation, timeout, cancellation, and durable effect claim boundary.
- Berlin must return one bounded decision: `approved` or `changes_requested`.
- The exact review output SHA and decision are persisted together in the existing provider effect record.
- Decision evidence is encoded in the bounded terminal `result_code`:
  - `review.approved`;
  - `review.changes_requested:<bounded_reason_code>`.
- Replaying a completed Berlin effect reconstructs the same decision without invoking the provider again.
- A completed review effect from an older runner that lacks decision evidence fails closed and is never replayed.
- The provider-backed advancement entry point composes the fixed coordinator, OPS-010E explicit child execution, profile-backed adapters, and OPS-010F effect fencing.
- Restart reconciliation can recover a completed review child whose effect is durable but whose workflow decision write was interrupted.

## Recovery ordering

```text
provider effect completed with SHA + Berlin decision
        ↓
workflow review child completed at exact SHA
        ↓ process interruption may occur here
review-decision reconciler reads durable effect evidence
        ↓
persist bounded decision on workflow child
        ↓
coordinator completes workflow or creates next iteration
```

The reconciler never invokes Berlin. Missing, conflicting, non-terminal, wrong-attempt, or SHA-mismatched effect evidence is treated as unavailable and the existing coordinator escalates rather than guessing.

## Result contract

Approved review:

```json
{"outcome":"completed","output_sha":"<exact input SHA>","review_decision":"approved"}
```

Changes requested:

```json
{"outcome":"completed","output_sha":"<exact input SHA>","review_decision":"changes_requested","review_reason":"<bounded_reason_code>"}
```

Needs human:

```json
{"outcome":"needs_human","reason":"<bounded_reason_code>"}
```

Raw review prose, provider stdout, stderr, credentials, environment values, remotes, and host paths are not persisted as decision evidence.

## Duplicate prevention

- The workflow advancement lock serializes progression.
- OPS-010E serializes explicit child execution.
- OPS-010F claims the Berlin provider effect by workflow, child, effect type, and attempt.
- The review-decision reconciliation lock serializes interrupted decision recovery.
- Deterministic child IDs and exact dependency SHAs prevent duplicate stage creation.

## Tests

Focused coverage includes:

- strict Berlin decision parsing;
- durable approved and changes-requested effect evidence;
- completed-effect replay without a second provider invocation;
- non-review delegation to the existing OPS-010F runner;
- provider-backed implementation → test → integration → review → completion;
- exact effect-based decision resolution;
- restart recovery between review-child completion and workflow-decision persistence;
- no Berlin replay after restart;
- terminal advancement deduplication.

## Remaining OPS-010G work

- integration tests for timeout, provider failure, workspace failure, retry, and interrupted child execution through the provider-backed coordinator;
- bounded operational diagnostics for provider-backed advancement and reconciliation;
- full regression review and immutable deployment;
- separate final end-to-end production workflow drill.
