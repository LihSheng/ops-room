import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrClaimTask, readTask, transitionTask } from '../src/services/review-task-store.js';
import { reconcileReviewTasks, dispatchEligibleTasks } from '../src/services/review-reconciler.js';

const legacyReconcile = async () => ({ status: 'legacy_unbound', reason_code: 'legacy_task_without_workspace' });

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

test('dispatchEligibleTasks claims and dispatches queued review tasks within concurrency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task: q1 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/A', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });
  const { task: q2 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/B', pr: 1, headSha: 'b'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });

  assert.equal((await readTask({ dir, id: q1.id })).state, 'QUEUED');
  assert.equal((await readTask({ dir, id: q2.id })).state, 'QUEUED');

  const result = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result.dispatched, 2);
  assert.equal(result.tasks.length, 2);
  for (const t of result.tasks) {
    const current = await readTask({ dir, id: t.id });
    assert.equal(current.state, 'CLAIMED');
    assert.ok(current.lease);
  }
  const result2 = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result2.dispatched, 0);
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
  const result2 = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result2.dispatched, 1);
});
