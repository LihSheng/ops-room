import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStructuredReview } from '../src/workflows/review-result.mjs';

test('structured review accepts a valid approval without blocking findings', () => {
  const result = parseStructuredReview(JSON.stringify({ summary: 'Looks good', verdict: 'APPROVE', requires_human: false, findings: [] }));
  assert.equal(result.verdict, 'APPROVE');
});

test('structured review rejects approval with blocking findings', () => {
  assert.throws(
    () => parseStructuredReview(JSON.stringify({
      summary: 'Contradictory', verdict: 'APPROVE', requires_human: false,
      findings: [{ severity: 'high', file: 'src/a.mjs', line: 1, title: 'Bug', description: 'Bad', auto_fixable: false }],
    })),
    /cannot include blocking findings/,
  );
});

test('structured review rejects malformed request-changes result', () => {
  assert.throws(
    () => parseStructuredReview(JSON.stringify({ summary: 'Missing finding', verdict: 'REQUEST_CHANGES', requires_human: false, findings: [] })),
    /must include findings/,
  );
});
