import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFixOutcome } from '../src/workflows/fix-outcome.js';
test('non-progress fixer results are terminal and never request re-review', () => {
    assert.deepEqual(classifyFixOutcome({ kind: 'NO_PARSEABLE_OUTPUT' }), { state: 'NEEDS_HUMAN', requeue: false });
    assert.deepEqual(classifyFixOutcome({ kind: 'NO_SOURCE_CHANGES' }), { state: 'NEEDS_HUMAN', requeue: false });
    assert.deepEqual(classifyFixOutcome({ kind: 'PUSH_FAILED' }), { state: 'ERROR', requeue: false });
    assert.deepEqual(classifyFixOutcome({ kind: 'SUPERSEDED' }), { state: 'SUPERSEDED', requeue: false });
});
test('a pushed fix ends its task and waits for a new-SHA event', () => {
    assert.deepEqual(classifyFixOutcome({ kind: 'FIX_PUSHED', newSha: 'b'.repeat(40) }), {
        state: 'FIX_PUSHED', requeue: false, new_sha: 'b'.repeat(40),
    });
});
//# sourceMappingURL=fix-outcome.test.js.map