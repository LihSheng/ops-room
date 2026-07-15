import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildReviewTaskId,
  claimTask,
  createOrClaimTask,
  isClaimStale,
  readTask,
  renewClaim,
  transitionTask,
} from '../src/services/review-task-store.mjs';

test('review task identity is deterministic and changes when SHA or mode changes', () => {
  const input = {
    repository: 'LihSheng/LinkUp',
    pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe',
    agent: 'professor',
    mode: 'review',
  };

  assert.equal(buildReviewTaskId(input), buildReviewTaskId(input));
  assert.notEqual(
    buildReviewTaskId(input),
    buildReviewTaskId({ ...input, headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
  );
  assert.notEqual(buildReviewTaskId(input), buildReviewTaskId({ ...input, mode: 'auto-fix' }));
});

test('concurrent claims result in one creator and one duplicate response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-review-store-'));
  const input = {
    repository: 'LihSheng/LinkUp',
    pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe',
    agent: 'professor',
    mode: 'review',
  };

  const [first, second] = await Promise.all([
    createOrClaimTask({ dir, input, trigger: 'pull_request' }),
    createOrClaimTask({ dir, input, trigger: 'pull_request' }),
  ]);

  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  assert.equal([first.task.id, second.task.id].filter((value, index, values) => value === values[0]).length, 2);
  assert.equal((await readTask({ dir, id: first.task.id })).state, 'QUEUED');
});

test('terminal tasks cannot transition back to running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-review-store-'));
  const input = {
    repository: 'LihSheng/LinkUp',
    pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe',
    agent: 'professor',
    mode: 'review',
  };
  const { task } = await createOrClaimTask({ dir, input, trigger: 'pull_request' });

  await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'PASSED', reason: 'test' });

  await assert.rejects(
    () => transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'invalid' }),
    /Invalid task transition/,
  );
});

test('claim renewal updates heartbeat and stale detection is clock-controlled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-review-store-'));
  const input = {
    repository: 'LihSheng/LinkUp', pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe', agent: 'professor', mode: 'review',
  };
  const { task } = await createOrClaimTask({ dir, input, trigger: 'pull_request' });
  await claimTask({ dir, id: task.id, instanceId: 'test', leaseId: 'lease-1' });
  const before = '2026-07-15T00:00:00.000Z';
  const renewed = await renewClaim({ dir, id: task.id, now: before });

  assert.equal(renewed.heartbeat_at, before);
  assert.equal(isClaimStale(renewed, { now: '2026-07-15T00:29:59.000Z', staleMinutes: 30 }), false);
  assert.equal(isClaimStale(renewed, { now: '2026-07-15T00:30:01.000Z', staleMinutes: 30 }), true);
});
