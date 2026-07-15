import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFixHeadCurrent } from '../src/workflows/fix-worker.mjs';

test('fix worker fences workspace/push on the reviewed SHA', () => {
  assert.doesNotThrow(() => assertFixHeadCurrent({ reviewedSha: 'a'.repeat(40), currentSha: 'a'.repeat(40) }));
  assert.throws(
    () => assertFixHeadCurrent({ reviewedSha: 'a'.repeat(40), currentSha: 'b'.repeat(40) }),
    /superseded/i,
  );
});
