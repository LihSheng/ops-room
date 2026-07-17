import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrClaimTask, listReviewTasks } from '../src/services/review-task-store.js';

test('review task listing returns durable tasks newest-first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-list-'));
  await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 1, headSha: 'a'.repeat(40), agent: 'professor' } });
  await createOrClaimTask({ dir, input: { repository: 'LihSheng/LinkUp', pr: 2, headSha: 'b'.repeat(40), agent: 'professor' } });
  const tasks = await listReviewTasks({ dir });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].pr, 2);
});
