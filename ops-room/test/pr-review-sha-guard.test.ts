import assert from 'node:assert/strict';
import test from 'node:test';

import { isCurrentReviewHead } from '../src/workflows/pr-review.js';

test('review posting is permitted only for the expected current SHA', () => {
  assert.equal(isCurrentReviewHead({ expectedSha: 'a'.repeat(40), currentSha: 'a'.repeat(40) }), true);
  assert.equal(isCurrentReviewHead({ expectedSha: 'a'.repeat(40), currentSha: 'b'.repeat(40) }), false);
  assert.equal(isCurrentReviewHead({ expectedSha: null, currentSha: 'b'.repeat(40) }), true);
});
