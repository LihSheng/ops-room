import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAutoFixPolicy } from '../src/services/review-policy.js';
test('auto-fix requires explicit enablement and a trusted same-repository branch', () => {
    assert.deepEqual(evaluateAutoFixPolicy({ requestedMode: 'auto-fix', policy: {} }), { allowed: false, reason: 'not_explicitly_enabled' });
    assert.deepEqual(evaluateAutoFixPolicy({ requestedMode: 'auto-fix', policy: { allow_auto_fix: true, trusted_source: false } }), { allowed: false, reason: 'untrusted_source' });
    assert.deepEqual(evaluateAutoFixPolicy({ requestedMode: 'auto-fix', policy: { allow_auto_fix: true, trusted_source: true, same_repository: false } }), { allowed: false, reason: 'fork_or_no_push_permission' });
    assert.deepEqual(evaluateAutoFixPolicy({ requestedMode: 'auto-fix', policy: { allow_auto_fix: true, trusted_source: true, same_repository: true } }), { allowed: true, reason: 'allowed' });
});
test('critical or ambiguous findings are never auto-fixable', () => {
    assert.deepEqual(evaluateAutoFixPolicy({ requestedMode: 'auto-fix', policy: { allow_auto_fix: true, trusted_source: true, same_repository: true }, findings: [{ severity: 'critical' }] }), { allowed: false, reason: 'critical_or_ambiguous_finding' });
    assert.deepEqual(evaluateAutoFixPolicy({ requestedMode: 'auto-fix', policy: { allow_auto_fix: true, trusted_source: true, same_repository: true }, findings: [{ severity: 'medium', auto_fixable: false }] }), { allowed: false, reason: 'critical_or_ambiguous_finding' });
});
//# sourceMappingURL=review-policy.test.js.map