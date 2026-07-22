import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleOperatorTaskCancellation } from '../src/routes/operator-tasks.js';
import { listAuditEvents } from '../src/services/audit-log.js';
import { createOrClaimTask, readTask, transitionTask } from '../src/services/review-task-store.js';
const actor = {
    actor_type: 'human_operator',
    actor_id: 'lihsheng',
    actor_display_name: 'Lih Sheng',
    auth_method: 'operator_token',
};
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-'));
    return {
        reviewTasksDir: join(root, 'review-tasks'),
        auditDir: join(root, 'audit'),
        idempotencyDir: join(root, 'idempotency'),
    };
}
async function createTask(reviewTasksDir, sha = 'a'.repeat(40)) {
    return (await createOrClaimTask({
        dir: reviewTasksDir,
        input: {
            repository: 'LihSheng/LinkUp',
            pr: 42,
            headSha: sha,
            agent: 'professor',
            mode: 'review',
        },
    })).task;
}
test('concurrent identical cancellation requests perform one transition and one accepted audit event', async () => {
    const dirs = await fixture();
    const task = await createTask(dirs.reviewTasksDir);
    const request = {
        taskId: task.id,
        body: { reason: 'Stop duplicate work', idempotency_key: 'cancel-task-42' },
        actor,
        ...dirs,
    };
    const results = await Promise.all([
        handleOperatorTaskCancellation(request),
        handleOperatorTaskCancellation(request),
    ]);
    assert.deepEqual(results.map((result) => result.status), [202, 202]);
    assert.deepEqual(results.map((result) => result.body.idempotent_replay).sort(), [false, true]);
    const stored = await readTask({ dir: dirs.reviewTasksDir, id: task.id });
    assert.equal(stored.state, 'CANCELLED');
    assert.equal(stored.history.filter((entry) => entry.to === 'CANCELLED').length, 1);
    const events = await listAuditEvents({ dir: dirs.auditDir });
    assert.equal(events.filter((event) => event.outcome === 'accepted').length, 1);
    assert.equal(events[0].actor.actor_id, 'lihsheng');
});
test('same idempotency key with changed payload is rejected without another transition', async () => {
    const dirs = await fixture();
    const task = await createTask(dirs.reviewTasksDir, 'b'.repeat(40));
    const first = await handleOperatorTaskCancellation({
        taskId: task.id,
        body: { reason: 'No longer needed', idempotency_key: 'same-key-0001' },
        actor,
        ...dirs,
    });
    const conflict = await handleOperatorTaskCancellation({
        taskId: task.id,
        body: { reason: 'Different reason', idempotency_key: 'same-key-0001' },
        actor,
        ...dirs,
    });
    assert.equal(first.status, 202);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error_code, 'IDEMPOTENCY_CONFLICT');
    const stored = await readTask({ dir: dirs.reviewTasksDir, id: task.id });
    assert.equal(stored.history.filter((entry) => entry.to === 'CANCELLED').length, 1);
});
test('unknown tasks and invalid transitions create rejected audit events', async () => {
    const dirs = await fixture();
    const missing = await handleOperatorTaskCancellation({
        taskId: 'missing-task',
        body: { reason: 'Cancel missing work', idempotency_key: 'missing-task-001' },
        actor,
        ...dirs,
    });
    assert.equal(missing.status, 404);
    assert.ok(missing.body.audit_event_id);
    const task = await createTask(dirs.reviewTasksDir, 'c'.repeat(40));
    await transitionTask({ dir: dirs.reviewTasksDir, id: task.id, to: 'CLAIMED', reason: 'test' });
    await transitionTask({ dir: dirs.reviewTasksDir, id: task.id, to: 'RUNNING', reason: 'test' });
    await transitionTask({ dir: dirs.reviewTasksDir, id: task.id, to: 'PASSED', reason: 'test' });
    const invalid = await handleOperatorTaskCancellation({
        taskId: task.id,
        body: { reason: 'Too late', idempotency_key: 'terminal-task-01' },
        actor,
        ...dirs,
    });
    assert.equal(invalid.status, 409);
    assert.ok(invalid.body.audit_event_id);
    const events = await listAuditEvents({ dir: dirs.auditDir, outcome: 'rejected' });
    assert.equal(events.length, 2);
    assert.deepEqual(new Set(events.map((event) => event.error_code)), new Set(['task_not_found', 'invalid_transition']));
});
test('missing reason and idempotency key are rejected and audited', async () => {
    const dirs = await fixture();
    const task = await createTask(dirs.reviewTasksDir, 'd'.repeat(40));
    const result = await handleOperatorTaskCancellation({ taskId: task.id, body: {}, actor, ...dirs });
    assert.equal(result.status, 400);
    assert.equal(result.body.error_code, 'invalid_request');
    const events = await listAuditEvents({ dir: dirs.auditDir });
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'rejected');
});
//# sourceMappingURL=operator-cancellation.test.js.map