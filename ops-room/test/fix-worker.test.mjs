import assert from 'node:assert/strict';
import test from 'node:test';

import { FixSupersededError, runFixChildWorker } from '../src/workflows/fix-worker.mjs';

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    fetchCurrentHead: async () => 'a'.repeat(40),
    readTask: async () => ({ state: 'FIXING' }),
    renewLease: async () => calls.push('heartbeat'),
    prepareWorkspace: async () => { calls.push('prepare'); return { path: '/tmp/workspace' }; },
    applyFix: async () => { calls.push('apply'); return { changed: true }; },
    pushWorkspace: async () => { calls.push('push'); return { newSha: 'b'.repeat(40) }; },
    cleanupWorkspace: async () => calls.push('cleanup'),
    ...overrides,
  };
}

test('fix child fences SHA, heartbeats, pushes once, and always cleans up', async () => {
  const d = deps();
  const result = await runFixChildWorker({ task: { id: 'fix:1', repository: 'LihSheng/LinkUp', pr: 1, reviewed_sha: 'a'.repeat(40) }, deps: d });
  assert.deepEqual(result, { outcome: 'FIX_PUSHED', new_sha: 'b'.repeat(40) });
  assert.deepEqual(d.calls, ['prepare', 'heartbeat', 'apply', 'heartbeat', 'push', 'cleanup']);
});

test('fix child never prepares or pushes when the reviewed SHA is stale', async () => {
  const d = deps({ fetchCurrentHead: async () => 'c'.repeat(40) });
  await assert.rejects(
    () => runFixChildWorker({ task: { id: 'fix:1', repository: 'LihSheng/LinkUp', pr: 1, reviewed_sha: 'a'.repeat(40) }, deps: d }),
    FixSupersededError,
  );
  assert.deepEqual(d.calls, []);
});

test('fix child reports no source changes and still cleans the workspace', async () => {
  const d = deps({ applyFix: async () => ({ changed: false }) });
  const result = await runFixChildWorker({ task: { id: 'fix:1', repository: 'LihSheng/LinkUp', pr: 1, reviewed_sha: 'a'.repeat(40) }, deps: d });
  assert.equal(result.outcome, 'NEEDS_HUMAN');
  assert.ok(d.calls.includes('cleanup'));
  assert.ok(!d.calls.includes('push'));
});
