import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claimEffect, completeEffect, listEffects, resolveAmbiguousEffect } from '../src/services/review-effect-ledger.js';

test('ambiguous CLAIMED effect can be resolved by operator', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:99:sha:agent:review', kind: 'github_review', fingerprint: 'sha:APPROVE' };

  const claimed = await claimEffect(input);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.effect.state, 'CLAIMED');

  // Simulate operator abandoning the ambiguous effect
  const resolved = await resolveAmbiguousEffect({
    dir,
    effectId: claimed.effect.id,
    resolution: 'abandon',
    notes: '',
  });
  assert.equal(resolved.state, 'ABANDONED');
  assert.ok(resolved.resolved_at);
  assert.ok(resolved.resolution_notes.includes('ABANDONED'));

  // The original CLAIMED effect path should now return ABANDONED state
  const recheck = await claimEffect(input);
  assert.equal(recheck.claimed, false);
  assert.equal(recheck.effect.state, 'ABANDONED');
});

test('CLAIMED effect cannot be double-resolved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:98:sha:agent:review', kind: 'github_commit_status', fingerprint: 'sha:pending' };

  const claimed = await claimEffect(input);
  await resolveAmbiguousEffect({ dir, effectId: claimed.effect.id, resolution: 'complete' });

  await assert.rejects(
    () => resolveAmbiguousEffect({ dir, effectId: claimed.effect.id, resolution: 'abandon' }),
    /Can only resolve CLAIMED/,
  );
});

test('listEffects filters by task ID, kind, and state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));

  // Create effects for two different tasks
  const e1 = await claimEffect({ dir, taskId: 'review:a:1:sha:agent:review', kind: 'github_review', fingerprint: 'fp1' });
  const e2 = await claimEffect({ dir, taskId: 'review:a:1:sha:agent:review', kind: 'github_commit_status', fingerprint: 'fp2' });
  const e3 = await claimEffect({ dir, taskId: 'review:b:2:sha:agent:review', kind: 'github_review', fingerprint: 'fp3' });
  await completeEffect({ dir, effectId: e3.effect.id, result: { review_id: 1 } });

  // List all CLAIMED effects for task A
  const claimed = await listEffects({ dir, taskId: 'review:a:1:sha:agent:review', state: 'CLAIMED' });
  assert.equal(claimed.length, 2);
  assert.ok(claimed.every(e => e.state === 'CLAIMED' && e.task_id === 'review:a:1:sha:agent:review'));

  // Filter by kind
  const reviews = await listEffects({ dir, taskId: 'review:a:1:sha:agent:review', kind: 'github_review' });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].kind, 'github_review');

  // List COMPLETED effects
  const completed = await listEffects({ dir, state: 'COMPLETED' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].task_id, 'review:b:2:sha:agent:review');
});

test('github_issue_comment effects are deduplicated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:50:sha:agent:review', kind: 'github_issue_comment', fingerprint: 'sha:chat:summary' };

  const first = await claimEffect(input);
  assert.equal(first.claimed, true);

  await completeEffect({ dir, effectId: first.effect.id, result: { pr: 50 } });

  const dup = await claimEffect(input);
  assert.equal(dup.claimed, false);
  assert.equal(dup.effect.state, 'COMPLETED');
});
