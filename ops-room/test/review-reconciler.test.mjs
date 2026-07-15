import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claimTask, createOrClaimTask, readTask, transitionTask } from '../src/services/review-task-store.mjs';
import { reconcileReviewTasks } from '../src/services/review-reconciler.mjs';

test('reconciler recovers expired active review tasks and ignores queued work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-reconciler-'));
  const { task: stale } = await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' } });
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
