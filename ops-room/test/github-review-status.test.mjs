import assert from 'node:assert/strict';
import test from 'node:test';

import { createGitHubReviewStatusService } from '../src/services/github-review-status.mjs';

test('review status service writes the stable context when status changed', async () => {
  const writes = [];
  const service = createGitHubReviewStatusService({
    getCommitStatuses: async () => [],
    createCommitStatus: async (input) => writes.push(input),
  });

  const result = await service.set({
    repository: 'LihSheng/LinkUp', sha: 'a'.repeat(40), state: 'pending',
    description: 'Review in progress', targetUrl: 'https://ops-room.example/tasks/1', agent: 'professor',
  });

  assert.equal(result.written, true);
  assert.deepEqual(writes, [{
    repository: 'LihSheng/LinkUp', sha: 'a'.repeat(40), state: 'pending',
    description: 'Review in progress', targetUrl: 'https://ops-room.example/tasks/1',
    context: 'OpenAB PR Review', agent: 'professor',
  }]);
});

test('review status service does not repeat an equivalent latest status', async () => {
  let writes = 0;
  const service = createGitHubReviewStatusService({
    getCommitStatuses: async () => [{ context: 'OpenAB PR Review', state: 'success', description: 'Approved' }],
    createCommitStatus: async () => { writes += 1; },
  });

  const result = await service.set({
    repository: 'LihSheng/LinkUp', sha: 'a'.repeat(40), state: 'success', description: 'Approved', agent: 'professor',
  });

  assert.equal(result.written, false);
  assert.equal(writes, 0);
});
