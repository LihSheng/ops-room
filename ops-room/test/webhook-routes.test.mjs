import assert from 'node:assert/strict';
import test from 'node:test';

import { configurePrReviewController, handleWebhook } from '../src/routes/webhook-routes.mjs';

test('PR webhooks use the configured review controller instead of direct workflow execution', async () => {
  const calls = [];
  configurePrReviewController({
    submit: async (request) => {
      calls.push(request);
      return { task_id: 'review:test', status: 'RUNNING', queued: true };
    },
  });

  const result = await handleWebhook({
    repository: 'LihSheng/LinkUp',
    pr: 40,
    head_sha: 'a'.repeat(40),
    agent: 'professor',
    mode: 'auto-fix',
    policy: { allow_auto_fix: true },
    trigger: 'pull_request',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].head_sha, 'a'.repeat(40));
  assert.equal(calls[0].agent, 'professor');
  assert.deepEqual(calls[0].policy, { allow_auto_fix: true });
  assert.equal(result.task_id, 'review:test');
  assert.equal(result.agent, 'professor');
});
