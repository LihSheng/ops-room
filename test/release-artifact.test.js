import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAllowedReleasePath, buildReleaseArtifact, REQUIRED_MEMORY_SPACE_MANIFESTS, REQUIRED_SKILL_MANIFESTS, verifyReleaseArtifact, } from '../scripts/deploy/release-artifact.js';
const SHA = 'a'.repeat(40);
const PROFILE_IDS = ['professor', 'berlin', 'tokyo', 'gemini'];
function skillManifest(key) {
    return {
        schemaVersion: 1,
        key,
        version: '1.0.0',
        description: `Safe manifest for ${key}.`,
        supportedRuntimes: ['opencode'],
        requiredCommands: [],
        requiredCredentials: [],
        permissions: ['repository.read'],
    };
}
function memoryManifest(key) {
    return {
        schemaVersion: 1,
        key,
        version: '1.0.0',
        displayName: key,
        description: `Safe memory manifest for ${key}.`,
        kind: 'project',
        publicationPath: `20_Projects/${key}`,
        writePolicy: 'read-only',
        provenance: { requiredFields: [], reviewRequired: false },
    };
}
async function makeSource(root) {
    await mkdir(join(root, 'src', 'server'), { recursive: true });
    await mkdir(join(root, 'dist', 'dashboard'), { recursive: true });
    await writeFile(join(root, 'src', 'server', 'webhook.js'), 'console.log("ok");\n');
    await writeFile(join(root, 'dist', 'dashboard', 'index.html'), '<!doctype html>\n');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', engines: { node: '>=20' } }));
    await writeFile(join(root, '.env'), 'SECRET=must-not-ship\n');
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'task.json'), '{}');
    await mkdir(join(root, '..', 'config', 'agent-profiles'), { recursive: true });
    for (const id of PROFILE_IDS) {
        await writeFile(join(root, '..', 'config', 'agent-profiles', `${id}.json`), JSON.stringify({ id }));
    }
    for (const path of REQUIRED_SKILL_MANIFESTS) {
        const [, , key, version] = path.split('/');
        const dir = join(root, '..', 'config', 'skills', key, version);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(skillManifest(key)));
    }
    for (const path of REQUIRED_MEMORY_SPACE_MANIFESTS) {
        const [, , key, version] = path.split('/');
        const dir = join(root, '..', 'config', 'memory-spaces', key, version);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(memoryManifest(key)));
    }
}
test('release artifact includes only approved manifests and immutable runtime files', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'ops-room-release-test-'));
    const source = join(temp, 'source');
    const output = join(temp, 'output');
    try {
        await makeSource(source);
        const built = await buildReleaseArtifact({ sourceRoot: source, outputDir: output, commitSha: SHA });
        const verified = await verifyReleaseArtifact({ archivePath: built.archivePath, checksumPath: built.checksumPath, expectedSha: SHA });
        assert.equal(verified.manifest.commit_sha, SHA);
        for (const id of PROFILE_IDS)
            assert.ok(verified.entries.includes(`config/agent-profiles/${id}.json`));
        for (const path of REQUIRED_SKILL_MANIFESTS)
            assert.ok(verified.entries.includes(path));
        for (const path of REQUIRED_MEMORY_SPACE_MANIFESTS)
            assert.ok(verified.entries.includes(path));
        assert.equal(verified.entries.filter((entry) => entry.startsWith('config/skills/') && entry.endsWith('/manifest.json')).length, 12);
        assert.equal(verified.entries.filter((entry) => entry.startsWith('config/memory-spaces/') && entry.endsWith('/manifest.json')).length, 12);
        assert.equal(verified.entries.some((entry) => entry.includes('.env')), false);
        assert.equal(verified.entries.some((entry) => entry.includes('/data/')), false);
        assert.equal(verified.entries.some((entry) => entry.includes('node_modules')), false);
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
});
test('release path policy rejects secrets, runtime data, non-manifest registry files, and traversal', () => {
    for (const path of [
        'ops-room/.env',
        'ops-room/data/task.json',
        'ops-room/secrets/key.pem',
        'ops-room/node_modules/pkg/index.js',
        'config/agent-profiles/private-key.pem',
        'config/skills/review/1.0.0/README.md',
        'config/skills/review/latest/manifest.json',
        'config/memory-spaces/shared/1.0.0/README.md',
        'config/memory-spaces/shared/latest/manifest.json',
        '../escape',
    ]) {
        assert.throws(() => assertAllowedReleasePath(path));
    }
    assert.equal(assertAllowedReleasePath('config/skills/review/1.0.0/manifest.json'), 'config/skills/review/1.0.0/manifest.json');
    assert.equal(assertAllowedReleasePath('config/memory-spaces/shared/1.0.0/manifest.json'), 'config/memory-spaces/shared/1.0.0/manifest.json');
});
test('release build rejects unauthorized files under registry roots', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'ops-room-release-extra-'));
    const source = join(temp, 'source');
    try {
        await makeSource(source);
        await writeFile(join(source, '..', 'config', 'skills', 'implementation', '1.0.0', 'README.md'), 'not approved');
        await writeFile(join(source, '..', 'config', 'memory-spaces', 'ops-room-project', '1.0.0', 'README.md'), 'not approved');
        await assert.rejects(() => buildReleaseArtifact({ sourceRoot: source, outputDir: join(temp, 'output'), commitSha: SHA }), /only a regular manifest\.json is allowed/);
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
});
test('release build rejects registry symlinks when supported by the platform', async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'ops-room-release-symlink-'));
    const source = join(temp, 'source');
    try {
        await makeSource(source);
        try {
            await symlink(join(source, '..', 'config', 'skills', 'implementation'), join(source, '..', 'config', 'skills', 'escape'), 'dir');
        }
        catch (error) {
            if (error?.code === 'EPERM' || error?.code === 'EACCES') {
                t.skip('symlink creation is unavailable on this platform');
                return;
            }
            throw error;
        }
        await assert.rejects(() => buildReleaseArtifact({ sourceRoot: source, outputDir: join(temp, 'output'), commitSha: SHA }), /symlink entries are not allowed/);
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
});
test('same commit produces one deterministic artifact and never overwrites it', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'ops-room-release-determinism-'));
    const source = join(temp, 'source');
    const firstOutput = join(temp, 'first');
    const secondOutput = join(temp, 'second');
    try {
        await makeSource(source);
        const first = await buildReleaseArtifact({ sourceRoot: source, outputDir: firstOutput, commitSha: SHA });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const second = await buildReleaseArtifact({ sourceRoot: source, outputDir: secondOutput, commitSha: SHA });
        assert.equal(first.checksum, second.checksum);
        await writeFile(join(source, 'src', 'server', 'webhook.js'), 'console.log("changed");\n');
        const repeated = await buildReleaseArtifact({ sourceRoot: source, outputDir: firstOutput, commitSha: SHA });
        assert.equal(repeated.checksum, first.checksum);
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
});
//# sourceMappingURL=release-artifact.test.js.map