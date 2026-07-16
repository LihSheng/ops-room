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

test('chat task identity uses pr-chat prefix and includes comment_id', () => {
  const input = {
    repository: 'LihSheng/LinkUp',
    pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe',
    agent: 'professor',
    mode: 'review',
    taskType: 'chat',
    commentId: '12345',
  };
  const id = buildReviewTaskId(input);
  assert.ok(id.startsWith('pr-chat:'), 'chat task ID should use pr-chat prefix');
  assert.ok(id.includes(':12345'), 'chat task ID should include comment_id');
  assert.notEqual(id, buildReviewTaskId({ ...input, taskType: 'review' }));
});

test('lease epoch fencing rejects transitions with mismatched epoch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-review-store-'));
  const input = {
    repository: 'LihSheng/LinkUp', pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe',
    agent: 'professor', mode: 'review',
  };
  const { task } = await createOrClaimTask({ dir, input, trigger: 'pull_request' });

  // Worker A claims with epoch 1
  const claim = await claimTask({ dir, id: task.id, instanceId: 'worker-a', leaseId: 'lease-1', leaseEpoch: 1 });
  assert.equal(claim.claimed, true);

  await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test', leaseEpoch: 1, patch: { lease: claim.claim } });
  await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test', leaseEpoch: 1 });

  // Simulate stale recovery: release claim, then worker B claims with epoch 2
  const { releaseClaim } = await import('../src/services/review-task-store.mjs');
  await releaseClaim({ dir, id: task.id });
  const claimB = await claimTask({ dir, id: task.id, instanceId: 'worker-b', leaseId: 'lease-2', leaseEpoch: 2 });
  assert.equal(claimB.claimed, true);

  // Update task record to reflect the new lease (epoch 2)
  await transitionTask({ dir, id: task.id, to: 'ERROR', reason: 'simulate-epoch-bump', patch: { lease: claimB.claim } });

  // Worker A tries to transition with old epoch 1 — must be rejected
  await assert.rejects(
    () => transitionTask({ dir, id: task.id, to: 'QUEUED', reason: 'stale-worker', leaseEpoch: 1 }),
    /Lease epoch mismatch/,
  );

  // Worker B can transition with correct epoch 2
  const ok = await transitionTask({ dir, id: task.id, to: 'QUEUED', reason: 'valid-worker', leaseEpoch: 2 });
  assert.equal(ok.state, 'QUEUED');
});

test('task persists dispatch context (task_text, task_type, commenter, comment_id)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-review-store-'));
  const input = {
    repository: 'LihSheng/LinkUp',
    pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe',
    agent: 'professor',
    mode: 'review',
    taskType: 'chat',
    commentId: 'comment-456',
    task: 'Please review this PR',
    commenter: 'testuser',
  };
  const { task } = await createOrClaimTask({ dir, input, trigger: 'pull_request' });
  assert.equal(task.task_type, 'chat');
  assert.equal(task.comment_id, 'comment-456');
  assert.equal(task.commenter, 'testuser');
  assert.equal(task.task_text, 'Please review this PR');
});

test('self-transitions allow metadata-only updates for terminal states', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-review-store-'));
  const input = {
    repository: 'LihSheng/LinkUp', pr: 40,
    headSha: 'd8bd1bd9994dbda898ae212ef27145e5edfc90fe',
    agent: 'professor', mode: 'review',
  };
  const { task } = await createOrClaimTask({ dir, input, trigger: 'pull_request' });
  await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test' });
  await transitionTask({ dir, id: task.id, to: 'CHANGES_REQUESTED', reason: 'test' });

  // Self-transition to CHANGES_REQUESTED with metadata update (fix_child_task_id)
  const updated = await transitionTask({
    dir, id: task.id, to: 'CHANGES_REQUESTED',
    reason: 'fix_child_created',
    patch: { fix_child_task_id: 'fix:test:1:sha:parent:agent' },
  });
  assert.equal(updated.state, 'CHANGES_REQUESTED');
  assert.equal(updated.fix_child_task_id, 'fix:test:1:sha:parent:agent');
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
