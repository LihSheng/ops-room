import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activateWorkflowChild,
  buildWorkflowChildId,
  completeWorkflowChild,
  createOrLoadWorkflowRun,
  ensureWorkflowChild,
  failWorkflowChild,
  readWorkflowRun,
  retryWorkflowChild,
  serializeWorkflowRun,
  validateWorkflowRun,
} from '../src/services/workflow-run-store.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const SHA_E = 'e'.repeat(40);

async function workflowDir() {
  return mkdtemp(join(tmpdir(), 'ops-room-workflow-runs-'));
}

async function createRun(dir, overrides = {}, policy = {}) {
  return createOrLoadWorkflowRun({
    dir,
    input: {
      repository: 'LihSheng/ops-room',
      requestKey: 'issue:34',
      sourceSha: SHA_A,
      ...overrides,
    },
    policy,
  });
}

async function completeStage({ dir, workflowId, iteration, stage, inputSha, outputSha }) {
  const ensured = await ensureWorkflowChild({
    dir,
    workflowId,
    iteration,
    stage,
    inputSha,
  });
  await activateWorkflowChild({ dir, workflowId, childId: ensured.child.child_id });
  return completeWorkflowChild({
    dir,
    workflowId,
    childId: ensured.child.child_id,
    outputSha,
  });
}

test('parent workflow creation is deterministic and restart-idempotent', async () => {
  const dir = await workflowDir();
  const first = await createRun(dir);
  const second = await createRun(dir);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run.workflow_id, first.run.workflow_id);
  assert.equal(second.run.state, 'planned');
  assert.deepEqual(second.run.policy, { max_iterations: 3, max_concurrency: 1 });

  await assert.rejects(
    createRun(dir, { sourceSha: SHA_B }),
    /workflow_run_conflict/,
  );
});

