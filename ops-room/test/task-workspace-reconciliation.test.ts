import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { reconcileTaskWorkspace, reconcileTaskWorkspaces } from '../src/services/task-workspace-reconciliation.js';

function task(overrides: any = {}) {
  return {
    id: 'review-ops-room-32-berlin',
    state: 'RUNNING',
    agent: 'berlin',
    repository: 'ops-room',
    workspace_id: 'task-berlin-1',
    ...overrides,
  };
}

function record(overrides: any = {}) {
  return {
    workspace_id: 'task-berlin-1',
    task_id: 'review-ops-room-32-berlin',
    owner_agent: 'berlin',
    repository_id: 'ops-room',
    relative_path: 'berlin/task-berlin-1',
    state: 'active',
    ...overrides,
  };
}

const directory = { isDirectory: () => true };

test('reconnects an active task to its existing workspace without allocation', async () => {
  const result = await reconcileTaskWorkspace({
    task: task(),
    workspaceRoot: '/workspaces',
    recordRoot: '/records',
    readRecord: async () => record(),
    statPath: async () => directory,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.workspace_path, resolve(join('/workspaces', 'berlin', 'task-berlin-1')));
});

test('missing directory and ownership mismatch fail closed', async () => {
  const missing = await reconcileTaskWorkspace({
    task: task(), workspaceRoot: '/workspaces', recordRoot: '/records',
    readRecord: async () => record(), statPath: async () => { throw new Error('missing'); },
  });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason_code, 'workspace_directory_missing');

  const mismatch = await reconcileTaskWorkspace({
    task: task(), workspaceRoot: '/workspaces', recordRoot: '/records',
    readRecord: async () => record({ owner_agent: 'tokyo' }), statPath: async () => directory,
  });
  assert.equal(mismatch.status, 'blocked');
  assert.equal(mismatch.reason_code, 'workspace_owner_mismatch');
});

test('legacy active tasks remain readable but are explicitly unbound', async () => {
  const result = await reconcileTaskWorkspace({
    task: task({ workspace_id: null }), workspaceRoot: '/workspaces', recordRoot: '/records',
  });
  assert.equal(result.status, 'legacy_unbound');
  assert.equal(result.reason_code, 'legacy_task_without_workspace');
});

test('batch reconciliation never allocates or destroys workspaces', async () => {
  const results = await reconcileTaskWorkspaces({
    tasks: [task(), task({ id: 'task-2' })],
    workspaceRoot: '/workspaces',
    recordRoot: '/records',
    reconcile: async ({ task: value }: any) => ({ status: 'ready', reason_code: null, workspace: { task_id: value.id } }),
  });
  assert.deepEqual(results.map((item: any) => item.task_id), ['review-ops-room-32-berlin', 'task-2']);
});
