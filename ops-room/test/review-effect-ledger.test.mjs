import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claimEffect, completeEffect } from '../src/services/review-effect-ledger.mjs';

test('effect ledger deduplicates a GitHub effect after completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
  const input = { dir, taskId: 'review:test:1:sha:agent:review', kind: 'github_review', fingerprint: 'sha:REQUEST_CHANGES' };
  const first = await claimEffect(input);
  assert.equal(first.claimed, true);
  await completeEffect({ ...input, effectId: first.effect.id, result: { review_id: 123 } });
  const duplicate = await claimEffect(input);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.effect.state, 'COMPLETED');
});
