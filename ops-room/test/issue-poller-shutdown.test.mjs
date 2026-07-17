import test from 'node:test';
import assert from 'node:assert/strict';

import { startIssuePoller } from '../src/lib/issue-poller.mjs';

test('issue poller stops promptly when drain aborts its wait', async () => {
  const abortController = new AbortController();
  const messages = [];
  const poller = startIssuePoller({
    agentKeys: [],
    intervalMs: 60_000,
    pollAgent: async () => {},
    signal: abortController.signal,
    logger: { log: (message) => messages.push(message), error: () => {} },
  });

  abortController.abort();
  await poller;
  assert.deepEqual(messages, ['[poller] poll loop started', '[poller] poll loop stopped']);
});
