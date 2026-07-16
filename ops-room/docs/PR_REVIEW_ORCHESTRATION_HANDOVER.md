# SHA-Aware PR Review Orchestration — Session Handover

**Prepared:** 2026-07-16  
**Repository:** `/home/ubuntu/openab-multi-agent/ops-room`  
**Feature branch:** `feat/sha-aware-pr-review-controller`  
**Remote:** `origin/feat/sha-aware-pr-review-controller`  
**Status:** implementation in progress; **do not open a draft PR yet**.

## Mission

Complete the production-safe SHA-aware PR review orchestration described in the Obsidian specification. The system must make a PR review/fix operation a durable, SHA-bound task rather than an ad-hoc PR-level loop.

Required core flow:

```text
new/synchronize PR event for SHA-A
→ canonical SHA-bound review task
→ validated structured review
→ optional, trusted-policy-approved SHA-A fix child task
→ fix worker fences SHA and pushes SHA-B
→ worker exits
→ a distinct SHA-B event creates the next review task
```

**Never** make the fixer recursively trigger another review. **Never** let a stale SHA post a review or push a change.

## Non-Negotiable Constraints

- Work directly in this repository. Do not edit the Obsidian specification as a substitute for implementation.
- Keep auto-fix opt-in. It requires an explicit trusted policy decision; it is never the default.
- Fence review side effects and fix pushes immediately before the external effect.
- Preserve the unrelated stash; do not apply, stage, or modify it:
  ```text
  stash@{0}: wip: runtime compose and generated ops-room data before PR-review push
  ```
- Do not touch unrelated Docker/runtime/generated-data work.
- Never write credentials/tokens/secrets to source, commits, logs, or handover documents.
- Do not create a draft PR until all remaining implementation and verification items below are complete.
- There is deliberately **no assistant-level scheduler/cron**. Product-level queue/reconciliation is still required.

## Current Verified State

At handover:

```text
Branch: feat/sha-aware-pr-review-controller
Latest commit: 1eef316 feat(ops-room): heartbeat active fix workers
Ahead of origin/main: 34 commits
Working tree: clean
npm test: 38 passed, 0 failed
```

The feature branch is pushed to origin.

## What Has Been Implemented

### Canonical review control plane

- Durable task store:
  - `src/services/review-task-store.mjs`
  - schema: `ops-room.review-task.v2`
  - deterministic task identity includes repository, PR, reviewed SHA, agent, and mode.
  - atomic creation/claims, state transitions, leases, renewal, cancellation, stale detection/recovery, task list/detail access.
- Canonical ingress controller:
  - `src/workflows/pr-review-controller.mjs`
  - validates current PR head before dispatch.
  - stale requested SHA becomes `SUPERSEDED`, with no model dispatch/status effect.
- Webhook ingress routes through the controller:
  - `src/routes/webhook-routes.mjs`
  - `src/server/http.mjs`
- Legacy direct review producers/poller paths were disabled earlier to avoid bypassing canonical task identity.

### Review safety

- Structured reviewer JSON validation:
  - `src/workflows/review-result.mjs`
  - `src/workflows/pr-review.mjs`
- The review workflow retries malformed model JSON once and only renders a validated result.
- Stale-SHA check occurs after PR context retrieval and immediately before review posting.
- Cooperative cancellation check occurs immediately before the review effect.
- Review outcomes preserve `SUPERSEDED`; they are not mapped incorrectly to human intervention.

### Policy and fix children

- Auto-fix policy:
  - `src/services/review-policy.mjs`
  - requires `auto-fix`, `allow_auto_fix`, trusted source, same-repository push capability, and only safe/non-critical/non-ambiguous findings.
- SHA-bound child task creator:
  - `src/workflows/fix-task-controller.mjs`
  - child identity is parent-linked and SHA-specific.
  - immutable `review_result`, selected `fix_agent`, and head ref are persisted on the child.
- Parent `REQUEST_CHANGES` creates/deduplicates the child task; it does not recursively run the legacy fix loop.

