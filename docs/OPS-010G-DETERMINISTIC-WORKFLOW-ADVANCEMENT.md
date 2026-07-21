# OPS-010G — Deterministic Workflow Advancement

Status: **Foundation implementation in draft PR**

Issue: #50

## Goal

Advance the existing fixed `feature-development` workflow without introducing a general workflow engine or weakening the OPS-009 workspace, OPS-010E execution, and OPS-010F effect-fencing boundaries.

The fixed graph remains:

```text
Professor implementation
        ↓ exact output SHA
Tokyo test development
        ↓ exact output SHA
Professor integration
        ↓ exact output SHA
Berlin exact-SHA review
        ↓
approved          changes_requested
   ↓                       ↓
complete          next implementation iteration
```

## Foundation delivered in this slice

`workflow-advancement.ts` adds one internal coordinator that:

- acquires a deterministic cross-process workflow advancement lock;
- reads only durable workflow state before selecting the next action;
- creates at most one deterministic next child;
- propagates the exact completed dependency output SHA into the new child input SHA;
- executes only an already-pending eligible child through an injected OPS-010E/OPS-010F executor;
- persists bounded Berlin `approved` or `changes_requested` evidence;
- completes the workflow after approval;
- creates the next implementation iteration after changes are requested;
- escalates to `needs_human` when the maximum iteration policy is reached;
- escalates instead of replaying Berlin when review-decision evidence is missing;
- converges repeated and concurrent advancement calls without duplicate child execution;
- bounds the number of coordinator steps and fails closed on ambiguous active or pending children.

## Deterministic planning rules

For every durable run snapshot, the coordinator selects exactly one action:

| Durable state | Action |
|---|---|
| Run already terminal | Return terminal state without execution |
| Failed or needs-human child | Escalate the workflow |
| One active child | Wait; do not start another child |
| More than one active or pending child | Escalate as ambiguous |
| One pending child | Execute that exact child |
| No children | Create iteration 1 implementation from `source_sha` |
| Completed implementation/test/integration | Create the fixed next stage from exact `output_sha` |
| Completed review + `approved` | Complete workflow |
| Completed review + `changes_requested` | Create next iteration implementation from reviewed SHA |
| Changes requested at `max_iterations` | Escalate to `needs_human` |
| Completed review without durable decision | Escalate; never replay uncertain review work |

## Berlin decision evidence

The foundation persists only bounded decision evidence:

```text
approved
changes_requested
```

An optional bounded reason code may accompany `changes_requested`. Raw provider output, review prose, credentials, environment values, host paths, and Git output are not persisted by the coordinator.

A repeated decision with identical evidence is idempotent. Conflicting decision evidence fails closed.

## Locking and duplicate prevention

The advancement lock is deterministic from the workflow ID and stored beneath the workflow-run directory. It serializes concurrent coordinator calls across processes.

This lock does not replace lower-level fencing:

- OPS-010E still serializes and durably activates one child execution;
- OPS-010F still claims each provider effect before invocation;
- OPS-009 remains authoritative for workspace allocation, ownership, branch safety, and cleanup.

The layers compose so that a repeated advancement request may re-read terminal evidence, but it cannot create a second child with the same deterministic identity or execute the same provider effect twice.

## Tests in the foundation slice

Focused tests cover:

- implementation → test → integration → review → approval completion;
- changes-requested iteration followed by approval;
- maximum-iteration escalation;
- missing Berlin decision evidence without review replay;
- repeated calls after completion;
- concurrent advancement calls executing each stage once;
- exact dependency-SHA propagation between every stage and iteration.

## Remaining OPS-010G work

Before the epic can be completed:

1. Extend the concrete Berlin provider result contract with bounded decision evidence.
2. Persist that decision through the OPS-010F durable effect record so duplicate/restart replay returns the same decision without provider invocation.
3. Compose `advanceWorkflowRun` with `executeWorkflowChildWithProviders` in the production internal execution path.
4. Add interrupted-child, timeout, provider-failure, workspace failure, retry, and restart-reconciliation integration tests.
5. Add bounded operational logging and health/read-model evidence where required.
6. Complete review, merge, deploy one immutable release, and run the separate final end-to-end production workflow drill.

## Non-goals

OPS-010G does not add:

- arbitrary workflow graphs;
- automatic GitHub pull-request creation, review posting, merge, or deployment;
- a browser or public HTTP mutation endpoint;
- automatic replay of uncertain external effects;
- changes to agent lifecycle control;
- PostgreSQL authority;
- weaker workspace, exact-SHA, credential, or provider-process boundaries.
