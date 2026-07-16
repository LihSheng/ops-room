import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrClaimTask, readTask, transitionTask } from '../src/services/review-task-store.mjs';
import { reconcileReviewTasks, dispatchEligibleTasks } from '../src/services/review-reconciler.mjs';

test('reconciler recovers expired active review tasks and ignores queued work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task: stale } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' } });
  const { claimTask } = await import('../src/services/review-task-store.mjs');
  await claimTask({ dir, id: stale.id, instanceId: 'old', leaseId: 'old' });
  await transitionTask({ dir, id: stale.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: stale.id, to: 'RUNNING', reason: 'test' });
  await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 2, headSha: 'b'.repeat(40), agent: 'professor' } });

  const result = await reconcileReviewTasks({ dir, now: '2030-01-01T00:31:00.000Z' });
  assert.deepEqual(result, { scanned: 2, recovered: [stale.id], re_dispatched: [stale.id], corrupt: [] });
  assert.equal((await readTask({ dir, id: stale.id })).state, 'QUEUED');
});

test('reconciler isolates corrupt task records instead of aborting a cycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  await writeFile(join(dir, 'corrupt.json'), '{ definitely not json');
  const result = await reconcileReviewTasks({ dir });
  assert.deepEqual(result, { scanned: 1, recovered: [], re_dispatched: [], corrupt: ['corrupt'] });
});

test('dispatchEligibleTasks claims and dispatches queued review tasks within concurrency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task: q1 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/A', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });
  const { task: q2 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/B', pr: 1, headSha: 'b'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });

  // Both are QUEUED initially
  assert.equal((await readTask({ dir, id: q1.id })).state, 'QUEUED');
  assert.equal((await readTask({ dir, id: q2.id })).state, 'QUEUED');

  const result = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result.dispatched, 2, 'both queued tasks should be dispatched');
  assert.equal(result.tasks.length, 2);

  // Both should now be RUNNING
  for (const t of result.tasks) {
    const current = await readTask({ dir, id: t.id });
    assert.equal(current.state, 'RUNNING');
    assert.ok(current.lease, 'task should have a lease');
  }

  // Re-running dispatch should find nothing new
  const result2 = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result2.dispatched, 0);
});

test('dispatchEligibleTasks respects per-PR concurrency limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  // Create two tasks for the same PR
  const { task: a1 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/X', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });
  const { task: a2 } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/X', pr: 1, headSha: 'b'.repeat(40), agent: 'professor' }, trigger: 'pull_request' });

  // First dispatch: only one should be claimed (per-PR limit = 1)
  const result = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result.dispatched, 1, 'only one task should dispatch with per-PR limit of 1');

  // Complete the first one
  const running = await readTask({ dir, id: result.tasks[0].id });
  await transitionTask({ dir, id: running.id, to: 'PASSED', reason: 'test' });

  // Second dispatch: the other should now be claimed
  const result2 = await dispatchEligibleTasks({ dir, instanceId: 'test-dispatcher' });
  assert.equal(result2.dispatched, 1, 'second task should dispatch after first completed');
});
