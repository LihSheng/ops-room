import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeRelativePath } from '../src/workflows/fix-runtime.js';
test('fix runtime only permits safe source-relative paths', () => {
    assert.equal(isSafeRelativePath('src/feature.js'), true);
    for (const path of ['../escape', '/etc/passwd', '.git/config', '.env', 'config/secret.txt', 'private-key.pem']) {
        assert.equal(isSafeRelativePath(path), false, path);
    }
});
//# sourceMappingURL=fix-runtime.test.js.map