import test from 'node:test';
import assert from 'node:assert/strict';

import { pollAgentIssues, startIssuePoller } from '../src/lib/issue-poller.mjs';

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

test('issue poller stops claiming remaining issues when drain begins mid-cycle', async () => {
  const abortController = new AbortController();
  const claimed = [];
  const issues = [1, 2].map((number) => ({
    number,
    title: `Issue ${number}`,
    labels: [{ name: 'openab/coder' }],
  }));

  await pollAgentIssues({
    agentKey: 'coder',
    signal: abortController.signal,
    listOpenIssuesForAgent: async () => issues,
    ensureLabel: async () => {},
    removeLabel: async () => {},
    addLabel: async () => {},
    addComment: async () => {},
    cancelTask: async () => {},
    handleTask: async (issueNumber) => {
      claimed.push(issueNumber);
      abortController.abort();
    },
    logger: { log: () => {}, error: () => {} },
  });

  assert.deepEqual(claimed, [1]);
});