### Fix execution path

- Child lifecycle executor:
  - `src/workflows/fix-child-executor.mjs`
  - atomically claims child tasks and persists terminal outcomes.
- Fence-aware worker:
  - `src/workflows/fix-worker.mjs`
  - validates current head before workspace preparation and immediately before push;
  - checks durable cancellation before applying/pushing;
  - renews active lease and runs a one-minute heartbeat while workspace/model work runs;
  - cleans workspace in `finally`;
  - no source change → `NEEDS_HUMAN`;
  - successful push → `FIX_PUSHED` with actual new SHA.
- Concrete runtime adapter:
  - `src/workflows/fix-runtime.mjs`
  - uses the legacy workspace setup as a helper and makes structured-review-based AI file changes;
  - rejects path traversal, `.git`, environment/secret, and private-key paths;
  - pushes with force-with-lease.
- `src/server/http.mjs` directly dispatches a newly-created fix child using `setImmediate`; it does not rely on an assistant cron.
- Legacy `src/workflows/auto-fix.mjs` is now a compatibility implementation helper and has guaranteed cleanup, but it still remains in the repository and must be fully retired as an independent execution authority.

### Durable GitHub effects

File-backed effect ledger:

- `src/services/review-effect-ledger.mjs`

Currently guards:

1. `github_review` effects in `src/workflows/pr-review.mjs`.
2. `github_commit_status` effects in `src/services/github-review-status.mjs`.
3. `git_push` effects immediately before the fix worker pushes.

Important behavior:

- Completed duplicate push effect returns the recorded pushed SHA and does not push again.
- A previously `CLAIMED` push effect is treated as ambiguous and returns `NEEDS_HUMAN` rather than replaying the external effect.
- This ledger is conservative at-most-once behavior, not exactly-once behavior; `CLAIMED` effects require operator visibility/reconciliation rather than blind replay.

### Operator controls and recovery

- Stale task reconciliation:
  - `src/services/review-reconciler.mjs`
  - wired at server startup and every 60 seconds in `src/server/http.mjs`.
  - isolates corrupt task JSON instead of stopping healthy reconciliation.
- APIs (bearer-authenticated):
  ```text
  GET  /api/review-tasks?limit=50
  GET  /api/review-tasks/:taskId
  POST /api/review-tasks/:taskId/cancel
  ```
- Queued work cancels immediately; active work becomes `CANCEL_REQUESTED` and is cooperatively acknowledged by workers.

### LinkUp producer alignment

A separate LinkUp branch was updated and pushed:

```text
Repository: /home/ubuntu/LinkUp
Branch: agent/product-value-2026-07-15-correction-management-ui
Commit: 2800c3f fix(ci): exclude PR comments from issue commands
```

Change:

- `.github/workflows/openab-issue-command.yml` now excludes PR comments, preventing a PR `/openab` command from going through both the legacy generic issue-command workflow and the canonical SHA-aware PR workflow.
- The dedicated LinkUp PR-review workflow already supplies the required `head_sha` on its webhook paths. No payload-schema change was needed there.

## Remaining Work — Execute in This Order

### 1. Fully retire competing legacy fix/loop authority

**Goal:** only a claimed durable SHA-bound fix child can execute changes for this feature.

Inspect and change as needed:

- `src/workflows/auto-fix.mjs`
- `src/services/review-loop-store.mjs`
- remaining imports/call sites of `runAutoFixWorkflow`, review-loop helpers, and legacy polling paths.

Acceptance criteria:

- no independent production path can run the fixer without a claimed child task;
- no PR-level loop state governs the canonical PR-review/fix path;
- legacy helper code either becomes clearly scoped runtime support or is deleted only after all uses are removed;
- no recursive review/fix/review path remains.

Use:

```sh
search_files pattern='runAutoFixWorkflow|review-loop-store|updateReviewLoopState|needsReReview' path='src'
```

### 2. Complete durable queue/retry/fencing semantics

