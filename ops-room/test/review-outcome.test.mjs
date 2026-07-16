import assert from 'node:assert/strict';
import test from 'node:test';

import { taskStateForReviewEvent } from '../src/workflows/review-outcome.mjs';

test('review outcome preserves supersession as a terminal task state', () => {
  assert.equal(taskStateForReviewEvent('APPROVE'), 'PASSED');
  assert.equal(taskStateForReviewEvent('REQUEST_CHANGES'), 'CHANGES_REQUESTED');
  assert.equal(taskStateForReviewEvent('SUPERSEDED'), 'SUPERSEDED');
  assert.equal(taskStateForReviewEvent('COMMENT'), 'NEEDS_HUMAN');
});
