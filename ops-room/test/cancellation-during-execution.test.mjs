import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrClaimTask, readTask, requestCancellation, transitionTask } from '../src/services/review-task-store.mjs';
import { assertReviewNotCancelled } from '../src/workflows/review-worker-guard.mjs';

test('cancellation during slow execution is cooperatively detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-slow-cancel-'));
  const { task } = await createOrClaimTask({
    dir,
    input: { repository: 'LihSheng/LinkUp', pr: 40, headSha: 'a'.repeat(40), agent: 'professor', mode: 'review' },
  });

  // Simulate task transitioning through to RUNNING
  await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test' });

  // While running, an operator cancels
  await requestCancellation({ dir, id: task.id, actor: 'operator', reason: 'test_cancel' });
  const cancelled = await readTask({ dir, id: task.id });
  assert.equal(cancelled.state, 'CANCEL_REQUESTED');

  // The worker guard should throw
  assert.throws(
    () => assertReviewNotCancelled(cancelled),
    { code: 'REVIEW_CANCELLED' },
  );
});

test('cancelled queued tasks transition directly to CANCELLED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-queued-cancel-'));
  const { task } = await createOrClaimTask({
    dir,
    input: { repository: 'LihSheng/LinkUp', pr: 40, headSha: 'a'.repeat(40), agent: 'professor', mode: 'review' },
  });

  // Cancel while still QUEUED — should go directly to CANCELLED
  const result = await requestCancellation({ dir, id: task.id, actor: 'operator', reason: 'test_cancel' });
  assert.equal(result.state, 'CANCELLED');

  // Verify terminal — cannot transition back
  const fresh = await readTask({ dir, id: task.id });
  assert.equal(fresh.state, 'CANCELLED');
});
