import assert from 'node:assert/strict';
import test from 'node:test';

import { assertReviewNotCancelled, ReviewCancelledError } from '../src/workflows/review-worker-guard.js';

test('review worker stops cooperatively after cancellation is requested', () => {
  assert.doesNotThrow(() => assertReviewNotCancelled({ state: 'RUNNING' }));
  assert.throws(() => assertReviewNotCancelled({ state: 'CANCEL_REQUESTED' }), ReviewCancelledError);
});
