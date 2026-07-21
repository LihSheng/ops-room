# OPS-010G — Recovery and Retry Hardening

Status: **Continuation slice**

Issue: #50

## Goal

Harden provider-backed deterministic advancement across restart, timeout, provider failure, workspace failure, and explicit retry without replaying uncertain work or duplicating provider effects.

## Recovery ordering

Startup reconciliation now runs in this order:

1. reconcile interrupted provider-effect claims to terminal `needs_human`;
2. reconcile active workflow children to `needs_human` with `workflow_child_interrupted`;
3. inspect exact durable provider-effect evidence for interrupted children;
4. recover a child automatically only when one exact completed effect exists;
5. verify the managed workspace HEAD equals the effect output SHA;
6. durably mark the child completed with a cleanup-pending marker;
7. request workspace cleanup;
8. clear the cleanup-pending marker and reactivate the workflow;
9. reconcile Berlin decision evidence when the recovered child is a review stage.

No provider process is invoked during recovery.

## Completed-effect recovery

An interrupted child is recovered automatically only when all of the following match:

- workflow ID;
- child ID;
- authorized provider/stage effect type;
- current child attempt key;
- terminal effect state `completed`;
- exact 40-character effect output SHA;
- expected result code (`ok` for writable stages, bounded Berlin decision evidence for review);
- workspace identity, owner, repository, mode, and branch;
- actual workspace HEAD.

Writable-stage workspace HEAD must equal the completed effect output SHA. Review output must equal the immutable review input SHA.

Missing, conflicting, ambiguous, non-terminal, or SHA-mismatched evidence remains `needs_human`.

## Two-phase cleanup recovery

Recovered completion and cleanup are separate durable steps.

The child first records:

```text
state = completed
recovery_cleanup_pending = true
```

The parent remains `needs_human` with:

```text
workflow_recovery_cleanup_pending
```

Only after workspace cleanup is requested does the reconciler clear the marker and return the workflow to `active`.

A crash between completion recovery and cleanup therefore cannot advance the next stage while the previous workspace still owns its branch.

## Explicit retry after investigation

A `needs_human` child may be retried only through the internal explicit retry function and only when:

- the caller supplies the exact expected attempt;
- the workflow and child are still `needs_human` at that attempt;
- exactly one matching current-attempt provider effect exists;
- the prior effect is terminal `failed` or `needs_human`;
- the prior effect is not `claimed` or `completed`;
- the managed workspace is active or held for investigation;
- actual workspace HEAD still equals the child's immutable input SHA.

The clean-HEAD requirement prevents a retry after a timed-out or malformed provider may have already changed the workspace. Such cases remain held for manual investigation.

A successful retry:

- reactivates a held workspace;
- increments the child attempt exactly once;
- creates a new provider-effect identity through the new attempt key;
- returns the child to `pending`;
- returns the workflow to `active`.

Repeating the same retry request with the old expected attempt is idempotent and does not increment again.

## Interrupted uncertain effects

An effect left `claimed` at restart is first reconciled to:

```text
state = needs_human
result_code = workflow_effect_interrupted
```

It is never retried automatically.

An operator may explicitly retry only after confirming the workspace HEAD still equals the original input SHA. The new attempt receives a new durable effect identity.

## Pre-provider workspace failures

If deterministic advancement failed while the child remained `pending` and no provider effect exists for the current attempt, the workflow can be explicitly resumed after the workspace problem is corrected.

This path does not increment the attempt because the provider was never invoked. It refuses to resume if any current-attempt provider effect exists.

## Startup diagnostics

Startup emits bounded counts for:

- children recovered from completed effects;
- recovered cleanup requests;
- Berlin decisions reconciled;
- workflow recovery records still requiring investigation.

Logs contain no prompts, provider output, credentials, remotes, environment values, or host workspace paths.

## Tests

Focused coverage includes:

- completed-effect recovery with exact SHA verification;
- cleanup interruption and restart-safe completion;
- provider timeout retry;
- interrupted-effect retry after terminal reconciliation;
- workspace mutation rejection before retry;
- completed-effect retry prohibition;
- idempotent retry attempt increments;
- pre-provider workspace failure resume;
- refusal to resume when a provider effect already exists.

## Remaining OPS-010G gate

After this slice:

1. complete review findings and merge;
2. build and deploy one immutable release from the exact merge commit;
3. run the controlled end-to-end production workflow drill;
4. exercise restart, timeout, explicit retry, provider failure, workspace failure, and duplicate-call scenarios;
5. close OPS-010G only after production evidence confirms no duplicated effects or workspace ownership violations.
