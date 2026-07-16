import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrClaimTask, requestCancellation, transitionTask } from '../src/services/review-task-store.mjs';

test('queued work is cancelled immediately without waiting for a worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-cancel-'));
  const { task } = await createOrClaimTask({
    dir,
    input: { repository: 'LihSheng/LinkUp', pr: 42, headSha: 'b'.repeat(40), agent: 'professor', mode: 'review' },
  });
  const cancelled = await requestCancellation({ dir, id: task.id, actor: 'operator', reason: 'obsolete' });
  assert.equal(cancelled.state, 'CANCELLED');
});

test('cancellation is cooperative and terminal once acknowledged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-cancel-'));
  const { task } = await createOrClaimTask({
    dir,
    input: {
      repository: 'LihSheng/LinkUp', pr: 40, headSha: 'a'.repeat(40), agent: 'professor', mode: 'review',
    },
    trigger: 'manual',
  });
  await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test' });

  const requested = await requestCancellation({ dir, id: task.id, actor: 'maintainer', reason: 'stop now' });
  assert.equal(requested.state, 'CANCEL_REQUESTED');
  assert.equal(requested.cancellation.actor, 'maintainer');

  const cancelled = await transitionTask({ dir, id: task.id, to: 'CANCELLED', reason: 'worker_acknowledged_cancellation' });
  assert.equal(cancelled.state, 'CANCELLED');
  await assert.rejects(
    () => transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'invalid' }),
    /Invalid task transition/,
  );
});
