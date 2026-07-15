import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPrReviewController } from '../src/workflows/pr-review-controller.mjs';

function createHarness({ currentSha = 'b'.repeat(40) } = {}) {
  const calls = { dispatch: 0, statuses: [] };
  return {
    calls,
    controller: createPrReviewController({
      fetchPullRequest: async () => ({ state: 'open', draft: false, head: { sha: currentSha } }),
      setCommitStatus: async (input) => calls.statuses.push(input),
      dispatchReview: async () => { calls.dispatch += 1; },
      instanceId: 'test-instance',
    }),
  };
}

test('controller supersedes an old SHA without a status update or model dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-controller-'));
  const { controller, calls } = createHarness({ currentSha: 'b'.repeat(40) });

  const result = await controller.submit({
    dir,
    repository: 'LihSheng/LinkUp',
    pr: 40,
    head_sha: 'a'.repeat(40),
    agent: 'professor',
    mode: 'review',
    trigger: 'pull_request',
  });

  assert.equal(result.status, 'SUPERSEDED');
  assert.equal(calls.dispatch, 0);
  assert.equal(calls.statuses.length, 0);
});

test('controller creates one claimed review and pending status for the current SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-controller-'));
  const { controller, calls } = createHarness();
  const request = {
    dir,
    repository: 'LihSheng/LinkUp',
    pr: 40,
    head_sha: 'b'.repeat(40),
    agent: 'professor',
    mode: 'review',
    trigger: 'pull_request',
  };

  const result = await controller.submit(request);

  assert.equal(result.status, 'RUNNING');
  assert.equal(result.queued, true);
  assert.equal(calls.dispatch, 1);
  assert.deepEqual(calls.statuses, [{
    repository: 'LihSheng/LinkUp',
    sha: 'b'.repeat(40),
    state: 'pending',
    description: 'Review in progress',
    targetUrl: undefined,
    context: 'OpenAB PR Review',
    agent: 'professor',
    dir,
    taskId: `review:LihSheng-LinkUp:40:${'b'.repeat(40)}:professor:review`,
  }]);
});

test('controller deduplicates an identical current-SHA request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-controller-'));
  const { controller, calls } = createHarness();
  const request = {
    dir,
    repository: 'LihSheng/LinkUp', pr: 40, head_sha: 'b'.repeat(40),
    agent: 'professor', mode: 'review', trigger: 'pull_request',
  };

  await controller.submit(request);
  const duplicate = await controller.submit(request);

  assert.equal(duplicate.deduplicated, true);
  assert.equal(calls.dispatch, 1);
  assert.equal(calls.statuses.length, 1);
});

test('controller keeps auto-fix disabled unless policy explicitly allows it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-controller-'));
  const dispatched = [];
  const controller = createPrReviewController({
    fetchPullRequest: async () => ({ state: 'open', draft: false, head: { sha: 'c'.repeat(40) } }),
    setCommitStatus: async () => {},
    dispatchReview: async (task) => dispatched.push(task),
    instanceId: 'test-instance',
  });

  await controller.submit({
    dir, repository: 'LihSheng/LinkUp', pr: 41, head_sha: 'c'.repeat(40), agent: 'professor', mode: 'auto-fix',
  });
  assert.equal(dispatched[0].mode, 'review');

  await controller.submit({
    dir, repository: 'LihSheng/LinkUp', pr: 42, head_sha: 'c'.repeat(40), agent: 'professor', mode: 'auto-fix',
    policy: { allow_auto_fix: true, trusted_source: false, same_repository: true },
  });
  assert.equal(dispatched[1].mode, 'review');

  await controller.submit({
    dir, repository: 'LihSheng/LinkUp', pr: 43, head_sha: 'c'.repeat(40), agent: 'professor', mode: 'auto-fix',
    policy: { allow_auto_fix: true, trusted_source: true, same_repository: true },
  });
  assert.equal(dispatched[2].mode, 'auto-fix');
});
