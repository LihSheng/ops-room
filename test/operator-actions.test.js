import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleOperatorTaskPause, handleOperatorTaskResume, handleOperatorTaskRetry, } from '../src/routes/operator-tasks.js';
import { listAuditEvents } from '../src/services/audit-log.js';
import { createOrClaimTask, readTask, transitionTask, } from '../src/services/review-task-store.js';
const actor = {
    actor_type: 'human_operator',
    actor_id: 'lihsheng',
    actor_display_name: 'Lih Sheng',
    auth_method: 'operator_token',
};
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-actions-'));
    return {
        reviewTasksDir: join(root, 'review-tasks'),
        auditDir: join(root, 'audit'),
        idempotencyDir: join(root, 'idempotency'),
    };
}
async function createReviewTask(reviewTasksDir, sha = 'a'.repeat(40), policy = {}) {
    return (await createOrClaimTask({
        dir: reviewTasksDir,
        input: {
            repository: 'LihSheng/ops-room',
            pr: 42,
            headSha: sha,
            agent: 'berlin',
            mode: 'review',
        },
        policy,
    })).task;
}
async function createFixTask(reviewTasksDir, sha = 'b'.repeat(40), policy = {}) {
    return (await createOrClaimTask({
        dir: reviewTasksDir,
        kind: 'fix',
        parentTaskId: 'parent-review-task',
        input: {
            repository: 'LihSheng/ops-room',
            pr: 42,
            reviewedSha: sha,
            agent: 'professor',
            mode: 'fix',
        },
        policy,
    })).task;
}
async function toError(reviewTasksDir, task) {
    await transitionTask({ dir: reviewTasksDir, id: task.id, to: 'CLAIMED', reason: 'test' });
    await transitionTask({ dir: reviewTasksDir, id: task.id, to: task.kind === 'fix' ? 'FIXING' : 'RUNNING', reason: 'test' });
    return transitionTask({ dir: reviewTasksDir, id: task.id, to: 'ERROR', reason: 'test_failure', patch: { error: 'boom' } });
}
test('retry is audited, idempotent, bounded, and dispatches only once', async () => {
    const dirs = await fixture();
    const task = await createReviewTask(dirs.reviewTasksDir);
    await toError(dirs.reviewTasksDir, task);
    const request = {
        taskId: task.id,
        body: { reason: 'Retry after dependency recovery', idempotency_key: 'retry-review-0001' },
        actor,
        ...dirs,
    };
    const first = await handleOperatorTaskRetry(request);
    const replay = await handleOperatorTaskRetry(request);
    assert.equal(first.status, 202);
    assert.equal(first.body.operation, 'task.retry');
    assert.equal(first.body.task.state, 'QUEUED');
    assert.equal(first.body.task.attempt, 1);
    assert.equal(first.body.idempotent_replay, false);
    assert.equal(first.dispatch, true);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(replay.dispatch, false);
    assert.equal(replay.body.audit_event_id, first.body.audit_event_id);
    const stored = await readTask({ dir: dirs.reviewTasksDir, id: task.id });
    assert.equal(stored.state, 'QUEUED');
    assert.equal(stored.attempt, 1);
    assert.equal(stored.error, null);
    assert.equal(stored.last_operator_action.operation, 'retry');
    assert.equal(stored.last_operator_action.reason, 'Retry after dependency recovery');
    assert.equal(stored.history.filter((entry) => entry.reason === 'operator_retry').length, 1);
    const events = await listAuditEvents({ dir: dirs.auditDir, operation: 'task.retry' });
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'accepted');
    assert.equal(events[0].previous_state, 'ERROR');
    assert.equal(events[0].resulting_state, 'QUEUED');
    assert.equal(events[0].metadata.dispatch_requested, true);
});
test('pause and resume preserve human reasons while using stable transition labels', async () => {
    const dirs = await fixture();
    const task = await createReviewTask(dirs.reviewTasksDir, 'c'.repeat(40));
    const paused = await handleOperatorTaskPause({
        taskId: task.id,
        body: { reason: 'Wait for maintainer decision', idempotency_key: 'pause-review-0001' },
        actor,
        ...dirs,
    });
    assert.equal(paused.status, 202);
    assert.equal(paused.body.task.state, 'PAUSED');
    assert.equal(paused.dispatch, false);
    const resumed = await handleOperatorTaskResume({
        taskId: task.id,
        body: { reason: 'Maintainer approved continuation', idempotency_key: 'resume-review-001' },
        actor,
        ...dirs,
    });
    assert.equal(resumed.status, 202);
    assert.equal(resumed.body.task.state, 'QUEUED');
    assert.equal(resumed.dispatch, true);
    const stored = await readTask({ dir: dirs.reviewTasksDir, id: task.id });
    assert.equal(stored.pause_reason, null);
    assert.equal(stored.last_operator_action.operation, 'resume');
    assert.deepEqual(stored.history.slice(-2).map((entry) => entry.reason), ['operator_paused', 'operator_resumed']);
    const events = await listAuditEvents({ dir: dirs.auditDir });
    assert.deepEqual(events.map((event) => event.operation).sort(), ['task.pause', 'task.resume']);
    assert.ok(events.every((event) => event.outcome === 'accepted'));
});
test('concurrent different-key retries serialize and prevent duplicate transitions', async () => {
    const dirs = await fixture();
    const task = await createReviewTask(dirs.reviewTasksDir, 'd'.repeat(40));
    await toError(dirs.reviewTasksDir, task);
    const [left, right] = await Promise.all([
        handleOperatorTaskRetry({
            taskId: task.id,
            body: { reason: 'First retry', idempotency_key: 'retry-concurrent-a' },
            actor,
            ...dirs,
        }),
        handleOperatorTaskRetry({
            taskId: task.id,
            body: { reason: 'Second retry', idempotency_key: 'retry-concurrent-b' },
            actor,
            ...dirs,
        }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [202, 409]);
    assert.equal([left, right].filter((result) => result.dispatch).length, 1);
    const stored = await readTask({ dir: dirs.reviewTasksDir, id: task.id });
    assert.equal(stored.attempt, 1);
    assert.equal(stored.history.filter((entry) => entry.reason === 'operator_retry').length, 1);
    const events = await listAuditEvents({ dir: dirs.auditDir, operation: 'task.retry' });
    assert.equal(events.filter((event) => event.outcome === 'accepted').length, 1);
    assert.equal(events.filter((event) => event.outcome === 'rejected').length, 1);
    assert.equal(events.find((event) => event.outcome === 'rejected').error_code, 'invalid_transition');
});
test('retry budget exhaustion is rejected without changing task state', async () => {
    const dirs = await fixture();
    const task = await createReviewTask(dirs.reviewTasksDir, 'e'.repeat(40), { retry_budget: 0 });
    await toError(dirs.reviewTasksDir, task);
    const result = await handleOperatorTaskRetry({
        taskId: task.id,
        body: { reason: 'Try beyond approved budget', idempotency_key: 'retry-budget-0001' },
        actor,
        ...dirs,
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error_code, 'retry_budget_exhausted');
    assert.equal(result.dispatch, false);
    assert.equal((await readTask({ dir: dirs.reviewTasksDir, id: task.id })).state, 'ERROR');
    const events = await listAuditEvents({ dir: dirs.auditDir });
    assert.equal(events[0].outcome, 'rejected');
    assert.equal(events[0].error_code, 'retry_budget_exhausted');
});
test('fix-task retry and resume return to FIX_QUEUED', async () => {
    const dirs = await fixture();
    const retryTask = await createFixTask(dirs.reviewTasksDir, 'f'.repeat(40));
    await toError(dirs.reviewTasksDir, retryTask);
    const retried = await handleOperatorTaskRetry({
        taskId: retryTask.id,
        body: { reason: 'Retry failed fix', idempotency_key: 'retry-fix-task-01' },
        actor,
        ...dirs,
    });
    assert.equal(retried.body.task.state, 'FIX_QUEUED');
    const pauseTask = await createFixTask(dirs.reviewTasksDir, '1'.repeat(40));
    const paused = await handleOperatorTaskPause({
        taskId: pauseTask.id,
        body: { reason: 'Hold fix', idempotency_key: 'pause-fix-task-01' },
        actor,
        ...dirs,
    });
    assert.equal(paused.body.task.state, 'PAUSED');
    const resumed = await handleOperatorTaskResume({
        taskId: pauseTask.id,
        body: { reason: 'Continue fix', idempotency_key: 'resume-fix-task-1' },
        actor,
        ...dirs,
    });
    assert.equal(resumed.body.task.state, 'FIX_QUEUED');
});
test('invalid transitions and missing request fields are rejected and audited', async () => {
    const dirs = await fixture();
    const task = await createReviewTask(dirs.reviewTasksDir, '2'.repeat(40));
    const invalidRetry = await handleOperatorTaskRetry({
        taskId: task.id,
        body: { reason: 'Cannot retry queued work', idempotency_key: 'retry-invalid-001' },
        actor,
        ...dirs,
    });
    assert.equal(invalidRetry.status, 409);
    assert.equal(invalidRetry.body.error_code, 'invalid_transition');
    const missing = await handleOperatorTaskPause({ taskId: task.id, body: {}, actor, ...dirs });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error_code, 'invalid_request');
    const events = await listAuditEvents({ dir: dirs.auditDir, outcome: 'rejected' });
    assert.equal(events.length, 2);
});
//# sourceMappingURL=operator-actions.test.js.map