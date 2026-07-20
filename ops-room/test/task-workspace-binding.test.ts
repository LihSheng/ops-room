import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureTaskWorkspace,
  selectTaskWorkspacePlan,
  serializeTaskWorkspace,
  taskWorkspacePatch,
} from '../src/services/task-workspace-binding.js';

const SHA = 'a'.repeat(40);

function reviewTask(overrides = {}) {
  return {
    id: 'review-LihSheng-ops-room-30-berlin',
    kind: 'review',
    repository: 'ops-room',
    pr: 30,
    reviewed_sha: SHA,
    agent: 'berlin',
    mode: 'review',
    ...overrides,
  };
}

function fixTask(overrides = {}) {
  return {
    id: 'fix-LihSheng-ops-room-30-professor',
    kind: 'fix',
    repository: 'ops-room',
    pr: 30,
    reviewed_sha: SHA,
    agent: 'professor',
    head_ref: 'agent/professor/fix-30',
    ...overrides,
  };
}

async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-task-workspace-'));
  return {
    cacheRoot: join(root, 'repositories'),
    workspaceRoot: join(root, 'workspaces'),
    recordRoot: join(root, 'records'),
    lockRoot: join(root, 'locks'),
  };
}

test('review tasks require and select detached exact-SHA workspaces', () => {
  const plan = selectTaskWorkspacePlan(reviewTask());
  assert.equal(plan.mode, 'detached');
  assert.equal(plan.branch, null);
  assert.equal(plan.revision, SHA);
  assert.match(plan.workspace_id, /^task-berlin-/);

  assert.throws(
    () => selectTaskWorkspacePlan(reviewTask({ reviewed_sha: 'main' })),
    /task_workspace_exact_sha_required/,
  );
});

test('fix tasks select writable branch workspaces', () => {
  const plan = selectTaskWorkspacePlan(fixTask());
  assert.equal(plan.mode, 'branch');
  assert.equal(plan.branch, 'agent/professor/fix-30');
  assert.equal(plan.revision, SHA);
});

test('new task allocation returns execution path and bounded patch', async () => {
  const r = await roots();
  let allocationInput = null;
  const record = {
    workspace_id: 'task-berlin-1234',
    owner_agent: 'berlin',
    task_id: reviewTask().id,
    repository_id: 'ops-room',
    mode: 'detached',
    branch: null,
    resolved_sha: SHA,
    relative_path: 'berlin/task-berlin-1234',
    state: 'active',
  };

  const result = await ensureTaskWorkspace({
    task: reviewTask(),
    ...r,
    remote: 'https://example.invalid/repo.git',
    allocate: async (input) => {
      allocationInput = input;
      await mkdir(join(r.workspaceRoot, record.relative_path), { recursive: true });
      return record;
    },
  });

  assert.equal(result.reused, false);
  assert.equal(result.workspace_path, join(r.workspaceRoot, record.relative_path));
  assert.equal(allocationInput.mode, 'detached');
  assert.equal(allocationInput.revision, SHA);

  const patch = taskWorkspacePatch(result);
  assert.equal(patch.workspace_id, record.workspace_id);
  assert.deepEqual(patch.workspace, serializeTaskWorkspace(record));
  assert.equal(Object.hasOwn(patch.workspace, 'relative_path'), false);
});

test('retry and restart recovery reuse the existing workspace without allocation', async () => {
  const r = await roots();
  const workspaceId = 'task-professor-existing';
  const relativePath = `professor/${workspaceId}`;
  await mkdir(join(r.workspaceRoot, relativePath), { recursive: true });
  let allocations = 0;

  const task = fixTask({ workspace_id: workspaceId });
  const result = await ensureTaskWorkspace({
    task,
    ...r,
    remote: 'unused',
    allocate: async () => { allocations += 1; throw new Error('should_not_allocate'); },
    readRecord: async () => ({
      workspace_id: workspaceId,
      owner_agent: task.agent,
      task_id: task.id,
      repository_id: task.repository,
      mode: 'branch',
      branch: task.head_ref,
      resolved_sha: SHA,
      relative_path: relativePath,
      state: 'active',
    }),
  });

  assert.equal(result.reused, true);
  assert.equal(allocations, 0);
});

test('task/workspace ownership mismatch fails closed', async () => {
  const r = await roots();
  const workspaceId = 'task-existing';
  await assert.rejects(
    ensureTaskWorkspace({
      task: fixTask({ workspace_id: workspaceId }),
      ...r,
      remote: 'unused',
      readRecord: async () => ({
        workspace_id: workspaceId,
        owner_agent: 'tokyo',
        task_id: fixTask().id,
        repository_id: 'ops-room',
        relative_path: `tokyo/${workspaceId}`,
        state: 'active',
      }),
    }),
    /task_workspace_owner_mismatch/,
  );
});

test('missing workspace directory fails closed and does not allocate a duplicate', async () => {
  const r = await roots();
  const workspaceId = 'task-existing';
  let allocations = 0;
  await assert.rejects(
    ensureTaskWorkspace({
      task: fixTask({ workspace_id: workspaceId }),
      ...r,
      remote: 'unused',
      allocate: async () => { allocations += 1; return null; },
      readRecord: async () => ({
        workspace_id: workspaceId,
        owner_agent: 'professor',
        task_id: fixTask().id,
        repository_id: 'ops-room',
        relative_path: `professor/${workspaceId}`,
        state: 'active',
      }),
    }),
    /task_workspace_missing/,
  );
  assert.equal(allocations, 0);
});

test('read serialization excludes absolute paths and repository remotes', () => {
  const value = serializeTaskWorkspace({
    workspace_id: 'task-1',
    mode: 'branch',
    repository_id: 'ops-room',
    branch: 'agent/professor/task-1',
    resolved_sha: SHA,
    state: 'held_for_investigation',
    relative_path: 'professor/task-1',
    cache_path: '/secret/repositories/ops-room.git',
    remote: 'https://token@example.invalid/repo.git',
  });
  assert.equal(value.held_for_investigation, true);
  assert.equal(Object.hasOwn(value, 'relative_path'), false);
  assert.equal(Object.hasOwn(value, 'cache_path'), false);
  assert.equal(Object.hasOwn(value, 'remote'), false);
});