test('children enforce canonical ownership, stage order, dependencies, and immutable SHA handoffs', async () => {
  const dir = await workflowDir();
  const { run } = await createRun(dir);
  const workflowId = run.workflow_id;

  const implementation = await ensureWorkflowChild({
    dir,
    workflowId,
    iteration: 1,
    stage: 'implementation',
    inputSha: SHA_A,
  });
  assert.equal(implementation.child.owner_agent, 'professor');
  assert.equal(implementation.child.depends_on, null);

  await assert.rejects(
    ensureWorkflowChild({
      dir,
      workflowId,
      iteration: 1,
      stage: 'test',
      inputSha: SHA_B,
    }),
    /workflow_child_dependency_incomplete/,
  );

  await activateWorkflowChild({ dir, workflowId, childId: implementation.child.child_id });
  await completeWorkflowChild({
    dir,
    workflowId,
    childId: implementation.child.child_id,
    outputSha: SHA_B,
  });

  const testChild = await ensureWorkflowChild({
    dir,
    workflowId,
    iteration: 1,
    stage: 'test',
    inputSha: SHA_B,
  });
  assert.equal(testChild.child.owner_agent, 'tokyo');
  assert.equal(testChild.child.depends_on, implementation.child.child_id);

  const replay = await ensureWorkflowChild({
    dir,
    workflowId,
    iteration: 1,
    stage: 'test',
    inputSha: SHA_B,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.child.child_id, testChild.child.child_id);

  await assert.rejects(
    ensureWorkflowChild({
      dir,
      workflowId,
      iteration: 1,
      stage: 'test',
      inputSha: SHA_C,
    }),
    /workflow_child_conflict/,
  );
});

test('failed child attempts are recoverable while completed children are immutable', async () => {
  const dir = await workflowDir();
  const { run } = await createRun(dir);
  const workflowId = run.workflow_id;

  await completeStage({
    dir,
    workflowId,
    iteration: 1,
    stage: 'implementation',
    inputSha: SHA_A,
    outputSha: SHA_B,
  });
  const testChild = await ensureWorkflowChild({
    dir,
    workflowId,
    iteration: 1,
    stage: 'test',
    inputSha: SHA_B,
  });
  await activateWorkflowChild({ dir, workflowId, childId: testChild.child.child_id });
  const failed = await failWorkflowChild({
    dir,
    workflowId,
    childId: testChild.child.child_id,
    error: 'test command failed',
  });
  assert.equal(failed.child.state, 'failed');
  assert.equal(failed.run.state, 'blocked');

  const retried = await retryWorkflowChild({ dir, workflowId, childId: testChild.child.child_id });
  assert.equal(retried.child.state, 'pending');
  assert.equal(retried.child.attempt, 1);
  assert.equal(retried.run.state, 'active');

  await activateWorkflowChild({ dir, workflowId, childId: testChild.child.child_id });
  const completed = await completeWorkflowChild({
    dir,
    workflowId,
    childId: testChild.child.child_id,
    outputSha: SHA_C,
  });
  assert.equal(completed.child.state, 'completed');
  assert.equal(completed.child.output_sha, SHA_C);

  const replay = await completeWorkflowChild({
    dir,
    workflowId,
    childId: testChild.child.child_id,
    outputSha: SHA_C,
  });
  assert.equal(replay.child.completed_at, completed.child.completed_at);

  await assert.rejects(
    completeWorkflowChild({
      dir,
      workflowId,
      childId: testChild.child.child_id,
      outputSha: SHA_D,
    }),
    /workflow_child_completion_conflict/,
  );
});

test('a second iteration depends on the prior immutable review checkpoint', async () => {
  const dir = await workflowDir();
  const { run } = await createRun(dir, {}, { max_iterations: 2, max_concurrency: 1 });
  const workflowId = run.workflow_id;

  await completeStage({ dir, workflowId, iteration: 1, stage: 'implementation', inputSha: SHA_A, outputSha: SHA_B });
  await completeStage({ dir, workflowId, iteration: 1, stage: 'test', inputSha: SHA_B, outputSha: SHA_C });
  await completeStage({ dir, workflowId, iteration: 1, stage: 'integration', inputSha: SHA_C, outputSha: SHA_D });
  const review = await completeStage({ dir, workflowId, iteration: 1, stage: 'review', inputSha: SHA_D, outputSha: SHA_E });

  const nextImplementation = await ensureWorkflowChild({
    dir,
    workflowId,
    iteration: 2,
    stage: 'implementation',
    inputSha: SHA_E,
  });
  assert.equal(nextImplementation.child.owner_agent, 'professor');
  assert.equal(nextImplementation.child.depends_on, review.child.child_id);
  assert.equal(nextImplementation.run.current_iteration, 2);

  await assert.rejects(
    ensureWorkflowChild({
      dir,
      workflowId,
      iteration: 3,
      stage: 'implementation',
      inputSha: SHA_E,
    }),
    /workflow_iteration_limit_exceeded/,
  );
});

test('validation fails closed for ambiguous duplicate child state', async () => {
  const dir = await workflowDir();
  const { run } = await createRun(dir);
  const implementation = await ensureWorkflowChild({
    dir,
    workflowId: run.workflow_id,
    iteration: 1,
    stage: 'implementation',
    inputSha: SHA_A,
  });
  const stored = await readWorkflowRun({ dir, workflowId: run.workflow_id });

  assert.throws(
    () => validateWorkflowRun({
      ...stored,
      children: [...stored.children, { ...implementation.child }],
    }),
    /duplicate_workflow_child_id/,
  );
});

test('read serialization is bounded and excludes runtime paths, remotes, and credentials', async () => {
  const dir = await workflowDir();
  const { run } = await createRun(dir);
  const publicRun = serializeWorkflowRun({
    ...run,
    workspace_path: '/srv/private/worktree',
    repository_remote: 'https://token@example.invalid/repo.git',
    credential: 'secret',
    raw_output: 'provider output',
  });

  assert.equal(publicRun.workflow_id, run.workflow_id);
  assert.equal(publicRun.child_count, 0);
  assert.equal(Object.hasOwn(publicRun, 'workspace_path'), false);
  assert.equal(Object.hasOwn(publicRun, 'repository_remote'), false);
  assert.equal(Object.hasOwn(publicRun, 'credential'), false);
  assert.equal(Object.hasOwn(publicRun, 'raw_output'), false);
});

test('child identifiers are stable across restart recovery', async () => {
  const dir = await workflowDir();
  const { run } = await createRun(dir);
  const expected = buildWorkflowChildId({
    workflowId: run.workflow_id,
    iteration: 1,
    stage: 'implementation',
  });
  const child = await ensureWorkflowChild({
    dir,
    workflowId: run.workflow_id,
    iteration: 1,
    stage: 'implementation',
    inputSha: SHA_A,
  });

  assert.equal(child.child.child_id, expected);
  const recovered = await readWorkflowRun({ dir, workflowId: run.workflow_id });
  assert.equal(recovered.children[0].child_id, expected);
});
