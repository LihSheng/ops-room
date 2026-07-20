import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrClaimTask, readTask, transitionTask } from '../src/services/review-task-store.js';
import { reconcileReviewTasks, dispatchEligibleTasks } from '../src/services/review-reconciler.js';

const legacyReconcile = async () => ({ status: 'legacy_unbound', reason_code: 'legacy_task_without_workspace' });

function emptyOutcomeFields() {
  return { workspace_outcomes: [], workspace_outcome_errors: [] };
}

test('reconciler recovers expired active review tasks and reports legacy unbound work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task: stale } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' } });
  const { claimTask } = await import('../src/services/review-task-store.js');
  await claimTask({ dir, id: stale.id, instanceId: 'old', leaseId: 'old' });
  await transitionTask({ dir, id: stale.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: stale.id, to: 'RUNNING', reason: 'test' });
  await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 2, headSha: 'b'.repeat(40), agent: 'professor' } });

  const result = await reconcileReviewTasks({
    dir,
    now: '2030-01-01T00:31:00.000Z',
    reconcileWorkspace: legacyReconcile,
  });
  assert.deepEqual(result, {
    scanned: 2,
    recovered: [stale.id],
    re_dispatched: [stale.id],
    corrupt: [],
    workspace_blocked: [],
    legacy_unbound: [stale.id],
    ...emptyOutcomeFields(),
  });
  assert.equal((await readTask({ dir, id: stale.id })).state, 'QUEUED');
});

test('reconciler isolates corrupt task records instead of aborting a cycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  await writeFile(join(dir, 'corrupt.json'), '{ definitely not json');
  const result = await reconcileReviewTasks({ dir, reconcileWorkspace: legacyReconcile });
  assert.deepEqual(result, {
    scanned: 1,
    recovered: [],
    re_dispatched: [],
    corrupt: ['corrupt'],
    workspace_blocked: [],
    legacy_unbound: [],
    ...emptyOutcomeFields(),
  });
});

test('workspace mismatch blocks stale recovery and routes task to human review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 3, headSha: 'c'.repeat(40), agent: 'professor' } });
  const { claimTask } = await import('../src/services/review-task-store.js');
  await claimTask({ dir, id: task.id, instanceId: 'old', leaseId: 'old' });
  await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test' });

  const result = await reconcileReviewTasks({
    dir,
    reconcileWorkspace: async () => ({ status: 'blocked', reason_code: 'workspace_directory_missing' }),
  });
  assert.deepEqual(result.workspace_blocked, [{ task_id: task.id, reason_code: 'workspace_directory_missing' }]);
  assert.equal((await readTask({ dir, id: task.id })).state, 'NEEDS_HUMAN');
});

test('terminal tasks reconcile cleanup or investigation hold idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 4, headSha: 'd'.repeat(40), agent: 'berlin' } });
  const { claimTask } = await import('../src/services/review-task-store.js');
  await claimTask({ dir, id: task.id, instanceId: 'worker', leaseId: 'lease' });
  await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test', patch: { workspace_id: 'task-1' } });
  await transitionTask({ dir, id: task.id, to: 'PASSED', reason: 'test' });

  const result = await reconcileReviewTasks({
    dir,
    applyWorkspaceOutcome: async ({ task: value }) => ({ action: value.state === 'PASSED' ? 'cleanup' : 'hold', idempotent: true }),
  });
  assert.deepEqual(result.workspace_outcomes, [{ task_id: task.id, action: 'cleanup', idempotent: true }]);
  assert.deepEqual(result.workspace_outcome_errors, []);
});

test('dispatchEligibleTasks claims and dispatches queued review tasks within concurrency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task: q1 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/A', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });
  const { task: q2 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/B', pr: 1, headSha: 'b'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });
  const result = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result.dispatched, 2);
  for (const t of result.tasks) {
    const current = await readTask({ dir, id: t.id });
    assert.equal(current.state, 'CLAIMED');
    assert.ok(current.lease);
  }
  assert.equal((await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' })).dispatched, 0);
});

test('dispatchEligibleTasks respects per-PR concurrency limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  await createOrClaimTask({ dir, input: { repository: 'LihSheng/X', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });
  await createOrClaimTask({ dir, input: { repository: 'LihSheng/X', pr: 1, headSha: 'b'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });
  const result = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result.dispatched, 1);
  const claimed = await readTask({ dir, id: result.tasks[0].id });
  await transitionTask({ dir, id: claimed.id, to: 'RUNNING', reason: 'test' });
  await transitionTask({ dir, id: claimed.id, to: 'PASSED', reason: 'test' });
  assert.equal((await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' })).dispatched, 1);
});
