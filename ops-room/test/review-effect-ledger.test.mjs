import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claimEffect, completeEffect, resolveAmbiguousEffect, reclaimEffect } from '../src/services/review-effect-ledger.mjs';

test('effect ledger deduplicates a GitHub effect after completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:1:sha:agent:review', kind: 'github_review', fingerprint: 'sha:REQUEST_CHANGES' };
  const first = await claimEffect(input);
  assert.equal(first.claimed, true);
  assert.equal(first.state, 'CLAIMED');
  await completeEffect({ ...input, effectId: first.effect.id, result: { review_id: 123 } });
  const duplicate = await claimEffect(input);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.state, 'COMPLETED');
  assert.equal(duplicate.effect.state, 'COMPLETED');
});

test('claimEffect returns CLAIMED state for uncompleted existing effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:2:sha:agent:review', kind: 'github_review', fingerprint: 'sha:CLAIMED-test' };
  const first = await claimEffect(input);
  assert.equal(first.claimed, true);
  assert.equal(first.state, 'CLAIMED');

  // Second attempt on the same uncompleted effect returns CLAIMED, not COMPLETED
  const second = await claimEffect(input);
  assert.equal(second.claimed, false);
  assert.equal(second.state, 'CLAIMED', 'uncompleted effect should report state as CLAIMED');

  // After completion, duplicate returns COMPLETED
  await completeEffect({ dir, effectId: first.effect.id, result: { event: 'APPROVE' } });
  const third = await claimEffect(input);
  assert.equal(third.claimed, false);
  assert.equal(third.state, 'COMPLETED');
});

test('ABANDONED effects allow re-claim after operator resolution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:3:sha:agent:review', kind: 'github_commit_status', fingerprint: 'sha:ABANDONED-test' };
  const first = await claimEffect(input);
  assert.equal(first.claimed, true);

  // Abandon the effect
  await resolveAmbiguousEffect({ dir, effectId: first.effect.id, resolution: 'abandon' });

  // A new claim attempt gets ABANDONED state — caller can then retry with a new fingerprint
  const afterAbandon = await claimEffect(input);
  assert.equal(afterAbandon.claimed, false);
  assert.equal(afterAbandon.state, 'ABANDONED');
});

test('reclaimEffect atomically transitions ABANDONED to CLAIMED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:4:sha:agent:review', kind: 'github_review', fingerprint: 'sha:reclaim-test' };
  const first = await claimEffect(input);
  assert.equal(first.claimed, true);

  // Abandon, then atomically reclaim
  await resolveAmbiguousEffect({ dir, effectId: first.effect.id, resolution: 'abandon' });
  const reclaimed = await reclaimEffect({ dir, effectId: first.effect.id });
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(reclaimed.effect.state, 'CLAIMED');

  // Cannot reclaim a non-ABANDONED effect
  await assert.rejects(
    () => reclaimEffect({ dir, effectId: first.effect.id }),
    /Can only reclaim ABANDONED/,
  );
});
