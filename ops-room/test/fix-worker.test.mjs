import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    verifyWorkspace: async () => { calls.push('verify'); return { outcome: 'verified' }; },
    pushWorkspace: async () => { calls.push('push'); return { newSha: 'b'.repeat(40) }; },
    cleanupWorkspace: async () => calls.push('cleanup'),
    ...overrides,
  };
}

const MOCK_LEASE = { lease_id: 'lease-test', lease_epoch: 1 };

test('fix child fences SHA, heartbeats, pushes once, and always cleans up', async () => {
  const d = deps();
  const result = await runFixChildWorker({ task: { id: 'fix:1', repository: 'LihSheng/LinkUp', pr: 1, reviewed_sha: 'a'.repeat(40) }, deps: d, lease: MOCK_LEASE });
  assert.deepEqual(result, { outcome: 'FIX_PUSHED', new_sha: 'b'.repeat(40) });
  assert.deepEqual(d.calls, ['prepare', 'heartbeat', 'apply', 'heartbeat', 'verify', 'push', 'cleanup']);
});

test('fix child never prepares or pushes when the reviewed SHA is stale', async () => {
  const d = deps({ fetchCurrentHead: async () => 'c'.repeat(40) });
  await assert.rejects(
    () => runFixChildWorker({ task: { id: 'fix:1', repository: 'LihSheng/LinkUp', pr: 1, reviewed_sha: 'a'.repeat(40) }, deps: d, lease: MOCK_LEASE }),
    FixSupersededError,
  );
  assert.deepEqual(d.calls, []);
});

test('fix child reports no source changes and still cleans the workspace', async () => {
  const d = deps({ applyFix: async () => ({ changed: false }) });
  const result = await runFixChildWorker({ task: { id: 'fix:1', repository: 'LihSheng/LinkUp', pr: 1, reviewed_sha: 'a'.repeat(40) }, deps: d, lease: MOCK_LEASE });
  assert.equal(result.outcome, 'NEEDS_HUMAN');
  assert.ok(d.calls.includes('cleanup'));
  assert.ok(!d.calls.includes('push'));
});

test('completed push effect prevents a duplicate push and retains the pushed SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-fix-push-ledger-'));
  const task = { id: 'fix:1', repository: 'LihSheng/LinkUp', pr: 1, reviewed_sha: 'a'.repeat(40) };
  const first = deps();
  await runFixChildWorker({ task, deps: first, dir, lease: MOCK_LEASE });
  const second = deps();
  const result = await runFixChildWorker({ task, deps: second, dir, lease: MOCK_LEASE });
  assert.deepEqual(result, { outcome: 'FIX_PUSHED', new_sha: 'b'.repeat(40), duplicate_effect: true });
  assert.ok(!second.calls.includes('push'));
  assert.ok(second.calls.includes('cleanup'));
});
