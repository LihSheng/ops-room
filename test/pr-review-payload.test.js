import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrReviewPrompt } from '../src/server/pr-review-payload.js';
test('PR review prompt requires a machine-validated JSON review result', () => {
    const prompt = buildPrReviewPrompt({
        agent: 'Professor', task: 'Review', repository: 'LihSheng/LinkUp', pr: 40,
        prTitle: 'Test', prBody: '', prAuthor: 'user', baseRef: 'main', headRef: 'feature', headSha: 'a'.repeat(40), diff: '',
    });
    assert.match(prompt, /Return ONLY valid JSON/);
    assert.match(prompt, /"verdict"/);
    assert.match(prompt, /"findings"/);
    assert.doesNotMatch(prompt, /## Final Verdict/);
});
//# sourceMappingURL=pr-review-payload.test.js.map