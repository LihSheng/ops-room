import assert from 'node:assert/strict';
import test from 'node:test';

import { isPrReviewWebhook } from '../src/routes/webhook-routes.js';

test('LinkUp webhook payload with task_type chat and comment_id is recognized', () => {
  const payload = {
    repository: 'LihSheng/LinkUp',
    pr: 42,
    head_sha: 'abc123'.repeat(7).slice(0, 40),
    agent: 'professor',
    task: 'Review this PR',
    task_type: 'chat',
    comment_id: '987654321',
    mode: 'review',
  };
  assert.equal(isPrReviewWebhook(payload), true);
});

test('LinkUp webhook payload without pr is rejected', () => {
  const payload = {
    repository: 'LihSheng/LinkUp',
    agent: 'professor',
    task: 'Review this PR',
  };
  assert.equal(isPrReviewWebhook(payload), false);
});

test('LinkUp webhook payload with draft PR policy is recognized', () => {
  const payload = {
    repository: 'LihSheng/LinkUp',
    pr: 42,
    head_sha: 'abc123'.repeat(7).slice(0, 40),
    agent: 'professor',
    task: 'Review this draft',
    task_type: 'review',
    policy: { allow_draft: true },
  };
  assert.equal(isPrReviewWebhook(payload), true);
});
