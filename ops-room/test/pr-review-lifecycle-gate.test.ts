import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readTask } from '../src/services/review-task-store.js';
import { withAgentLifecycleGate } from '../src/services/agent-lifecycle-store.js';
import { createPrReviewController } from '../src/workflows/pr-review-controller.js';

async function fixture() {
  return mkdtemp(join(tmpdir(), 'ops-room-review-lifecycle-'));
}

function request(dir) {
  return {
    dir,
    repository: 'LihSheng/ops-room',
    pr: 91,
    head_sha: 'c'.repeat(40),
    agent: 'gemini',
    mode: 'review',
    task: 'Review this change',
    trigger: 'test',
    policy: {},
  };
}

test('initial review controller leaves lifecycle-blocked work queued', async () => {
  const dir = await fixture();
  let dispatchCalls = 0;
  let statusCalls = 0;
  const controller = createPrReviewController({
    fetchPullRequest: async () => ({
      state: 'open',
      draft: false,
      head: { sha: 'c'.repeat(40) },
    }),
    dispatchReview: async () => { dispatchCalls += 1; },
    setCommitStatus: async () => { statusCalls += 1; },
    canDispatchAgent: async () => false,
    withAgentDispatchGate: withAgentLifecycleGate,
    instanceId: 'test-instance',
  });

  const result = await controller.submit(request(dir));
  const task = await readTask({ dir, id: result.task_id });

  assert.equal(result.status, 'QUEUED');
  assert.equal(result.reason, 'agent_lifecycle_blocked');
  assert.equal(task.state, 'QUEUED');
  assert.equal(dispatchCalls, 0);
  assert.equal(statusCalls, 0);
});

test('initial claim waits for the lifecycle gate before checking policy', async () => {
  const dir = await fixture();
  let allowed = true;
  let releaseGate;
  let gateEntered;
  const entered = new Promise((resolve) => { gateEntered = resolve; });
  const hold = new Promise((resolve) => { releaseGate = resolve; });
  let dispatchCalls = 0;

  const lifecycleOperation = withAgentLifecycleGate('gemini', async () => {
    gateEntered();
    await hold;
  });
  await entered;

  const controller = createPrReviewController({
    fetchPullRequest: async () => ({
      state: 'open',
      draft: false,
      head: { sha: 'c'.repeat(40) },
    }),
    dispatchReview: async () => { dispatchCalls += 1; },
    setCommitStatus: async () => {},
    canDispatchAgent: async () => allowed,
    withAgentDispatchGate: withAgentLifecycleGate,
    instanceId: 'test-instance',
  });

  const submission = controller.submit({ ...request(dir), pr: 92 });
  allowed = false;
  releaseGate();
  await lifecycleOperation;
  const result = await submission;

  assert.equal(result.status, 'QUEUED');
  assert.equal(result.reason, 'agent_lifecycle_blocked');
  assert.equal(dispatchCalls, 0);
});
