import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertAllowedReleasePath,
  buildReleaseArtifact,
  verifyReleaseArtifact,
} from '../scripts/deploy/release-artifact.js';

const SHA = 'a'.repeat(40);
const PROFILE_IDS = ['professor', 'berlin', 'tokyo', 'gemini'];

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
}

test('release artifact contains only immutable runtime allowlist, profiles, and external checksum', async () => {
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
    assert.ok(verified.entries.includes('ops-room/src/server/webhook.js'));
    for (const id of PROFILE_IDS) assert.ok(verified.entries.includes(`config/agent-profiles/${id}.json`));
    assert.equal(verified.entries.some((entry) => entry.includes('.env')), false);
    assert.equal(verified.entries.some((entry) => entry.includes('/data/')), false);
    assert.equal(verified.entries.some((entry) => entry.includes('node_modules')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('release path policy rejects secrets, runtime data, dependencies, non-JSON profile files, and traversal', () => {
  for (const path of [
    'ops-room/.env',
    'ops-room/data/task.json',
    'ops-room/secrets/key.pem',
    'ops-room/node_modules/pkg/index.js',
    'config/agent-profiles/private-key.pem',
    '../escape',
  ]) {
    assert.throws(() => assertAllowedReleasePath(path));
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
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
