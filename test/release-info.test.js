import test from 'node:test';
import assert from 'node:assert/strict';
import { readReleaseInfo } from '../src/services/release-info.js';
test('release manifest is authoritative over stable environment SHA', async () => {
    const manifestSha = 'a'.repeat(40);
    const info = await readReleaseInfo({
        manifestPath: 'unused',
        env: { OPS_ROOM_RELEASE_SHA: 'b'.repeat(40) },
        readFileFn: async () => JSON.stringify({
            schema: 'ops-room.release.v1',
            commit_sha: manifestSha,
            package_version: '1.0.0',
        }),
    });
    assert.equal(info.commit_sha, manifestSha);
    assert.equal(info.source, 'manifest');
});
test('invalid existing release manifest never falls back to environment identity', async () => {
    await assert.rejects(readReleaseInfo({
        manifestPath: 'unused',
        env: { OPS_ROOM_RELEASE_SHA: 'b'.repeat(40) },
        readFileFn: async () => JSON.stringify({ schema: 'wrong', commit_sha: 'a'.repeat(40) }),
    }), /Unsupported release manifest schema/);
});
test('source checkout may fall back to environment identity when manifest is absent', async () => {
    const environmentSha = 'c'.repeat(40);
    const info = await readReleaseInfo({
        manifestPath: 'missing',
        env: { GITHUB_SHA: environmentSha },
        readFileFn: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    });
    assert.deepEqual(info, { commit_sha: environmentSha, source: 'environment' });
});
//# sourceMappingURL=release-info.test.js.map