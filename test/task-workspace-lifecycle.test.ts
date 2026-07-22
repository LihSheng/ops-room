import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTaskWorkspaceOutcome,
  classifyTaskWorkspaceOutcome,
} from '../src/services/task-workspace-lifecycle.js';

function task(state: string, overrides: any = {}) {
  return {
    id: 'review-ops-room-32-berlin',
    state,
    agent: 'berlin',
    repository: 'ops-room',
    workspace_id: 'task-berlin-1234',
    ...overrides,
  };
}

function record(overrides: any = {}) {
  return {
    workspace_id: 'task-berlin-1234',
    task_id: 'review-ops-room-32-berlin',
    owner_agent: 'berlin',
    repository_id: 'ops-room',
    state: 'active',
    ...overrides,
  };
}

test('classifies successful, investigation, and active outcomes', () => {
  assert.equal(classifyTaskWorkspaceOutcome(task('PASSED')), 'cleanup');
  assert.equal(classifyTaskWorkspaceOutcome(task('FIX_PUSHED')), 'cleanup');
  assert.equal(classifyTaskWorkspaceOutcome(task('ERROR')), 'hold');
  assert.equal(classifyTaskWorkspaceOutcome(task('CANCELLED')), 'hold');
  assert.equal(classifyTaskWorkspaceOutcome(task('RUNNING')), 'preserve');
  assert.equal(classifyTaskWorkspaceOutcome(null), 'none');
});

test('successful durable completion requests cleanup exactly once', async () => {
  let calls = 0;
  const result = await applyTaskWorkspaceOutcome({
    task: task('PASSED'),
    recordRoot: '/records',
    readRecord: async () => record(),
    requestCleanup: async () => {
      calls += 1;
      return record({ state: 'cleanup_requested' });
    },
  });
  assert.equal(result.action, 'cleanup');
  assert.equal(result.idempotent, false);
  assert.equal(calls, 1);
});

test('cleanup replay is idempotent and does not request cleanup twice', async () => {
  let calls = 0;
  const result = await applyTaskWorkspaceOutcome({
    task: task('PASSED'),
    recordRoot: '/records',
    readRecord: async () => record({ state: 'cleanup_requested' }),
    requestCleanup: async () => { calls += 1; throw new Error('should_not_run'); },
  });
  assert.equal(result.idempotent, true);
  assert.equal(calls, 0);
});

test('failed and cancelled tasks preserve workspace under investigation hold', async () => {
  for (const state of ['ERROR', 'NEEDS_HUMAN', 'CANCELLED', 'CANCEL_REQUESTED', 'SUPERSEDED']) {
    let patch = null;
    const result = await applyTaskWorkspaceOutcome({
      task: task(state),
      recordRoot: '/records',
      readRecord: async () => record(),
      updateRecord: async (input: any) => {
        patch = input.patch;
        return record(input.patch);
      },
    });
    assert.equal(result.action, 'hold');
    assert.equal(patch.state, 'held_for_investigation');
    assert.match(patch.hold_reason, /^task_/);
  }
});

test('active execution preserves the workspace without mutation', async () => {
  let mutations = 0;
  const result = await applyTaskWorkspaceOutcome({
    task: task('RUNNING'),
    recordRoot: '/records',
    readRecord: async () => record(),
    requestCleanup: async () => { mutations += 1; },
    updateRecord: async () => { mutations += 1; },
  });
  assert.equal(result.action, 'preserve');
  assert.equal(mutations, 0);
});

test('ownership mismatch fails closed before cleanup or hold mutation', async () => {
  await assert.rejects(
    applyTaskWorkspaceOutcome({
      task: task('PASSED'),
      recordRoot: '/records',
      readRecord: async () => record({ owner_agent: 'tokyo' }),
    }),
    /task_workspace_owner_mismatch/,
  );
});

test('successful completion cannot clean an investigation-held workspace', async () => {
  await assert.rejects(
    applyTaskWorkspaceOutcome({
      task: task('PASSED'),
      recordRoot: '/records',
      readRecord: async () => record({ state: 'held_for_investigation' }),
    }),
    /task_workspace_cleanup_not_safe/,
  );
});
