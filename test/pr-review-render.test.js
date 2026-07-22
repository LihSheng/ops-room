import assert from 'node:assert/strict';
import test from 'node:test';
import { renderStructuredReview } from '../src/workflows/pr-review.js';
test('structured review rendering produces GitHub-readable findings', () => {
    const text = renderStructuredReview({
        summary: 'One correctness issue', verdict: 'REQUEST_CHANGES', requires_human: false,
        findings: [{ severity: 'high', file: 'src/a.js', line: 12, title: 'Race', description: 'State races', suggestion: 'Add a lock', auto_fixable: true }],
    });
    assert.match(text, /## Summary/);
    assert.match(text, /src\/a\.js:12/);
    assert.match(text, /REQUEST_CHANGES/);
});
//# sourceMappingURL=pr-review-render.test.js.map