The current reconciler detects/reports stale work but does not safely re-dispatch within a bounded queue.

Implement:

- bounded global, per-repository, and per-PR concurrency;
- durable attempt count and retry budget/circuit-breaker;
- lease epoch / worker fencing enforcement on transitions and effects;
- safe reconciliation/re-dispatch for retry-eligible failed/stale tasks;
- operator pause, resume, and retry controls.

Do not use an agent-level scheduler. This belongs inside the product runtime/task dispatcher.

### 3. Finish external-effect coverage and reconciliation

Still missing or incomplete:

- ledger `github_issue_comment` for canonical chat response path;
- surface/reconcile ambiguous `CLAIMED` effects (review/comment/status/push) without blindly replaying them;
- effect/operator metrics and detail visibility;
- verify every actual status/comment/review/push write is awaited and followed by `completeEffect()` only on success.

Do **not** retrofit unrelated legacy issue-code comments unless they first gain durable canonical task identity.

### 4. Tests and failure injection

Add focused tests for at least:

- direct review → fix-child dispatch integration using fake runtime dependencies;
- cancellation during slow model/workspace execution;
- stale SHA immediately before side effects;
- concurrent duplicate dispatch / claim races;
- stale lease recovery and bounded re-dispatch;
- completed versus ambiguous `CLAIMED` effect behavior;
- queue bounds and per-PR ordering;
- LinkUp canonical webhook payload handling, including `task_type: chat` and `comment_id` preservation.

Run after cohesive changes:

```sh
cd /home/ubuntu/openab-multi-agent/ops-room
npm test
git diff --check
```

### 5. Final independent and live-safe verification

Before opening any PR:

1. Run full test suite and diff checks.
2. Independently review code/security/lifecycle behavior with a fresh context.
3. Use a safe sandbox/test PR to verify GitHub effects; do not test against an unrelated production PR.
4. Verify no stale SHA can post/push and no duplicate effect is emitted.
5. Verify LinkUp production workflow configuration/branch promotion separately; the LinkUp change is on a different branch and is not part of the Ops Room feature branch.
6. Only then create a **draft** PR for the Ops Room branch.

## Useful Commands

```sh
# Ops Room
cd /home/ubuntu/openab-multi-agent/ops-room
git status --short --branch
git log --oneline origin/main..HEAD
npm test
git diff --check

# Find remaining legacy authority
rg -n 'runAutoFixWorkflow|review-loop-store|updateReviewLoopState|needsReReview' src test

# Inspect durable task state (requires configured service auth for API calls)
# GET /api/review-tasks?limit=50
# GET /api/review-tasks/:taskId
# POST /api/review-tasks/:taskId/cancel
```

## Recent Commit Trail

```text
1eef316 feat(ops-room): heartbeat active fix workers
7a1c54c feat(ops-room): ledger SHA-fenced fix pushes
9d495e2 feat(ops-room): ledger review commit statuses
87f137d fix(ops-room): preserve canonical review task context
549e3ba feat(ops-room): dispatch SHA-fenced fix children
7ed0883 feat(ops-room): persist immutable fix child review context
7d27d6f feat(ops-room): add fix child lifecycle executor
b6b9ced fix(ops-room): guarantee legacy fixer cleanup
c8e77af feat(ops-room): add fenced fix child worker
77d5589 fix(ops-room): isolate corrupt review task records
```

## Known Risks / Do Not Misrepresent

- This branch is **not yet merge-ready**.
- Unit tests are passing but no full live GitHub sandbox verification has been performed for the new end-to-end fix path.
- The effect ledger is intentionally conservative. A process crash after an external service accepts an effect but before completion recording creates an ambiguous `CLAIMED` effect that needs operator reconciliation; it must not be auto-replayed.
- The legacy auto-fix/review-loop modules still exist. The next session must prove they have no competing execution authority before declaring the migration complete.
- The unrelated Docker/runtime stash remains protected and intentionally unexamined.
