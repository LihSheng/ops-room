import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrClaimTask, readTask } from '../src/services/review-task-store.js';
import { executeFixChildTask } from '../src/workflows/fix-child-executor.js';

test('fix child executor owns lifecycle transitions and records pushed SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-fix-executor-'));
  const { task } = await createOrClaimTask({
    dir,
    kind: 'fix',
    parentTaskId: 'review:parent',
    input: { repository: 'LihSheng/LinkUp', pr: 5, reviewedSha: 'a'.repeat(40), agent: 'berlin', mode: 'auto-fix' },
  });
  const result = await executeFixChildTask({
    dir,
    id: task.id,
    instanceId: 'test',
    runWorker: async () => ({ outcome: 'FIX_PUSHED', new_sha: 'b'.repeat(40) }),
  });
  assert.equal(result.state, 'FIX_PUSHED');
  const completed = await readTask({ dir, id: task.id });
  assert.equal(completed.state, 'FIX_PUSHED');
  assert.equal(completed.result.new_sha, 'b'.repeat(40));
});
