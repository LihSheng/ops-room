import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertAllowedReleasePath,
  buildReleaseArtifact,
  verifyReleaseArtifact,
} from '../scripts/deploy/release-artifact.mjs';

const SHA = 'a'.repeat(40);

async function makeSource(root) {
  await mkdir(join(root, 'src', 'server'), { recursive: true });
  await mkdir(join(root, 'dist', 'dashboard'), { recursive: true });
  await writeFile(join(root, 'src', 'server', 'webhook.mjs'), 'console.log("ok");\n');
  await writeFile(join(root, 'dist', 'dashboard', 'index.html'), '<!doctype html>\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', engines: { node: '>=20' } }));
  await writeFile(join(root, '.env'), 'SECRET=must-not-ship\n');
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'task.json'), '{}');
}

test('release artifact contains only immutable runtime allowlist and external checksum', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ops-room-release-test-'));
  const source = join(temp, 'source');
  const output = join(temp, 'output');
  try {
    await makeSource(source);
    const built = await buildReleaseArtifact({ sourceRoot: source, outputDir: output, commitSha: SHA });
    const verified = await verifyReleaseArtifact({
      archivePath: built.archivePath,
      checksumPath: built.checksumPath,
      expectedSha: SHA,
    });

    assert.equal(verified.manifest.commit_sha, SHA);
    assert.equal(verified.manifest.package_version, '1.0.0');
    assert.ok(verified.entries.includes('ops-room/src/server/webhook.mjs'));
    assert.equal(verified.entries.some((entry) => entry.includes('.env')), false);
    assert.equal(verified.entries.some((entry) => entry.includes('/data/')), false);
    assert.equal(verified.entries.some((entry) => entry.includes('node_modules')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('release path policy rejects secrets, runtime data, dependencies, and traversal', () => {
  for (const path of [
    'ops-room/.env',
    'ops-room/data/task.json',
    'ops-room/secrets/key.pem',
    'ops-room/node_modules/pkg/index.js',
    '../escape',
  ]) {
    assert.throws(() => assertAllowedReleasePath(path));
  }
});
