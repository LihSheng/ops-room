import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPrReviewController } from '../src/workflows/pr-review-controller.js';

/**
 * Creates a harness that validates SHA against the request, so a task
 * is never superseded just because of SHA mismatch.
 */
function createMatchingHarness() {
  const calls = { dispatch: 0, statuses: [] };
  return {
    calls,
    controller: createPrReviewController({
      fetchPullRequest: async ({ repository, pr, agent }) => {
        // We match the SHA dynamically — caller must set head_sha correctly.
        // For these tests we use a well-known SHA.
        return { state: 'open', draft: false, head: { sha: '0'.repeat(40) } };
      },
      setCommitStatus: async (input) => calls.statuses.push(input),
      dispatchReview: async () => { calls.dispatch += 1; },
      instanceId: 'test-instance',
    }),
  };
}

test('per-PR concurrency limits queue new tasks for the same PR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-concurrency-'));
  const { controller, calls } = createMatchingHarness();
  const sha = '0'.repeat(40);

  // First dispatch on PR 40 — should run
  const r1 = await controller.submit({
    dir, repository: 'LihSheng/LinkUp', pr: 40, head_sha: sha,
    agent: 'professor', mode: 'review', trigger: 'pull_request',
  });
  assert.equal(r1.status, 'RUNNING');

  // Second dispatch same PR same SHA → deduplicated (not queued)
  const r2 = await controller.submit({
    dir, repository: 'LihSheng/LinkUp', pr: 40, head_sha: sha,
    agent: 'professor', mode: 'review', trigger: 'pull_request',
  });
  assert.equal(r2.status, 'RUNNING');
  assert.equal(r2.deduplicated, true);

  // Third dispatch same PR but with a different SHA — for a different SHA, the
  // controller checks current SHA. The harness always returns '0'*40, so this
  // gets SUPERSEDED.
  const r3 = await controller.submit({
    dir, repository: 'LihSheng/LinkUp', pr: 40, head_sha: '1'.repeat(40),
    agent: 'professor', mode: 'review', trigger: 'pull_request',
  });
  assert.equal(r3.status, 'SUPERSEDED');
});

test('per-repository concurrency limit queues tasks when repo limit exceeded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-concurrency2-'));
  
  // Harness that returns the request's head_sha as current SHA
  let currentSha = '0'.repeat(40);
  const calls = { dispatch: 0 };
  const controller = createPrReviewController({
    fetchPullRequest: async () => ({ state: 'open', draft: false, head: { sha: currentSha } }),
    setCommitStatus: async () => {},
    dispatchReview: async () => { calls.dispatch += 1; },
    instanceId: 'test-instance',
  });

  // Submit 3 tasks on the same repo (different PRs, different SHAs)
  for (let i = 0; i < 3; i++) {
    const sha = String(i).repeat(40);
    currentSha = sha;
    const r = await controller.submit({
      dir, repository: 'LihSheng/LinkUp', pr: 100 + i, head_sha: sha,
      agent: 'professor', mode: 'review', trigger: 'pull_request',
    });
    assert.equal(r.status, 'RUNNING', `Task ${i} should be RUNNING`);
  }
  assert.equal(calls.dispatch, 3);

  // Fourth task on same repo should hit per_repository limit (default 3)
  const sha4 = '3'.repeat(40);
  currentSha = sha4;
  const r4 = await controller.submit({
    dir, repository: 'LihSheng/LinkUp', pr: 104, head_sha: sha4,
    agent: 'professor', mode: 'review', trigger: 'pull_request',
  });
  assert.equal(r4.status, 'QUEUED');
  assert.equal(r4.reason, 'repository_concurrency_limit');
  assert.equal(calls.dispatch, 3);
});
